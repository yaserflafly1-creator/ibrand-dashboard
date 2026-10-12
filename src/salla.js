// محوّل بيانات سلة -> الشكل الذي تفهمه اللوحة.
// الحقول مطابقة لوثائق List Orders وList Order Statuses وProducts List.

// الـ slugs من وثيقة List Order Statuses. الحالات المخصصة من التاجر تحمل slug الحالة الأصلية.
const COMPLETED = ['completed', 'delivered'];
const CANCELED = ['canceled', 'cancelled', 'payment_failed'];
const REFUNDED = ['restored', 'restoring'];
const UNPAID = ['payment_pending']; // لم يُدفع بعد: ليس طلباً فعلياً فيُستبعد من اللوحة
// الباقي (in_progress, under_review, shipped, delivering, waiting_for_payment_confirmation) = قيد التنفيذ

export function mapStatus(slug = '') {
  const s = String(slug).toLowerCase();
  if (COMPLETED.includes(s)) return 'completed';
  if (CANCELED.includes(s)) return 'canceled';
  if (REFUNDED.includes(s)) return 'refunded';
  if (UNPAID.includes(s)) return 'unpaid';
  return 'shipping';
}

// order.date = { date: "2026-08-02 18:08:47.000000", timezone: "Asia/Riyadh" }
export function parseSallaDate(d) {
  const raw = typeof d === 'string' ? d : d?.date;
  if (!raw) return 0;
  const t = Date.parse(raw.slice(0, 19).replace(' ', 'T') + '+03:00');
  return Number.isNaN(t) ? 0 : t;
}

// قائمة الطلبات تُرجع items بالاسم والكمية والصورة فقط، بدون سعر.
// نوزّع إجمالي الطلب على القطع بالتساوي كتقدير لسعر الوحدة (تقريبي للطلبات متعددة المنتجات).
export function normalizeOrder(o) {
  const items = Array.isArray(o.items) ? o.items : [];
  const qty = items.reduce((s, it) => s + (Number(it.quantity) || 0), 0) || 1;
  const total = Number(o.total?.amount) || 0;
  return {
    id: o.reference_id ?? o.id,
    customerId: o.customer?.id ?? null,
    city: o.customer?.city || '',
    paymentMethod: o.payment_method || '',
    source: o.source || '',
    customer: o.customer?.full_name || [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' ') || 'عميل',
    ts: parseSallaDate(o.date),
    status: mapStatus(o.status?.slug),
    draft: !!o.draft,
    total,
    currency: o.total?.currency || 'SAR',
    qty,
    lines: items.map((it) => ({
      name: it.name || 'منتج',
      qty: Number(it.quantity) || 1,
      price: total / qty,
      img: it.thumbnail || ''
    }))
  };
}

// Products List (format=light): name, price.amount, sale_price.amount, thumbnail
export function buildPriceMap(products) {
  const map = new Map();
  for (const p of products || []) {
    if (!p?.name) continue;
    const sale = Number(p.sale_price?.amount) || 0;
    const price = sale > 0 ? sale : Number(p.price?.amount) || 0;
    if (price > 0) map.set(String(p.name).trim().toLowerCase(), { price, img: p.thumbnail || p.image?.url || '' });
  }
  return map;
}

// يستبدل تقدير السعر بسعر المنتج الحالي من الكتالوج عند تطابق الاسم؛ يرجع عدد البنود المطابقة
export function applyCatalog(orders, map) {
  let matched = 0, total = 0;
  for (const o of orders) for (const l of o.lines) {
    total++;
    const hit = map.get(String(l.name).trim().toLowerCase());
    if (hit) { l.price = hit.price; l.img = l.img || hit.img; matched++; }
  }
  return { matched, total };
}
