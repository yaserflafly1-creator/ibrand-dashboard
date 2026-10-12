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
    sallaId: o.id,
    customerId: o.customer?.id ?? null,
    city: o.customer?.city || '',
    paymentMethod: o.payment_method || '',
    source: o.source || '',
    customer: o.customer?.full_name || [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' ') || 'عميل',
    ts: parseSallaDate(o.date),
    day: String(o.date?.date || '').slice(0, 10),   // التاريخ المحلي (الرياض) كما تعيده سلة
    hour: Number(String(o.date?.date || '').slice(11, 13)) || 0,
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

// Product Quantities (GET /products/quantities): صف لكل منتج أو لكل متغيّر (variant)
export function normalizeInventoryItem(p) {
  return {
    id: p.id,
    skuId: p.sku_id ?? null,
    name: p.name || 'منتج',
    variant: p.variant || '',
    sku: p.sku || '',
    img: p.image || '',
    qty: Number(p.quantity) || 0,
    sold: Number(p.sold_quantity) || 0,
    price: Number(p.price) || 0,
    unlimited: !!p.unlimited_quantity
  };
}

// List Coupons (GET /coupons، صلاحية marketing.read). statistics قد تغيب عن بعض الكوبونات فنرجع null بدل 0
export function normalizeCoupon(c) {
  const t = String(c.type || '').toLowerCase();
  const st = c.statistics;
  return {
    id: c.id,
    code: c.code || '',
    type: t === 'p' || t === 'percentage' ? 'percentage' : 'fixed',
    value: Number(c.amount?.amount) || 0,
    currency: c.amount?.currency || 'SAR',
    status: c.status || 'active',
    start: c.start_date || '',
    expiry: c.expiry_date || '',
    usageLimit: Number(c.usage_limit) || 0,
    uses: st ? Number(st.num_of_usage) || 0 : null,
    customers: st ? Number(st.num_of_customers) || 0 : null,
    sales: st ? Number(st.coupon_sales?.amount) || 0 : null,
    freeShipping: !!c.free_shipping,
    groupName: c.is_group ? c.group_name || '' : ''
  };
}

// List Shipments (GET /shipments، صلاحية shipping.read). الاستجابة لا تحمل تاريخاً، فالتصفية بالفترة تتم في الطلب نفسه.
const SHIP_GROUPS = {
  delivered: ['delivered', 'partially_delivered'],
  transit: ['created', 'creating', 'in_progress', 'in_transit', 'received_at_final_hub', 'to_be_reattempted', 'reattempted', 'delivering', 'shipped', 'pending'],
  returned: ['return_to_origin', 'return_in_progress', 'returned', 'returning'],
  failed: ['unable_to_deliver', 'lost', 'damaged', 'cancelled', 'canceled']
};
export function shipmentGroup(status = '') {
  const s = String(status).toLowerCase();
  for (const [g, list] of Object.entries(SHIP_GROUPS)) if (list.includes(s)) return g;
  return 'transit';
}
export function normalizeShipment(s) {
  return {
    id: s.id ?? s.shipping_number ?? '',
    courier: s.courier_name || 'غير محدد',
    status: s.status || '',
    statusLabel: s.translated_status || '',
    group: shipmentGroup(s.status),
    cod: s.payment_method === 'cod',
    city: s.ship_to?.city || '',
    total: Number(s.total?.amount) || 0,
    tracking: s.tracking_number || s.shipping_number || '',
    link: s.tracking_link || s.tracking_url || '',
    international: !!s.is_international
  };
}

// Order Details (GET /orders/{id}?format=light): يحمل campaign و source_details (UTM). قائمة الطلبات لا تحملها.
export function normalizeAttribution(d) {
  const c = d?.campaign || {}, s = d?.source_details || {};
  const clean = (v) => String(v ?? '').trim();
  return {
    src: clean(c.source || s.utm_source).toLowerCase(),
    med: clean(c.medium || s.utm_medium).toLowerCase(),
    camp: clean(c.campaign || s.utm_campaign)
  };
}
