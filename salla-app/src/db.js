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
    db.prepare("CREATE TABLE IF NOT EXISTS catalog (merchant TEXT NOT NULL, name TEXT NOT NULL, price REAL NOT NULL, img TEXT NOT NULL DEFAULT '', cat TEXT NOT NULL DEFAULT '', PRIMARY KEY (merchant, name))"),
    db.prepare('CREATE TABLE IF NOT EXISTS cust_day (merchant TEXT NOT NULL, cid TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY (merchant, cid, day))'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_cust_day ON cust_day (merchant, day)'),
    db.prepare('CREATE TABLE IF NOT EXISTS basket_day (merchant TEXT NOT NULL, day TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (merchant, day))'),
    db.prepare('CREATE TABLE IF NOT EXISTS cust_first (merchant TEXT NOT NULL, cid TEXT NOT NULL, first_day TEXT NOT NULL, PRIMARY KEY (merchant, cid))'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_cust_first ON cust_first (merchant, first_day)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_attr_pending ON order_attr (merchant, att, day)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_attr_day ON order_attr (merchant, day)')
  ]);
  // عمود الخاضع للضريبة أُضيف لاحقاً: ALTER يفشل بهدوء إن كان موجوداً
  try { await db.prepare('ALTER TABLE catalog ADD COLUMN taxable INTEGER NOT NULL DEFAULT 1').run(); } catch (e) { /* موجود */ }
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
function multiStmts(db, head, tail, rows, perRow) {
  const per = Math.max(1, Math.floor(100 / perRow)), stmts = [];
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    stmts.push(db.prepare(`${head} VALUES ${chunk.map(() => '(' + new Array(perRow).fill('?').join(',') + ')').join(',')} ${tail}`).bind(...chunk.flat()));
  }
  return stmts;
}
const multiInsert = (db, head, tail, rows, perRow) => batched(db, multiStmts(db, head, tail, rows, perRow), 50);
async function batched(db, stmts, size = 40) {
  for (let i = 0; i < stmts.length; i += size) { if (dbHook) dbHook(); await db.batch(stmts.slice(i, i + size)); }
}

export const upsertDays = (db, m, days) => batched(db, days.map((d) =>
  db.prepare('INSERT INTO day_agg (merchant, day, data) VALUES (?, ?, ?) ON CONFLICT(merchant, day) DO UPDATE SET data = excluded.data').bind(m, d.day, JSON.stringify(d))));

export async function rangeRows(db, m, from, to) {
  const { results } = await db.prepare('SELECT data FROM day_agg WHERE merchant = ? AND day BETWEEN ? AND ? ORDER BY day').bind(m, from, to).all();
  return results.map((r) => JSON.parse(r.data));
}

// إجماليات شهرية من الملخصات اليومية (SQL فقط: بلا تحليل JSON لكل يوم في الـWorker)
export async function monthlyStats(db, m, from, to) {
  const { results } = await db.prepare(`SELECT substr(day, 1, 7) AS m, COUNT(*) AS days, SUM(json_extract(data, '$.revenue')) AS revenue, SUM(json_extract(data, '$.valid')) AS orders,
      SUM(json_extract(data, '$.units')) AS units, SUM(json_extract(data, '$.canceled')) AS canceled, SUM(json_extract(data, '$.lost.canceled.v')) AS canceledValue
    FROM day_agg WHERE merchant = ? AND day BETWEEN ? AND ? GROUP BY m ORDER BY m`).bind(m, from, to).all();
  return results.map((r) => ({ m: r.m, days: r.days, revenue: r.revenue || 0, orders: r.orders || 0, units: r.units || 0, canceled: r.canceled || 0, canceledValue: r.canceledValue || 0 }));
}

// الأيام المخزّنة فعلاً (حتى الأيام بلا طلبات تُكتب صفاً فارغاً) لاكتشاف الفجوات
export async function loadedDays(db, m, from, to) {
  // اليوم «محمَّل» إن وُجد ملخصه وتحليل سلته معاً (فيُعاد جلب أيام سابقة لإضافة ميزة جديدة تلقائياً)
  const { results } = await db.prepare(`SELECT d.day AS day FROM day_agg d JOIN basket_day b ON b.merchant = d.merchant AND b.day = d.day WHERE d.merchant = ? AND d.day BETWEEN ? AND ? AND json_extract(b.data, '$.v') >= 2`).bind(m, from, to).all();
  return results.map((r) => r.day);
}
export const upsertBaskets = (db, m, rows) => batched(db, rows.map((b) =>
  db.prepare('INSERT INTO basket_day (merchant, day, data) VALUES (?, ?, ?) ON CONFLICT(merchant, day) DO UPDATE SET data = excluded.data').bind(m, b.day, JSON.stringify(b))));
export async function basketRows(db, m, from, to) {
  const { results } = await db.prepare('SELECT data FROM basket_day WHERE merchant = ? AND day BETWEEN ? AND ? ORDER BY day').bind(m, from, to).all();
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
/* العملاء من الطلبات: صف لكل (عميل، يوم شراء) لطلبات مكتملة/قيد التنفيذ؛ الجدد = أول يوم شراء ضمن الفترة */
export const upsertCustDays = (db, m, pairs) => {
  // أول يوم شراء لكل عميل (أصغر يوم) في جدول مستقل كي لا نفحص كل الجدول عند حساب الجدد
  const first = new Map();
  for (const [cid, day] of pairs) { const k = String(cid); if (!first.has(k) || day < first.get(k)) first.set(k, day); }
  return batched(db, [
    ...multiStmts(db, 'INSERT OR IGNORE INTO cust_day (merchant, cid, day)', '', pairs.map(([cid, day]) => [m, String(cid), day]), 3),
    ...multiStmts(db, 'INSERT INTO cust_first (merchant, cid, first_day)', 'ON CONFLICT(merchant, cid) DO UPDATE SET first_day = excluded.first_day WHERE excluded.first_day < cust_first.first_day',
      [...first].map(([cid, day]) => [m, cid, day]), 3)
  ], 50);
};
// بذر جدول الكتالوج من جدول الأسعار القديم مرة واحدة: لئلا تُبنى لقطة ناقصة بينما يُحدَّث الكتالوج بالتصنيفات
export const seedCatalog = (db, m) => db.prepare("INSERT OR IGNORE INTO catalog (merchant, name, price, img, cat) SELECT merchant, name, price, img, '' FROM prices WHERE merchant = ?").bind(m).run();
// حذف ملخصات الأيام الأقدم من يوم معيّن ليُعاد جلبها (يملؤها كشف الفجوات)
export const dropDaysBefore = (db, m, day) => db.prepare('DELETE FROM day_agg WHERE merchant = ? AND day < ?').bind(m, day).run();
// تعبئة cust_first من cust_day مرة واحدة (بيانات سابقة لإضافة الجدول)
export const initCustFirst = (db, m) => db.prepare('INSERT INTO cust_first (merchant, cid, first_day) SELECT merchant, cid, MIN(day) FROM cust_day WHERE merchant = ? GROUP BY cid ON CONFLICT(merchant, cid) DO UPDATE SET first_day = excluded.first_day WHERE excluded.first_day < cust_first.first_day').bind(m).run();
export async function customerStats(db, m, from, to) {
  // كل استعلام يقرأ صفوف الفترة فقط عبر الفهارس (لا فحص كامل للجدول): العدد الكلي يُخزَّن مؤقتاً في الاستدعاء
  const [r, n] = await Promise.all([
    db.prepare('SELECT COUNT(DISTINCT cid) AS c FROM cust_day WHERE merchant = ? AND day BETWEEN ? AND ?').bind(m, from, to).first(),
    db.prepare('SELECT COUNT(*) AS c FROM cust_first WHERE merchant = ? AND first_day BETWEEN ? AND ?').bind(m, from, to).first()
  ]);
  const active = r?.c || 0, fresh = n?.c || 0;
  return { active, fresh, returning: Math.max(0, active - fresh) };
}
export async function customerTotal(db, m) {
  const t = await db.prepare('SELECT COUNT(*) AS c FROM cust_first WHERE merchant = ?').bind(m).first();
  return t?.c || 0;
}

/* كتالوج المنتجات (اسم -> سعر + صورة + تصنيف) من قائمة المنتجات؛ دفعة واحدة لكل صفحة */
export const upsertCatalog = (db, m, map) => multiInsert(db, 'INSERT INTO catalog (merchant, name, price, img, cat, taxable)',
  // لا نكتب إن لم يتغير شيء (تحديث الكتالوج يعيد كل المنتجات؛ حد الكتابة اليومي)
  'ON CONFLICT(merchant, name) DO UPDATE SET price = excluded.price, img = excluded.img, cat = excluded.cat, taxable = excluded.taxable WHERE catalog.price != excluded.price OR catalog.img != excluded.img OR catalog.cat != excluded.cat OR catalog.taxable != excluded.taxable',
  [...map].map(([name, v]) => [m, name, v.price, v.img || '', v.cat || '', v.taxable === false ? 0 : 1]), 6);
export async function readCatalog(db, m) {
  const { results } = await db.prepare('SELECT name, price, img, cat, taxable FROM catalog WHERE merchant = ?').bind(m).all();
  return results;
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
  // استعلام واحد يقرأ صفوف الفترة مرة واحدة ثم نجمّعها هنا (كانت ثلاثة استعلامات تقرأ الصفوف نفسها)
  const { results } = await db.prepare(`SELECT att, src, camp, COUNT(*) AS orders, ROUND(SUM(total), 2) AS total FROM order_attr WHERE merchant = ? AND day BETWEEN ? AND ? AND ${VALID_SQL} GROUP BY att, src, camp`).bind(m, from, to).all();
  const src = {}, camps = [];
  let attributed = 0, total = 0;
  for (const r of results) {
    total += r.orders;
    if (r.att !== 1) continue;
    attributed += r.orders;
    const e = src[r.src] || (src[r.src] = { k: r.src, orders: 0, total: 0 });
    e.orders += r.orders; e.total += r.total;
    if (r.camp) camps.push({ src: r.src, camp: r.camp, orders: r.orders, total: r.total });
  }
  const byTotal = (a, b) => b.total - a.total;
  return { sources: Object.values(src).map((e) => ({ ...e, total: Math.round(e.total * 100) / 100 })).sort(byTotal), campaigns: camps.sort(byTotal).slice(0, 40), attributed, total };
}
