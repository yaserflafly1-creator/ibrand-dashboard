// طبقة قاعدة بيانات Cloudflare D1 (SQLite): ملخصات يومية + حالة المزامنة + المخزون.
const ready = new WeakSet();

export async function ensureSchema(db) {
  if (ready.has(db)) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS day_agg (merchant TEXT NOT NULL, day TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (merchant, day))'),
    db.prepare('CREATE TABLE IF NOT EXISTS meta (merchant TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (merchant, k))'),
    db.prepare('CREATE TABLE IF NOT EXISTS inventory (merchant TEXT NOT NULL, id TEXT NOT NULL, gen INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (merchant, id))')
  ]);
  ready.add(db);
}

export async function getMeta(db, m, k, def) {
  const row = await db.prepare('SELECT v FROM meta WHERE merchant = ? AND k = ?').bind(m, k).first();
  return row ? JSON.parse(row.v) : def;
}
export const setMeta = (db, m, k, v) =>
  db.prepare('INSERT INTO meta (merchant, k, v) VALUES (?, ?, ?) ON CONFLICT(merchant, k) DO UPDATE SET v = excluded.v').bind(m, k, JSON.stringify(v)).run();

async function batched(db, stmts, size = 40) {
  for (let i = 0; i < stmts.length; i += size) await db.batch(stmts.slice(i, i + size));
}

export const upsertDays = (db, m, days) => batched(db, days.map((d) =>
  db.prepare('INSERT INTO day_agg (merchant, day, data) VALUES (?, ?, ?) ON CONFLICT(merchant, day) DO UPDATE SET data = excluded.data').bind(m, d.day, JSON.stringify(d))));

export async function rangeRows(db, m, from, to) {
  const { results } = await db.prepare('SELECT data FROM day_agg WHERE merchant = ? AND day BETWEEN ? AND ? ORDER BY day').bind(m, from, to).all();
  return results.map((r) => JSON.parse(r.data));
}

export async function coverage(db, m) {
  const r = await db.prepare('SELECT MIN(day) AS oldest, MAX(day) AS newest FROM day_agg WHERE merchant = ?').bind(m).first();
  return { oldest: r?.oldest || null, newest: r?.newest || null };
}

/* المخزون: يُحدَّث على دفعات، كل دورة كاملة لها رقم (gen) ويُحذف ما لم يظهر فيها */
export const upsertInventory = (db, m, gen, items) => batched(db, items.map((it) =>
  db.prepare('INSERT INTO inventory (merchant, id, gen, data) VALUES (?, ?, ?, ?) ON CONFLICT(merchant, id) DO UPDATE SET gen = excluded.gen, data = excluded.data')
    .bind(m, `${it.id}:${it.skuId || 0}`, gen, JSON.stringify(it))));
export const dropOldInventory = (db, m, gen) => db.prepare('DELETE FROM inventory WHERE merchant = ? AND gen < ?').bind(m, gen).run();
export async function readInventory(db, m) {
  const { results } = await db.prepare('SELECT data FROM inventory WHERE merchant = ?').bind(m).all();
  return results.map((r) => JSON.parse(r.data));
}
