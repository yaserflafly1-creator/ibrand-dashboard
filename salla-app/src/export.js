// تقارير CSV لربط جوجل شيت (IMPORTDATA): إجماليات فقط، بلا أسماء عملاء ولا تفاصيل طلبات.
import { sumDays, categoryStats } from './agg.js';

// أول خلية تبدأ بـ = + - @ تُعامل صيغة في الشيت: نسبقها بفاصلة علوية
const cell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+@]/.test(s) || /^-(?![\d.]+$)/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export const toCsv = (rows) => rows.map((r) => r.map(cell).join(',')).join('\n') + '\n';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (n) => r2(n);

export function periodRange(period, today, from, to) {
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (DATE.test(from || '') && DATE.test(to || '')) return from <= to ? { from, to } : { from: to, to: from };
  const add = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const mAgo = /^month([1-9])$/.exec(period || '');   // month1 = الشهر الماضي، month2 = قبله، …
  if (mAgo) {
    const [y, m] = today.slice(0, 7).split('-').map(Number), d = new Date(Date.UTC(y, m - 1 - Number(mAgo[1]), 1));
    const start = d.toISOString().slice(0, 10), end = add(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10), -1);
    return { from: start, to: end };
  }
  switch (period) {
    case 'today': return { from: today, to: today };
    case 'yesterday': return { from: add(today, -1), to: add(today, -1) };
    case 'lastmonth': { const end = add(today.slice(0, 8) + '01', -1); return { from: end.slice(0, 8) + '01', to: end }; }
    case 'year': return { from: today.slice(0, 4) + '-01-01', to: today };
    case '7d': return { from: add(today, -6), to: today };
    case '90d': return { from: add(today, -89), to: today };
    case '365d': return { from: add(today, -364), to: today };
    case '30d': return { from: add(today, -29), to: today };
    default: return { from: today.slice(0, 8) + '01', to: today };   // month (الافتراضي)
  }
}

export const REPORTS = ['daily', 'products', 'categories', 'cancelled', 'summary'];

export function buildReport(report, rows, { catMap, vatMap } = {}) {
  if (report === 'daily') {
    return [['اليوم', 'الطلبات', 'المبيعات', 'متوسط الطلب', 'الملغية (عدد)', 'الملغية (قيمة)'],
      ...rows.map((d) => [d.day, d.valid, r2(d.revenue), d.valid ? r2(d.revenue / d.valid) : 0, d.canceled || 0, r2(d.lost?.canceled?.v)])];
  }
  const a = sumDays(rows, true, vatMap);
  if (report === 'products') {
    return [['المنتج', 'الكمية', 'المبيعات', 'الحصة %'], ...a.products.map((p) => [p.name, p.qty, r2(p.total), pct(p.share)])];
  }
  if (report === 'categories') {
    const c = categoryStats(rows, catMap || new Map(), vatMap || new Map());
    return [['التصنيف', 'المبيعات (شامل الضريبة)', 'الحصة %', 'الكمية', 'متوسط سعر القطعة'],
      ...c.list.map((x) => [x.name || 'غير مصنّف', r2(x.total), pct(x.share), x.qty, r2(x.avg)])];
  }
  if (report === 'cancelled') {
    const l = a.lostDetail.canceled;
    return [['النوع', 'البند', 'العدد', 'القيمة'],
      ['ملخص', 'إجمالي الملغية', l.count, r2(l.value)],
      ['ملخص', 'نسبة الإلغاء %', pct(l.rate), ''],
      ['ملخص', 'متوسط قيمة الطلب الملغي', '', r2(l.avg)],
      ...l.pay.map((x) => ['طريقة الدفع', x.k, x.orders, r2(x.total)]),
      ...l.city.map((x) => ['المدينة', x.k, x.orders, r2(x.total)]),
      ...l.products.map((p) => ['المنتج', p.name, p.qty, r2(p.total)])];
  }
  // summary
  return [['المؤشر', 'القيمة'], ['المبيعات', r2(a.revenue)], ['الطلبات', a.valid], ['متوسط الطلب', a.aov], ['القطع المباعة', a.sold],
    ['الطلبات الملغية', a.counts.canceled], ['قيمة الملغية', r2(a.lostValue)]];
}
