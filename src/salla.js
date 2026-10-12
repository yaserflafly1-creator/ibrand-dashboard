// محوّل بيانات سلة -> الشكل الذي تفهمه اللوحة.
// ⚠️ أسماء الحقول أدناه مبنية على معرفتنا بـ Salla Admin API v2 وتحتاج مطابقتها مع الوثائق
//    (Orders > List / Order Details). كل افتراض موسوم بـ [VERIFY].

const COMPLETED = ['completed', 'delivered'];
const CANCELED = ['canceled', 'cancelled'];
const REFUNDED = ['restored', 'restoring', 'refunded'];

// [VERIFY] slug الحالة في order.status.slug
export function mapStatus(slug = '') {
  const s = String(slug).toLowerCase();
  if (COMPLETED.includes(s)) return 'completed';
  if (CANCELED.includes(s)) return 'canceled';
  if (REFUNDED.includes(s)) return 'refunded';
  return 'shipping'; // أي حالة أخرى = قيد التنفيذ
}

// [VERIFY] order.date.date بصيغة "YYYY-MM-DD HH:mm:ss.SSSSSS" بتوقيت الرياض
export function parseSallaDate(d) {
  const raw = typeof d === 'string' ? d : d?.date;
  if (!raw) return 0;
  const t = Date.parse(raw.slice(0, 19).replace(' ', 'T') + '+03:00');
  return Number.isNaN(t) ? 0 : t;
}

const money = (a) => Number(a?.amount ?? a ?? 0) || 0;

// [VERIFY] order.amounts.total.amount, order.customer.first_name/last_name
export function normalizeOrder(o) {
  const name = [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' ');
  return {
    id: o.reference_id || o.id,
    sallaId: o.id,
    customer: name || 'عميل',
    ts: parseSallaDate(o.date),
    status: mapStatus(o.status?.slug),
    total: money(o.amounts?.total),
    currency: o.currency || o.amounts?.total?.currency || 'SAR',
    qty: Number(o.total_quantity ?? o.items_count ?? 1) || 1,
    lines: []
  };
}

// [VERIFY] order.items[] : name, quantity, amounts.price_without_tax / total, thumbnail
export function normalizeItems(detail) {
  return (detail?.items || []).map((it) => ({
    name: it.name || 'منتج',
    qty: Number(it.quantity) || 1,
    price: money(it.amounts?.price_without_tax ?? it.amounts?.total) / (Number(it.quantity) || 1),
    img: it.thumbnail || it.product_thumbnail || ''
  }));
}
