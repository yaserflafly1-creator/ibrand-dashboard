// طبقة قاعدة بيانات Cloudflare D1 (SQLite): ملخصات يومية + حالة المزامنة + المخزون.
const ready = new WeakSet();

export async function ensureSchema(db) {
  if (ready.has(db)) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS day_agg (merchant TEXT NOT NULL, day TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (merchant, day))'),
    db.prepare('CREATE TABLE IF NOT EXISTS meta (merchant TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (merchant, k))'),
    db.prepare('CREATE TABLE IF NOT EXISTS inventory (merchant TEXT NOT NULL, id TEXT NOT NULL, gen INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (merchant, id))'),
    // طلب واحد لكل صف: يُملأ من قائمة الطلبات، ثم تُكمَّل بيانات الحملة (att=1) من تفاصيل الطلب
    db.prepare("CREATE TABLE IF NOT EXISTS order_attr (merchant TEXT NOT NULL, id TEXT NOT NULL, day TEXT NOT NULL, status TEXT NOT NULL, total REAL NOT NULL, att INTEGER NOT NULL DEFAULT 0, src TEXT NOT NULL DEFAULT '', med TEXT NOT NULL DEFAULT '', camp TEXT NOT NULL DEFAULT '', PRIMARY KEY (merchant, id))"),
    db.prepare('CREATE TABLE IF NOT EXISTS prices (merchant TEXT NOT NULL, name TEXT NOT NULL, price REAL NOT NULL, img TEXT NOT NULL DEFAULT \'\', PRIMARY KEY (merchant, name))'),
    db.prepare('CREATE TABLE IF NOT EXISTS cust_day (merchant TEXT NOT NULL, cid TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY (merchant, cid, day))'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_cust_day ON cust_day (merchant, day)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_attr_pending ON order_attr (merchant, att, day)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_attr_day ON order_attr (merchant, day)')
  ]);
  ready.add(db);
}

export async function getMeta(db, m, k, def) {
  const row = await db.prepare('SELECT v FROM meta WHERE merchant = ? AND k = ?').bind(m, k).first();
  return row ? JSON.parse(row.v) : def;
}
export const setMeta = (db, m, k, v) =>
  db.prepare('INSERT INTO meta (merchant, k, v) VALUES (?, ?, ?) ON CONFLICT(merchant, k) DO UPDATE SET v = excluded.v').bind(m, k, JSON.stringify(v)).run();

// كل db.batch يُحسب نداءً فرعياً ضمن حد Cloudflare (50 في الخطة المجانية): تعدّه المزامنة ضمن ميزانيتها
let dbHook = null;
export const setDbHook = (fn) => { dbHook = fn; };
// إدخال متعدد الصفوف: عبارة واحدة لكل ≤100 معامل (حد D1)، وكل 50 عبارة في db.batch واحد => نداء فرعي واحد لآلاف الصفوف
function multiInsert(db, head, tail, rows, perRow) {
  const per = Math.max(1, Math.floor(100 / perRow)), stmts = [];
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    stmts.push(db.prepare(`${head} VALUES ${chunk.map(() => '(' + new Array(perRow).fill('?').join(',') + ')').join(',')} ${tail}`).bind(...chunk.flat()));
  }
  return batched(db, stmts, 50);
}
async function batched(db, stmts, size = 40) {
  for (let i = 0; i < stmts.length; i += size) { if (dbHook) dbHook(); await db.batch(stmts.slice(i, i + size)); }
}

export const upsertDays = (db, m, days) => batched(db, days.map((d) =>
  db.prepare('INSERT INTO day_agg (merchant, day, data) VALUES (?, ?, ?) ON CONFLICT(merchant, day) DO UPDATE SET data = excluded.data').bind(m, d.day, JSON.stringify(d))));

export async function rangeRows(db, m, from, to) {
  const { results } = await db.prepare('SELECT data FROM day_agg WHERE merchant = ? AND day BETWEEN ? AND ? ORDER BY day').bind(m, from, to).all();
  return results.map((r) => JSON.parse(r.data));
}

// الأيام المخزّنة فعلاً (حتى الأيام بلا طلبات تُكتب صفاً فارغاً) لاكتشاف الفجوات
export async function loadedDays(db, m, from, to) {
  const { results } = await db.prepare('SELECT day FROM day_agg WHERE merchant = ? AND day BETWEEN ? AND ?').bind(m, from, to).all();
  return results.map((r) => r.day);
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
/* العملاء من الطلبات: صف لكل (عميل، يوم شراء) لطلبات مكتملة/قيد التنفيذ؛ الجدد = أول يوم شراء ضمن الفترة */
export const upsertCustDays = (db, m, pairs) => multiInsert(db, 'INSERT OR IGNORE INTO cust_day (merchant, cid, day)', '',
  pairs.map(([cid, day]) => [m, String(cid), day]), 3);
export async function customerStats(db, m, from, to) {
  const [t, r, n] = await Promise.all([
    db.prepare('SELECT COUNT(DISTINCT cid) AS c FROM cust_day WHERE merchant = ?').bind(m).first(),
    db.prepare('SELECT COUNT(DISTINCT cid) AS c FROM cust_day WHERE merchant = ? AND day BETWEEN ? AND ?').bind(m, from, to).first(),
    db.prepare('SELECT COUNT(*) AS c FROM (SELECT cid, MIN(day) AS d FROM cust_day WHERE merchant = ? GROUP BY cid) WHERE d BETWEEN ? AND ?').bind(m, from, to).first()
  ]);
  const total = t?.c || 0, active = r?.c || 0, fresh = n?.c || 0;
  return { total, active, fresh, returning: Math.max(0, active - fresh) };
}

/* كتالوج الأسعار (اسم المنتج -> سعر الوحدة الحالي) من قائمة المنتجات */
export const upsertPrices = (db, m, map) => batched(db, [...map].map(([name, v]) =>
  db.prepare('INSERT INTO prices (merchant, name, price, img) VALUES (?, ?, ?, ?) ON CONFLICT(merchant, name) DO UPDATE SET price = excluded.price, img = excluded.img')
    .bind(m, name, v.price, v.img || '')));
export async function readPrices(db, m) {
  const { results } = await db.prepare('SELECT name, price, img FROM prices WHERE merchant = ?').bind(m).all();
  return results;
}
export async function readInventory(db, m) {
  const { results } = await db.prepare('SELECT data FROM inventory WHERE merchant = ?').bind(m).all();
  return results.map((r) => JSON.parse(r.data));
}

/* الحملات: صفوف الطلبات + بيانات الإسناد */
// يكتب فقط عند تغيّر الحالة/القيمة/اليوم (لتوفير عمليات الكتابة)
export const upsertOrderRows = (db, m, rows) => multiInsert(db,
  'INSERT INTO order_attr (merchant, id, day, status, total)',
  `ON CONFLICT(merchant, id) DO UPDATE SET day = excluded.day, status = excluded.status, total = excluded.total
    WHERE order_attr.status != excluded.status OR order_attr.total != excluded.total OR order_attr.day != excluded.day`,
  rows.map((r) => [m, String(r.id), r.day, r.status, r.total]), 5);

export async function pendingAttr(db, m, sinceDay, limit) {
  const { results } = await db.prepare('SELECT id FROM order_attr WHERE merchant = ? AND att = 0 AND day >= ? ORDER BY day DESC LIMIT ?').bind(m, sinceDay, limit).all();
  return results.map((r) => r.id);
}
export const setAttr = (db, m, items) => batched(db, items.map((it) =>
  db.prepare('UPDATE order_attr SET att = 1, src = ?, med = ?, camp = ? WHERE merchant = ? AND id = ?').bind(it.src, it.med, it.camp, m, String(it.id))));

const VALID_SQL = "status IN ('completed', 'shipping')";
export async function campaignStats(db, m, from, to) {
  const base = [m, from, to];
  const [sources, campaigns, cov] = await Promise.all([
    db.prepare(`SELECT src AS k, COUNT(*) AS orders, ROUND(SUM(total), 2) AS total FROM order_attr WHERE merchant = ? AND day BETWEEN ? AND ? AND att = 1 AND ${VALID_SQL} GROUP BY src ORDER BY total DESC`).bind(...base).all(),
    db.prepare(`SELECT src, camp, COUNT(*) AS orders, ROUND(SUM(total), 2) AS total FROM order_attr WHERE merchant = ? AND day BETWEEN ? AND ? AND att = 1 AND camp != '' AND ${VALID_SQL} GROUP BY src, camp ORDER BY total DESC LIMIT 40`).bind(...base).all(),
    db.prepare(`SELECT COALESCE(SUM(att), 0) AS attributed, COUNT(*) AS total FROM order_attr WHERE merchant = ? AND day BETWEEN ? AND ? AND ${VALID_SQL}`).bind(...base).first()
  ]);
  return { sources: sources.results, campaigns: campaigns.results, attributed: cov?.attributed || 0, total: cov?.total || 0 };
}
