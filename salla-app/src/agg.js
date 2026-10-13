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
export function categoryStats(rows, catMap) {
  const cats = {};
  const prods = {};
  for (const d of rows) for (const k in d.prod) { const e = prods[k] || (prods[k] = [0, 0]); e[0] += d.prod[k][0]; e[1] += d.prod[k][1]; }
  let total = 0, units = 0;
  for (const [name, [qty, val]] of Object.entries(prods)) {
    const cat = (catMap && catMap.get(String(name).trim().toLowerCase())) || '';
    const c = cats[cat] || (cats[cat] = { name: cat, qty: 0, total: 0, products: 0 });
    c.qty += qty; c.total += val; c.products++; total += val; units += qty;
  }
  const list = Object.values(cats).map((c) => ({ ...c, total: r2(c.total), avg: c.qty ? r2(c.total / c.qty) : 0,
    share: total ? (c.total / total) * 100 : 0, unitShare: units ? (c.qty / units) * 100 : 0 })).sort((x, y) => y.total - x.total);
  return { list, total: r2(total), units };
}

export function sumDays(rows, detail = true) {
  const a = { orders: 0, valid: 0, revenue: 0, productSales: 0, sold: 0, lostValue: 0, counts: { completed: 0, shipping: 0, canceled: 0, refunded: 0 } };
  const pay = {}, city = {}, src = {}, prod = {};
  const hours = new Array(24).fill(0), dow = new Array(7).fill(0);
  const lostAcc = { canceled: { v: 0, pay: {}, city: {}, prod: {} }, refunded: { v: 0, pay: {}, city: {}, prod: {} } };
  for (const d of rows) {
    a.orders += d.orders; a.valid += d.valid; a.revenue += d.revenue; a.sold += d.units; a.lostValue += d.lostValue;
    for (const k of Object.keys(a.counts)) a.counts[k] += d[k] || 0;
    for (const k in d.prod) a.productSales += d.prod[k][1];   // قيمة المنتجات فقط (كمية × سعر الكتالوج) بلا شحن ولا ضريبة
    if (!detail) continue;
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
  a.revenue = r2(a.revenue); a.lostValue = r2(a.lostValue); a.productSales = r2(a.productSales);
  a.lost = a.counts.canceled + a.counts.refunded;
  a.aov = a.valid ? r2(a.revenue / a.valid) : 0;
  if (!detail) return a;
  const all = Object.entries(prod).map(([name, [qty, total, img]]) => ({ name, qty, total: r2(total), img }));
  const sumTotal = all.reduce((s, p) => s + p.total, 0) || 1;
  all.sort((x, y) => y.qty - x.qty);
  a.productsCount = all.length;
  a.products = all.slice(0, MAX_PRODUCTS).map((p) => ({ ...p, share: (p.total / sumTotal) * 100 }));
  a.top = a.products.slice(0, 5);
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
