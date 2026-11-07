// اقتراح روابط المنافسين تلقائياً لمنتج: بحث في موقع المنافس (Shopify/Magento) أو مطابقة روابط خريطة الموقع (sitemap)، ثم جلب الصفحات المرشحة وتقييم تطابقها مع اسم منتجنا.
import { checkCompetitorUrl } from './comp.js';

const AR = { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ى': 'ي', 'ة': 'ه', 'ؤ': 'و', 'ئ': 'ي' };
export const normText = (s) => String(s || '').toLowerCase().replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[ً-ٰٟـ]/g, '').replace(/[أإآىةؤئ]/g, (c) => AR[c]).replace(/[^\p{L}\p{N}.]+/gu, ' ').replace(/\.(?!\d)|(?<!\d)\./g, ' ').trim();
const STOP = new Set(['من', 'في', 'مع', 'عبوه', 'عدد', 'حجم', 'مقاس', 'رقم', 'عرض', 'جديد', 'the', 'of', 'and', 'for', 'size']);
const UNIT = { جرام: 'جم', جرامات: 'جم', غرام: 'جم', غ: 'جم', gm: 'جم', g: 'جم', gram: 'جم', مللتر: 'مل', ملل: 'مل', ml: 'مل', حفاضات: 'حفاضه', حفاض: 'حفاضه', حبه: 'حبه', حبات: 'حبه', قطعه: 'حبه', قطع: 'حبه' };
export const tokens = (s) => normText(s).split(/\s+/).map((t) => UNIT[t] || t).filter((t) => t && !STOP.has(t));
const isNum = (t) => /^\d+(\.\d+)?$/.test(t);

// 0..1: نسبة كلمات منتجنا الموجودة في عنوان/رابط المرشّح، مع عقوبة إن اختلفت الأرقام (المقاس/العدد/الحجم)
export function matchScore(ours, theirs) {
  const a = tokens(ours), b = new Set(tokens(theirs));
  if (!a.length) return 0;
  const words = a.filter((t) => !isNum(t)), nums = a.filter(isNum);
  const wHit = words.length ? words.filter((t) => b.has(t)).length / words.length : 1;
  const nHit = nums.length ? nums.filter((t) => b.has(t)).length / nums.length : 1;
  return Math.round(wHit * (0.4 + 0.6 * nHit) * 100) / 100;
}

const UA = 'Mozilla/5.0 (compatible; iBrandPriceCheck/1.0)';
const getText = async (u, f) => { try { const r = await f(u, { headers: { 'user-agent': UA, 'accept-language': 'ar' }, redirect: 'follow', signal: AbortSignal.timeout(15000) }); return r.ok ? (await r.text()).slice(0, 3_000_000) : ''; } catch (e) { return ''; } };
const uniq = (a) => [...new Set(a)];
const locs = (x) => [...String(x).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));

/* مصادر المرشّحين لكل منافس: كل دالة ترجع روابط صفحات منتجات */
const SEARCH = {
  'صيدلية كوم': async (name, f) => uniq([...(await getText('https://sidalih.com/search?q=' + encodeURIComponent(tokens(name).slice(0, 7).join(' ')) + '&type=product', f)).matchAll(/href="(\/products\/[^"?#]+)/g)].map((m) => 'https://sidalih.com' + m[1])).slice(0, 6)
};
// مواقع خريطة الموقع: نخزّن قائمة روابط المنتجات العربية في KV يوماً كاملاً ونطابق الكلمات مع الرابط (الرابط يحمل اسم المنتج)
const SITEMAPS = { 'فارما براند': 'https://pharmabrand.sa/sitemap.xml', 'دار الأميرات': 'https://daralamirat.com.sa/sitemap.xml' };
export async function sitemapUrls(kv, site, f) {
  const key = 'sm:' + site;
  const hit = kv && await kv.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* نعيد البناء */ } }
  const children = locs(await getText(SITEMAPS[site], f)).filter((u) => /\/ar\//.test(u) && /\.xml/.test(u)).slice(0, 6);
  const out = [];
  for (const c of children) for (const u of locs(await getText(c, f))) if (/\/ar\/.+\/p\d+$/.test(u)) out.push(u);
  if (kv && out.length) await kv.put(key, JSON.stringify(out), { expirationTtl: 86400 });
  return out;
}
const bySitemap = (site) => async (name, f, kv) => {
  const t = tokens(name);
  return (await sitemapUrls(kv, site, f)).map((u) => ({ u, s: matchScore(name, decodeURIComponent(u).replace(/[-_/]+/g, ' ')) })).filter((x) => x.s >= 0.34).sort((a, b) => b.s - a.s).slice(0, 5).map((x) => x.u);
};
export const SUGGEST_SITES = [...Object.keys(SEARCH), ...Object.keys(SITEMAPS)];

// يقترح لكل موقع أفضل صفحتين بعد جلبها وتقييم عنوانها الحقيقي
export async function suggestFor(name, { fetchFn = fetch, kv = null, sites = SUGGEST_SITES } = {}) {
  const perSite = await Promise.all(sites.map(async (site) => {
    let urls = [];
    try { urls = SEARCH[site] ? await SEARCH[site](name, fetchFn) : SITEMAPS[site] ? await bySitemap(site)(name, fetchFn, kv) : []; } catch (e) { return []; }
    const checked = await Promise.all(urls.slice(0, 4).map(async (u) => ({ u, r: await checkCompetitorUrl(u, fetchFn) })));
    return checked.filter((x) => x.r.ok).map((x) => {
      const score = Math.max(matchScore(name, x.r.title), matchScore(name, decodeURIComponent(x.u).replace(/[-_/]+/g, ' ')) * 0.9);
      return { competitor: site, url: x.u, title: x.r.title, price: x.r.price, avail: x.r.avail, score };
    }).sort((a, b) => b.score - a.score).slice(0, 2);
  }));
  return perSite.flat().sort((a, b) => b.score - a.score);
}
