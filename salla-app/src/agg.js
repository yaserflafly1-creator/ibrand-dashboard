// تجميع الطلبات إلى ملخصات يومية، وجمع الملخصات اليومية لأي فترة.
// الملخص اليومي صغير (بدل تخزين كل طلب)، فتُقرأ سنة كاملة من قاعدة البيانات بسرعة.

export const VALID = (s) => s === 'completed' || s === 'shipping';

export function emptyDay(day) {
  return {
    day, orders: 0, valid: 0, revenue: 0, units: 0,
    completed: 0, shipping: 0, canceled: 0, refunded: 0, lostValue: 0,
    pay: {}, city: {}, src: {}, hours: new Array(24).fill(0), prod: {},
    // تفصيل الطلبات الملغية والمسترجعة: v القيمة، وبقية الحقول كما في المبيعات
    lost: { canceled: emptyLost(), refunded: emptyLost() }
  };
}
const emptyLost = () => ({ v: 0, prod: {}, pay: {}, city: {} });

const bump = (map, key, total) => { const e = map[key] || (map[key] = [0, 0]); e[0]++; e[1] += total; };

export function addOrder(d, o) {
  d.orders++;
  d[o.status] = (d[o.status] || 0) + 1;
  if (!VALID(o.status)) {
    d.lostValue += o.total;
    const l = (d.lost || (d.lost = { canceled: emptyLost(), refunded: emptyLost() }))[o.status];
    if (l) {
      l.v += o.total;
      bump(l.pay, o.paymentMethod || 'unknown', o.total);
      bump(l.city, o.city || 'unknown', o.total);
      for (const ln of o.lines || []) {
        const p = l.prod[ln.name] || (l.prod[ln.name] = [0, 0, '']);
        p[0] += ln.qty; p[1] += ln.qty * ln.price;
        if (!p[2] && ln.img) p[2] = ln.img;
      }
    }
    return;
  }
  d.valid++; d.revenue += o.total; d.units += o.qty;
  bump(d.pay, o.paymentMethod || 'unknown', o.total);
  bump(d.city, o.city || 'unknown', o.total);
  bump(d.src, o.source || 'unknown', o.total);
  d.hours[o.hour] = (d.hours[o.hour] || 0) + 1;
  for (const l of o.lines || []) {
    const p = d.prod[l.name] || (d.prod[l.name] = [0, 0, '']);
    p[0] += l.qty; p[1] += l.qty * l.price;
    if (!p[2] && l.img) p[2] = l.img;
  }
}

const r2 = (n) => Math.round(n * 100) / 100;
export function roundDay(d) {
  d.revenue = r2(d.revenue); d.lostValue = r2(d.lostValue);
  for (const m of [d.pay, d.city, d.src]) for (const k in m) m[k][1] = r2(m[k][1]);
  for (const k in d.prod) d.prod[k][1] = r2(d.prod[k][1]);
  for (const kind of ['canceled', 'refunded']) {
    const l = d.lost && d.lost[kind]; if (!l) continue;
    l.v = r2(l.v);
    for (const m of [l.pay, l.city]) for (const k in m) m[k][1] = r2(m[k][1]);
    for (const k in l.prod) l.prod[k][1] = r2(l.prod[k][1]);
  }
  return d;
}

const toList = (map) => Object.entries(map).map(([k, [orders, total]]) => ({ k, orders, total: r2(total) })).sort((a, b) => b.total - a.total);
const MAX_PRODUCTS = 200;

// rows: ملخصات يومية. detail=false يعيد الأرقام الرئيسية فقط (للفترة السابقة).
// المبيعات حسب التصنيف من الأيام المخزّنة: كل منتج في d.prod يُنسب لتصنيفه عبر catMap (اسم بحروف صغيرة -> تصنيف)
// تطبيع اسم المنتج (trim + حروف صغيرة) مع ذاكرة: كان يُكرَّر لكل منتج في كل يوم فيستهلك المعالج
const normCache = new Map();
const norm = (n) => { let v = normCache.get(n); if (v === undefined) { v = String(n).trim().toLowerCase(); if (normCache.size > 30000) normCache.clear(); normCache.set(n, v); } return v; };

export function categoryStats(rows, catMap, vatMap) {
  const cats = {};
  const prods = {};
  for (const d of rows) for (const k in d.prod) { const e = prods[k] || (prods[k] = [0, 0]); e[0] += d.prod[k][0]; e[1] += d.prod[k][1]; }
  let total = 0, units = 0;
  for (const [name, [qty, val0]] of Object.entries(prods)) {
    const key = norm(name);
    const cat = (catMap && catMap.get(key)) || '';
    const val = val0 * ((vatMap && vatMap.get(key)) || 1);     // شامل الضريبة للمنتجات الخاضعة لها
    const c = cats[cat] || (cats[cat] = { name: cat, qty: 0, total: 0, products: 0 });
    c.qty += qty; c.total += val; c.products++; total += val; units += qty;
  }
  const list = Object.values(cats).map((c) => ({ ...c, total: r2(c.total), avg: c.qty ? r2(c.total / c.qty) : 0,
    share: total ? (c.total / total) * 100 : 0, unitShare: units ? (c.qty / units) * 100 : 0 })).sort((x, y) => y.total - x.total);
  return { list, total: r2(total), units };
}

export function sumDays(rows, detail = true, vatMap = null) {
  const a = { orders: 0, valid: 0, revenue: 0, productSales: 0, sold: 0, lostValue: 0, counts: { completed: 0, shipping: 0, canceled: 0, refunded: 0 } };
  const pay = {}, city = {}, src = {}, prod = {}, ptot = {};
  const hours = new Array(24).fill(0), dow = new Array(7).fill(0);
  const lostAcc = { canceled: { v: 0, pay: {}, city: {}, prod: {} }, refunded: { v: 0, pay: {}, city: {}, prod: {} } };
  for (const d of rows) {
    a.orders += d.orders; a.valid += d.valid; a.revenue += d.revenue; a.sold += d.units; a.lostValue += d.lostValue;
    for (const k of Object.keys(a.counts)) a.counts[k] += d[k] || 0;
    if (!detail) { for (const k in d.prod) ptot[k] = (ptot[k] || 0) + d.prod[k][1]; continue; }
    for (const kind of ['canceled', 'refunded']) {   // صفوف قديمة بلا lost تُحسب أصفاراً
      const l = d.lost && d.lost[kind]; if (!l) continue;
      const acc = lostAcc[kind]; acc.v += l.v;
      for (const [s0, t0] of [[l.pay, acc.pay], [l.city, acc.city]]) for (const k in s0) { const e = t0[k] || (t0[k] = [0, 0]); e[0] += s0[k][0]; e[1] += s0[k][1]; }
      for (const k in l.prod) { const e = acc.prod[k] || (acc.prod[k] = [0, 0, '']); e[0] += l.prod[k][0]; e[1] += l.prod[k][1]; if (!e[2]) e[2] = l.prod[k][2]; }
    }
    for (const [src0, dst] of [[d.pay, pay], [d.city, city], [d.src, src]]) {
      for (const k in src0) { const e = dst[k] || (dst[k] = [0, 0]); e[0] += src0[k][0]; e[1] += src0[k][1]; }
    }
    d.hours.forEach((n, h) => { hours[h] += n; });
    dow[new Date(d.day + 'T00:00:00Z').getUTCDay()] += d.valid;
    for (const k in d.prod) { const e = prod[k] || (prod[k] = [0, 0, '']); e[0] += d.prod[k][0]; e[1] += d.prod[k][1]; if (!e[2]) e[2] = d.prod[k][2]; }
  }
  // قيمة المنتجات (كمية × سعر الكتالوج) بلا شحن، شاملة الضريبة للمنتجات الخاضعة لها؛ عامل الضريبة مرة لكل منتج لا لكل يوم
  const src2 = detail ? prod : null;
  let ps = 0;
  if (src2) for (const k in src2) ps += src2[k][1] * ((vatMap && vatMap.get(norm(k))) || 1);
  else for (const k in ptot) ps += ptot[k] * ((vatMap && vatMap.get(norm(k))) || 1);
  a.productSales = ps;
  a.revenue = r2(a.revenue); a.lostValue = r2(a.lostValue); a.productSales = r2(a.productSales);
  a.lost = a.counts.canceled + a.counts.refunded;
  a.aov = a.valid ? r2(a.revenue / a.valid) : 0;
  if (!detail) return a;
  const all = Object.entries(prod).map(([name, [qty, total, img]]) => ({ name, qty, total: r2(total), img }));
  const sumTotal = all.reduce((s, p) => s + p.total, 0) || 1;
  all.sort((x, y) => y.qty - x.qty);
  a.productsCount = all.length;
  a.products = all.slice(0, MAX_PRODUCTS).map((p) => ({ ...p, share: (p.total / sumTotal) * 100 }));
  a.top = a.products.slice(0, 20);
  Object.assign(a, { pay: toList(pay), city: toList(city), src: toList(src), hours, dow });
  a.lostDetail = {};
  for (const kind of ['canceled', 'refunded']) {
    const acc = lostAcc[kind], count = a.counts[kind];
    const prods = Object.entries(acc.prod).map(([name, [qty, total, img]]) => ({ name, qty, total: r2(total), img })).sort((x, y) => y.qty - x.qty);
    a.lostDetail[kind] = {
      count, value: r2(acc.v), rate: a.orders ? (count / a.orders) * 100 : 0, avg: count ? r2(acc.v / count) : 0,
      productsCount: prods.length, products: prods.slice(0, 20), pay: toList(acc.pay), city: toList(acc.city)
    };
  }
  return a;
}

// [اليوم، الطلبات، المبيعات، عدد الملغية، قيمة الملغية، عدد المسترجعة، قيمة المسترجعة]
export const seriesOf = (rows) => rows.map((d) => [d.day, d.orders, d.revenue, d.canceled || 0, d.lost?.canceled?.v || 0, d.refunded || 0, d.lost?.refunded?.v || 0]);


/* ============ تحليل سلة المشتريات (Basket) ============
   يُجمَّع لكل يوم من طلبات مكتملة/قيد التنفيذ فقط: توزيع حجم السلة بالقطع (1..5 و6+) وبعدد المنتجات المختلفة (1..3 و4+)،
   والأزواج المشتراة معاً (أعلى 40 زوجاً يومياً). يُخزَّن في جدول مستقل كي لا يثقل ملخص اليوم. */
const bump2 = (m, k, v) => { const e = m[k] || (m[k] = [0, 0]); e[0]++; e[1] += v; };
export const emptyBasket = (day) => ({ v: 2, day, n: 0, units: 0, value: 0, lineSum: 0, u: {}, l: {}, pairs: {}, cp: {} });
export function addBasket(b, o, catOf = null) {
  const lines = (o.lines || []).filter((l) => l.qty > 0);
  if (!lines.length) return;
  const units = lines.reduce((s, l) => s + l.qty, 0);
  const names = [...new Set(lines.map((l) => String(l.name).trim()))];
  b.n++; b.units += units; b.value += o.total; b.lineSum += names.length;
  bump2(b.u, String(Math.min(units, 6)), o.total);
  bump2(b.l, String(Math.min(names.length, 4)), o.total);
  if (names.length >= 2) {
    const top = names.slice(0, 6).sort();
    for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) { const k = top[i] + '\u001f' + top[j]; b.pairs[k] = (b.pairs[k] || 0) + 1; }
  }
  // أزواج التصنيفات (أقل تبعثراً بكثير من أزواج المنتجات في متجر بآلاف المنتجات)
  if (catOf) {
    const cats = [...new Set(names.map((n) => catOf(n)).filter(Boolean))].sort().slice(0, 6);
    for (let i = 0; i < cats.length; i++) for (let j = i + 1; j < cats.length; j++) { const k = cats[i] + '\u001f' + cats[j]; b.cp[k] = (b.cp[k] || 0) + 1; }
  }
}
export function roundBasket(b, keep = 40) {
  const fix = (m) => { for (const k in m) m[k][1] = r2(m[k][1]); };
  fix(b.u); fix(b.l); b.value = r2(b.value);
  const top = Object.entries(b.pairs).sort((x, y) => y[1] - x[1]).slice(0, keep);
  b.pairs = Object.fromEntries(top);
  b.cp = Object.fromEntries(Object.entries(b.cp || {}).sort((x, y) => y[1] - x[1]).slice(0, keep));
  return b;
}
export function sumBaskets(rows, topPairs = 10) {
  const a = { orders: 0, units: 0, value: 0, lineSum: 0 }, u = {}, l = {}, pairs = {}, cp = {};
  for (const d of rows) {
    a.orders += d.n; a.units += d.units; a.value += d.value; a.lineSum += d.lineSum;
    for (const [src, dst] of [[d.u, u], [d.l, l]]) for (const k in src) { const e = dst[k] || (dst[k] = [0, 0]); e[0] += src[k][0]; e[1] += src[k][1]; }
    for (const k in d.pairs) pairs[k] = (pairs[k] || 0) + d.pairs[k];
    for (const k in d.cp) cp[k] = (cp[k] || 0) + d.cp[k];
  }
  const n = a.orders || 1;
  const hist = (m, keys, label) => keys.map((k) => ({ k, label: label(k), orders: (m[k] || [0, 0])[0], share: ((m[k] || [0, 0])[0] / n) * 100, avgValue: (m[k] || [0, 0])[0] ? r2(m[k][1] / m[k][0]) : 0 }));
  const top = Object.entries(pairs).sort((x, y) => y[1] - x[1]).slice(0, topPairs)
    .map(([k, c]) => { const [p1, p2] = k.split('\u001f'); return { a: p1, b: p2, orders: c, support: (c / n) * 100 }; });
  return {
    orders: a.orders, units: a.units, avgUnits: a.orders ? a.units / a.orders : 0, avgLines: a.orders ? a.lineSum / a.orders : 0,
    avgValue: a.orders ? r2(a.value / a.orders) : 0,
    units_hist: hist(u, ['1', '2', '3', '4', '5', '6'], (k) => (k === '6' ? '6 قطع فأكثر' : k + (k === '1' ? ' قطعة' : ' قطع'))),
    lines_hist: hist(l, ['1', '2', '3', '4'], (k) => (k === '4' ? '4 منتجات فأكثر' : k + (k === '1' ? ' منتج' : ' منتجات'))),
    singleShare: ((u['1'] || [0])[0] / n) * 100,
    multiShare: ((l['2'] || [0])[0] + (l['3'] || [0])[0] + (l['4'] || [0])[0]) / n * 100,
    pairs: top,
    cpairs: Object.entries(cp).sort((x, y) => y[1] - x[1]).slice(0, topPairs).map(([k, c]) => { const [p1, p2] = k.split('\u001f'); return { a: p1, b: p2, orders: c, support: (c / n) * 100 }; })
  };
}
