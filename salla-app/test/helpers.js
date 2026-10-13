import { DatabaseSync } from 'node:sqlite';

// يحاكي واجهة D1 فوق sqlite المدمج في Node للاختبارات
export function makeD1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    first: async () => { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; },
    _run: () => db.prepare(sql).run(...args)
  });
  return { prepare: (sql) => stmt(sql), batch: async (stmts) => { for (const s of stmts) s._run(); return []; } };
}

export const makeKV = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { m, put: async (k, v) => m.set(k, v), get: async (k) => m.get(k) ?? null, delete: async (k) => m.delete(k),
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }) };
};

const DAY = 864e5;
const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);

// عميل سلة وهمي: يولّد perDay طلباً لكل يوم داخل [from_date..to_date]، 30 في الصفحة
export function fakeSalla({ perDay = 4, inclusive = true, firstDay = '2000-01-01', calls = [] } = {}) {
  return async (path, params = {}) => {
    calls.push([path, params]);
    const one = /^\/orders\/(\d+)$/.exec(path);
    if (one) {   // تفاصيل الطلب: الحملة تعتمد على رقم الطلب (زوجي: إنستغرام/C1، فردي: مباشر)
      const id = Number(one[1]);
      return { data: { id, campaign: id % 2 === 0 ? { source: 'Instagram', medium: 'paid', campaign: '1202' } : { source: '', medium: '', campaign: '' } } };
    }
    if (path === '/orders') {
      const orders = [];
      let from = params.from_date, to = params.to_date;
      if (!inclusive) { from = addDays(from, 1); to = addDays(to, -1); }   // دلالة حصرية لاختبار المتانة
      for (let d = from; d <= to; d = addDays(d, 1)) {
        if (d < firstDay) continue;
        for (let i = 0; i < perDay; i++) orders.push({ id: Number(d.replace(/-/g, '')) * 100 + i, reference_id: 1000 + i, total: { amount: 100, currency: 'SAR' },
          date: { date: `${d} 10:15:00.000000` }, status: { slug: i === 0 ? 'canceled' : 'completed' }, payment_method: 'mada',
          items: [{ name: 'Dress', quantity: 1, thumbnail: null }], customer: { id: i, full_name: 'عميل', city: 'جدة' }, source: 'store' });
      }
      const page = Number(params.page || 1), per = Number(params.per_page || 30);
      return { data: orders.slice((page - 1) * per, page * per), pagination: { totalPages: Math.max(1, Math.ceil(orders.length / per)), currentPage: page } };
    }
    if (path === '/products/quantities') {
      const page = Number(params.page || 1);
      return { data: [{ id: page, name: page === 1 ? 'Dress' : 'Shoe', quantity: 5, sold_quantity: 9, price: '40.00', unlimited_quantity: false, variant: null, sku: null, image: null }], pagination: { totalPages: 2 } };
    }
    if (path === '/products') {
      const page = Number(params.page || 1);
      return { data: [{ id: page, name: page === 1 ? 'Dress' : 'Shoe', price: { amount: page === 1 ? 80 : 60 }, sale_price: { amount: page === 1 ? 70 : 0 }, thumbnail: 't.png' }], pagination: { totalPages: 2 } };
    }
    throw new Error('unexpected ' + path);
  };
}
