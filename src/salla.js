// محوّل بيانات سلة -> الشكل الذي تفهمه اللوحة.
// الحقول مطابقة لوثيقة List Orders (GET /orders). ما زال موسوماً [VERIFY] ما لم تؤكده الوثائق بعد.

const COMPLETED = ['completed', 'delivered'];
const CANCELED = ['canceled', 'cancelled'];
const REFUNDED = ['restored', 'restoring', 'refunded'];

// [VERIFY] قائمة slugs الحالات الكاملة (صفحة List Order Statuses). المعروف من الأمثلة: in_progress, under_review
export function mapStatus(slug = '') {
  const s = String(slug).toLowerCase();
  if (COMPLETED.includes(s)) return 'completed';
  if (CANCELED.includes(s)) return 'canceled';
  if (REFUNDED.includes(s)) return 'refunded';
  return 'shipping'; // أي حالة أخرى = قيد التنفيذ
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
