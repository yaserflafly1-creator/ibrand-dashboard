// اقتراح روابط المنافسين تلقائياً لمنتج: مطابقة بالباركود أولاً (sku/gtin/mpn في صفحة المنافس)، ثم بالاسم مع تسامح في الاختلافات البسيطة
// (وحدات، حفاضة/حفاضات، تهجئة بحرف واحد). مصادر المرشّحين: بحث الموقع (Shopify/Zid) أو روابط خريطة الموقع (sitemap) المخزّنة في KV.
import { checkCompetitorUrl } from './comp.js';

const AR = { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ى': 'ي', 'ة': 'ه', 'ؤ': 'و', 'ئ': 'ي' };
export const normText = (s) => String(s || '').toLowerCase().replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[ً-ٰٟـ]/g, '').replace(/[أإآىةؤئ]/g, (c) => AR[c]).replace(/[^\p{L}\p{N}.]+/gu, ' ').replace(/\.(?!\d)|(?<!\d)\./g, ' ').trim();
const STOP = new Set(['من', 'في', 'مع', 'عبوه', 'عدد', 'حجم', 'مقاس', 'رقم', 'عرض', 'جديد', 'the', 'of', 'and', 'for', 'size', 'html']);
const UNIT = { جرام: 'جم', جرامات: 'جم', غرام: 'جم', غ: 'جم', gm: 'جم', g: 'جم', gram: 'جم', مللتر: 'مل', ملل: 'مل', ml: 'مل', حفاضات: 'حفاضه', حفاض: 'حفاضه', حبه: 'حبه', حبات: 'حبه', قطعه: 'حبه', قطع: 'حبه', pieces: 'حبه', piece: 'حبه', pcs: 'حبه', diapers: 'حفاضه', diaper: 'حفاضه' };
export const tokens = (s) => normText(s).split(/\s+/).map((t) => UNIT[t] || t).filter((t) => t && !STOP.has(t));
const isNum = (t) => /^\d+(\.\d+)?$/.test(t);

// فرق حرف واحد (استبدال/حذف/إضافة) بين كلمتين طويلتين: «بنادول» ≈ «بانادول»
const near = (a, b) => {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0; while (i < a.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.slice(i) === l.slice(i + 1);
};
// 0..1: نسبة كلمات منتجنا الموجودة عند المرشّح، مع عقوبة إن اختلفت الأرقام (المقاس/العدد/الحجم)
export function matchScore(ours, theirs) {
  const a = tokens(ours), bl = tokens(theirs), b = new Set(bl);
  if (!a.length) return 0;
  const hit = (t) => b.has(t) || (!isNum(t) && bl.some((x) => near(t, x)));
  const words = a.filter((t) => !isNum(t)), nums = a.filter(isNum);
  const wHit = words.length ? words.filter(hit).length / words.length : 1;
  const nHit = nums.length ? nums.filter((t) => b.has(t)).length / nums.length : 1;
  return Math.round(wHit * (0.4 + 0.6 * nHit) * 100) / 100;
}

const UA = 'Mozilla/5.0 (compatible; iBrandPriceCheck/1.0)';
const getText = async (u, f) => { try { const r = await f(u, { headers: { 'user-agent': UA, 'accept-language': 'ar' }, redirect: 'follow', signal: AbortSignal.timeout(20000) }); return r.ok ? (await r.text()).slice(0, 6_000_000) : ''; } catch (e) { return ''; } };
const uniq = (a) => [...new Set(a)];
const locs = (x) => [...String(x).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
const dec = (u) => { try { return decodeURIComponent(u); } catch (e) { return u; } };
const slugText = (u) => dec(u).replace(/^https?:\/\/[^/]+/, '').replace(/\/(pdp|p)?\d+$/, '').replace(/\.html$/, '').replace(/[-_/]+/g, ' ');

/* مواقع البحث: نبحث بالباركود ثم بالاسم */
const shopifySearch = (host) => async (name, info, f) => {
  const out = [];
  for (const q of [info.barcode, tokens(name).slice(0, 7).join(' ')].filter(Boolean)) {
    const h = await getText(`https://${host}/search?q=${encodeURIComponent(q)}&type=product`, f);
    out.push(...[...h.matchAll(/href="(\/products\/[^"?#]+)/g)].map((m) => `https://${host}${m[1]}`).slice(0, 6));
  }
  return uniq(out);
};
const zidProductsSearch = (host) => async (name, info, f) => {
  const out = [];
  for (const q of [info.barcode, tokens(name).slice(0, 5).join(' ')].filter(Boolean)) {
    const h = await getText(`https://${host}/products?search=${encodeURIComponent(q)}`, f);
    out.push(...[...h.matchAll(/href="(\/products\/[^"?#]+)/g)].map((m) => `https://${host}${m[1]}`).slice(0, 8));
  }
  return uniq(out);
};
/* مواقع خريطة الموقع: root = فهرس الخرائط، child = فلتر الخرائط الفرعية، url = شكل رابط المنتج */
const MAPS = {
  'فارما براند': { root: 'https://pharmabrand.sa/sitemap.xml', child: /\/ar\//, url: /\/ar\/.+\/p\d+$/ },
  'دار الأميرات': { root: 'https://daralamirat.com.sa/sitemap.xml', child: /\/ar\//, url: /\/ar\/.+\/p\d+$/ },
  'النهدي': { root: 'https://www.nahdionline.com/sitemap_index_ar.xml', child: /./, url: /\/pdp\/\d+$/, max: 9 },
  'ماي براند': { root: 'https://mybrand.com.sa/sitemap.xml', child: /sitemap-\d+\.xml$/, url: /\/p\d+$/ },
  'صيدلية المتحدة': { root: 'https://unitedpharmacy.sa/sitemap_en.xml', direct: true, url: /\/en\/[^/]+\.html$/, toAr: true }
};
const SEARCH = { 'صيدلية كوم': shopifySearch('sidalih.com'), 'اوت ليت العناية': zidProductsSearch('care-outlet.com') };
export const SUGGEST_SITES = [...Object.keys(SEARCH), ...Object.keys(MAPS)];

export async function sitemapUrls(kv, site, f) {
  const cfg = MAPS[site], key = 'sm:' + site;
  const hit = kv && await kv.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* نعيد البناء */ } }
  const root = locs(await getText(cfg.root, f));
  const files = cfg.direct ? [cfg.root] : root.filter((u) => /\.xml/.test(u) && cfg.child.test(u)).slice(0, cfg.max || 6);
  const out = [];
  for (const c of files) for (const u of (cfg.direct ? root : locs(await getText(c, f)))) if (cfg.url.test(u)) out.push(u);
  if (kv && out.length) await kv.put(key, JSON.stringify(out), { expirationTtl: 7 * 86400 });   // قائمة روابط فقط (أسبوع)
  return out;
}
const byMap = (site) => async (name, info, f, kv) => {
  const slug = info.slug ? info.slug.replace(/-/g, ' ') : '';
  return (await sitemapUrls(kv, site, f)).map((u) => { const t = slugText(u); return { u, s: Math.max(matchScore(name, t), slug ? matchScore(slug, t) : 0) }; })
    .filter((x) => x.s >= 0.34).sort((a, b) => b.s - a.s).slice(0, 6).map((x) => x.u);
};

// info = { barcode, slug }: الباركود (sku في سلة) والرابط الإنجليزي للمنتج في متجرنا (لمواقع روابطها إنجليزية)
export async function suggestFor(name, { info = {}, fetchFn = fetch, kv = null, sites = SUGGEST_SITES } = {}) {
  const barcode = String(info.barcode || '').replace(/\D/g, '');
  const perSite = await Promise.all(sites.map(async (site) => {
    let urls = [];
    try { urls = SEARCH[site] ? await SEARCH[site](name, { ...info, barcode }, fetchFn) : MAPS[site] ? await byMap(site)(name, info, fetchFn, kv) : []; } catch (e) { return []; }
    // رتّب المرشّحين بتشابه الرابط مع اسمنا (أو رابطنا الإنجليزي) ثم اجلب أفضل 4
    const slug = info.slug ? info.slug.replace(/-/g, ' ') : '';
    urls = urls.map((u) => ({ u, s: Math.max(matchScore(name, slugText(u)), slug ? matchScore(slug, slugText(u)) : 0) })).sort((a, b) => b.s - a.s).slice(0, 4).map((x) => x.u);
    const checked = await Promise.all(urls.map(async (u) => { const fu = MAPS[site]?.toAr ? u.replace('/en/', '/ar/') : u; let r = await checkCompetitorUrl(fu, fetchFn); if (!r.ok && fu !== u) r = await checkCompetitorUrl(u, fetchFn); return { u: fu, r }; }));
    return checked.filter((x) => x.r.ok).map((x) => {
      const codes = x.r.codes || [], codeHit = barcode && codes.includes(barcode);
      let score = Math.max(matchScore(name, x.r.title), matchScore(name, slugText(x.u)) * 0.9);
      if (!codeHit && barcode && codes.some((c) => /^\d{12,14}$/.test(c))) score = Math.round(score * 50) / 100;   // لديهم باركود مختلف: غالباً حجم/نوع مختلف
      return { competitor: site, url: x.u, title: x.r.title, price: x.r.price, avail: x.r.avail, score: codeHit ? 1 : score, matchby: codeHit ? 'barcode' : 'name', code: codeHit ? barcode : (codes.find((c) => /^\d{12,14}$/.test(c)) || '') };
    }).sort((a, b) => b.score - a.score).slice(0, 2);
  }));
  return perSite.flat().sort((a, b) => b.score - a.score);
}
