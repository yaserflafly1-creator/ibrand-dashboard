// اقتراح روابط المنافسين تلقائياً لمنتج: مطابقة بالباركود أولاً (sku/gtin/mpn في صفحة المنافس)، ثم بالاسم مع تسامح في الاختلافات البسيطة
// (وحدات، حفاضة/حفاضات، تهجئة بحرف واحد). مصادر المرشّحين: بحث الموقع (Shopify/Zid) أو روابط خريطة الموقع (sitemap) المخزّنة في KV.
import { checkCompetitorUrl } from './comp.js';
import { SEED_BRANDS, CAT_EN } from './brands.js';

const AR = { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ى': 'ي', 'ة': 'ه', 'ؤ': 'و', 'ئ': 'ي' };
export const normText = (s) => String(s || '').toLowerCase().replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[ً-ٰٟـ]/g, '').replace(/[أإآىةؤئ]/g, (c) => AR[c]).replace(/[^\p{L}\p{N}.]+/gu, ' ').replace(/\.(?!\d)|(?<!\d)\./g, ' ').replace(/(\d)(\p{L})/gu, '$1 $2').replace(/(\p{L})(\d)/gu, '$1 $2').replace(/\s+/g, ' ').trim();   // 750ml → 750 ml
const STOP = new Set(['من', 'في', 'مع', 'عبوه', 'عدد', 'حجم', 'مقاس', 'رقم', 'عرض', 'جديد', 'the', 'of', 'and', 'for', 'size', 'html']);
const UNIT = { جرام: 'جم', جرامات: 'جم', غرام: 'جم', غ: 'جم', gm: 'جم', g: 'جم', gram: 'جم', مللتر: 'مل', ملل: 'مل', ml: 'مل', حفاضات: 'حفاضه', حفاض: 'حفاضه', حبه: 'حبه', حبات: 'حبه', قطعه: 'حبه', قطع: 'حبه', pieces: 'حبه', piece: 'حبه', pcs: 'حبه', diapers: 'حفاضه', diaper: 'حفاضه' };
const stripPre = (t) => (t.length > 6 && /^(وال|بال|كال|فال)/.test(t) ? t.slice(3) : t.length > 5 && t.startsWith('لل') ? t.slice(2) : t.length > 4 && t.startsWith('ال') ? t.slice(2) : t);   // للاطفال/بالفانيليا/الرضع
export const tokens = (s) => normText(s).split(/\s+/).map((t) => UNIT[t] || stripPre(t)).filter((t) => t && !STOP.has(t));
// كلمات عامة (فئة/وحدة/تعبئة) وزنها قليل: العلامة والنوع هما ما يحسم المطابقة
const GEN = new Set(['حليب', 'اطفال', 'طفل', 'رضع', 'رضيع', 'حفاضه', 'كريم', 'شامبو', 'غسول', 'سائل', 'جل', 'مرطب', 'بلسم', 'عبوه', 'علبه', 'صندوق', 'جامبو', 'بوكس', 'جم', 'مل', 'حبه', 'كجم', 'لتر', 'للبشره', 'للشعر', 'ml', 'gm', 'spf', 'كيلو', 'شهر', 'اشهر', 'عمر', 'للرضع', 'للاطفال', 'للصغار', 'رقم', 'حديث', 'جديد', 'كبير', 'جدا', 'صغير', 'متوسط', 'مضغوطه', 'مضغوط', 'ماسيه', 'حتى', 'الى', 'اصلي', 'الاصلي']);
// كلمات تحدد نسخة المنتج (اكسترا/بلس/ماكس/جولد/فورت…): غيابها عند المرشّح يعني غالباً منتجاً آخر من نفس الخط
const VARIANT = new Set(['اكسترا', 'extra', 'بلس', 'plus', 'ماكس', 'max', 'برو', 'pro', 'جولد', 'gold', 'فورت', 'forte', 'ادفانس', 'advance', 'سوبر', 'super', 'اولترا', 'ultra', 'حساس', 'ليت', 'light', 'زيرو', 'zero', 'بريميوم', 'premium', 'ميجا', 'mega']);
// حزمة/عرض (عرض، عبوتين، ×3): سعرها لعدة وحدات فلا تُقارن بسعر الوحدة
const isBundle = (s) => /(^|\s)(عرض|عبوتين|باكج|حزمة|حزمه|offer|bundle)(\s|$)|[×x*]\s*[2-9](?!\d)|(?<!\d)[2-9]\s*[×x*](?!\d)/i.test(String(s));
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
// 0..1: وزن كلماتنا الموجودة عند المرشّح. الكلمات العامة وزنها 0.3؛ وغياب كلمات العلامة/الاسم الأولى (أول كلمتين مميّزتين) يضرب الدرجة؛
// والأرقام (المرحلة/المقاس/الحجم/العدد) إن لم تتطابق تهبط بها بقوة (800 جم ≠ 400 جم، مقاس 5 ≠ مقاس 3)
export function matchScore(ours, theirs) {
  const a = tokens(ours), bl = tokens(theirs), b = new Set(bl);
  if (!a.length) return 0;
  const hit = (t) => b.has(t) || (!isNum(t) && bl.some((x) => near(t, x)));
  const words = a.filter((t) => !isNum(t)), nums = a.filter(isNum);
  // أوزان: العلامة (أول كلمة مميّزة) 3، الكلمة المميّزة الثانية 1.5، بقية الكلمات المميّزة 0.7، العامة 0.2
  const dist = words.filter((t) => !GEN.has(t)), brand = dist[0], second = dist[1];
  const w = (t) => (GEN.has(t) ? 0.2 : t === brand ? 3 : t === second ? 1.5 : 0.7);
  const total = words.reduce((x, t) => x + w(t), 0);
  let wHit = total ? words.filter(hit).reduce((x, t) => x + w(t), 0) / total : 1;
  if (brand && !hit(brand)) wHit *= 0.35;
  if (words.some((t) => VARIANT.has(t) && !hit(t))) wHit *= 0.6;
  const nHit = nums.length ? nums.filter((t) => b.has(t)).length / nums.length : 1;
  let score = wHit * (0.15 + 0.85 * nHit * nHit);
  const mine = new Set(a), extra = bl.filter((t) => !isNum(t) && !GEN.has(t) && t.length >= 3 && !mine.has(t) && !words.some((x) => near(x, t)));
  score -= Math.min(0.3, 0.1 * new Set(extra).size);                                   // كلمات مميّزة عندهم ليست عندنا (نسخة/نوع مختلف)
  if (isBundle(theirs) && !isBundle(ours)) score *= 0.5;
  return Math.max(0, Math.round(score * 100) / 100);
}

const UA = 'Mozilla/5.0 (compatible; iBrandPriceCheck/1.0)';
const getText = async (u, f, ms = 20000, max = 6_000_000) => { try { const r = await f(u, { headers: { 'user-agent': UA, 'accept-language': 'ar' }, redirect: 'follow', signal: AbortSignal.timeout(ms) }); return r.ok ? (await r.text()).slice(0, max) : ''; } catch (e) { return ''; } };
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

// ملفات خرائط المواقع قد تكون ضخمة (النهدي: 7 ملفات بحجم 23MB لكل منها، 64 ألف منتج): نحلّلها واحداً بعد الآخر ونخزّن المسارات فقط
const SM_MAX = 60_000_000;
export async function sitemapUrls(kv, site, f) {
  const cfg = MAPS[site], key = 'sm:' + site;
  const hit = kv && await kv.get(key);
  if (hit) { try { const j = JSON.parse(hit); return Array.isArray(j) ? j : j.u.map((p) => j.o + p); } catch (e) { /* نعيد البناء */ } }
  const root = locs(await getText(cfg.root, f, 60000, SM_MAX));
  const files = cfg.direct ? [cfg.root] : root.filter((u) => /\.xml/.test(u) && cfg.child.test(u)).slice(0, cfg.max || 6);
  const out = []; let failed = 0;
  for (const c of files) {
    let list = cfg.direct ? root : locs(await getText(c, f, 60000, SM_MAX));
    if (!list.length && !cfg.direct) { list = locs(await getText(c, f, 60000, SM_MAX)); if (!list.length) failed++; }   // إعادة محاولة واحدة لكل ملف
    for (const u of list) if (cfg.url.test(u)) out.push(u);
  }
  if (kv && out.length && !failed) {   // لا نخزّن خريطة ناقصة (ملف تعثّر تحميله) كي لا تبقى أسبوعاً
    const o = out[0].match(/^https?:\/\/[^/]+/)[0];
    await kv.put(key, JSON.stringify({ o, u: out.map((u) => (u.startsWith(o) ? u.slice(o.length) : u)) }), { expirationTtl: 7 * 86400 });   // مسارات فقط (أسبوع)
  }
  return out;
}
const memMaps = new WeakMap();   // قوائم الخرائط المحلّلة داخل الـ isolate لكل KV (تجنّب إعادة تحليل ملف كبير كل مرة)
const mapUrls = async (kv, site, f) => {
  const m = kv ? (memMaps.get(kv) || memMaps.set(kv, new Map()).get(kv)) : null, h = m && m.get(site);
  if (h && h.exp > Date.now()) return h.urls;
  const urls = await sitemapUrls(kv, site, f); if (m) m.set(site, { urls, exp: Date.now() + 600e3 }); return urls;
};
const byMap = (site) => async (name, info, f, kv) => {
  const slug = info.slug ? info.slug.replace(/-/g, ' ') : '';
  const need = uniq([...tokens(name), ...tokens(slug)].filter((t) => !isNum(t) && t.length >= 3 && !GEN.has(t)));   // مرشّح سريع قبل التقييم (خريطة النهدي 64 ألف رابط)
  const all = await mapUrls(kv, site, f);
  const pool = need.length ? all.filter((u) => { const d = dec(u).toLowerCase(); return need.some((t) => d.includes(t)); }) : [];
  return pool.map((u) => { const t = slugText(u); return { u, s: Math.max(matchScore(name, t), slug ? matchScore(slug, t) : 0) }; })
    .filter((x) => x.s >= 0.34).sort((a, b) => b.s - a.s).slice(0, 6).map((x) => x.u);
};
const ENGLISH_SITES = ['النهدي', 'ماي براند', 'صيدلية المتحدة'];   // روابطها إنجليزية: نحتاج رابطاً/اسماً إنجليزياً لمنتجنا لنجد صفحتها
const latinSlug = (u) => { const t = slugText(u); return /[a-z]{4,}/i.test(t) && !/[ء-ي]/.test(t) ? t.trim().toLowerCase().replace(/\s+/g, '-') : ''; };
const keyTokens = (name) => tokens(name).filter((t) => !isNum(t) && !GEN.has(t));

/* قاموس العلامات التجارية عربي→إنجليزي: يُتعلَّم من صفحات المنافسين التي تكتب العلامة بلغتين («ابتاميل| APTAMIL»، «شيا مويستشر - Shea Moisture») ويُخزَّن في KV */
export function learnBrand(dict, brand) {
  const parts = String(brand || '').split(/[|\-–/،,]+/).map((x) => x.trim()).filter(Boolean);
  const ar = parts.find((x) => /[ء-ي]/.test(x) && !/[a-z]/i.test(x)), en = parts.find((x) => /[a-z]{3,}/i.test(x) && !/[ء-ي]/.test(x));
  if (!ar || !en) return false;
  const k = tokens(ar).join(' ');
  if (!k || dict[k]) return false;
  dict[k] = en.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim(); return !!dict[k];
}
export function brandSlugFor(dict, name) {
  const mine = new Set(keyTokens(name)); let best = '';
  for (const k of Object.keys(dict)) { const kt = k.split(' '); if (kt.every((t) => mine.has(t)) && k.length > best.length) best = k; }
  if (!best) return '';
  const words = uniq(tokens(name).map((t) => CAT_EN[t]).filter(Boolean)).join(' ');
  return (dict[best] + ' ' + words + ' ' + tokens(name).filter(isNum).join(' ')).trim().replace(/\s+/g, '-');   // مثال: johnson-shampoo-750
}

async function runSites(name, info, barcode, sites, fetchFn, kv) {
  const perSite = await Promise.all(sites.map(async (site) => {
    let urls = [];
    try { urls = SEARCH[site] ? await SEARCH[site](name, { ...info, barcode }, fetchFn) : MAPS[site] ? await byMap(site)(name, info, fetchFn, kv) : []; } catch (e) { return []; }
    // رتّب المرشّحين بتشابه الرابط مع اسمنا (أو رابطنا الإنجليزي) ثم اجلب أفضل 6
    const slug = info.slug ? info.slug.replace(/-/g, ' ') : '';
    urls = urls.map((u) => ({ u, s: Math.max(matchScore(name, slugText(u)), slug ? matchScore(slug, slugText(u)) : 0) })).sort((a, b) => b.s - a.s).slice(0, 6).map((x) => x.u);
    const checked = await Promise.all(urls.map(async (u) => { const fu = MAPS[site]?.toAr ? u.replace('/en/', '/ar/') : u; let r = await checkCompetitorUrl(fu, fetchFn); if (!r.ok && fu !== u) r = await checkCompetitorUrl(u, fetchFn); return { u: fu, r }; }));
    return checked.filter((x) => x.r.ok).map((x) => {
      const codes = x.r.codes || [], codeHit = barcode && codes.includes(barcode);
      let score = Math.max(matchScore(name, x.r.title), matchScore(name, slugText(x.u)) * 0.9);
      if (!codeHit && barcode && codes.some((c) => /^\d{12,14}$/.test(c))) score = Math.round(score * 50) / 100;   // لديهم باركود مختلف: غالباً حجم/نوع مختلف
      return { competitor: site, url: x.u, title: x.r.title, brand: x.r.brand || '', price: x.r.price, avail: x.r.avail, score: codeHit ? 1 : score, matchby: codeHit ? 'barcode' : 'name', code: codeHit ? barcode : (codes.find((c) => /^\d{12,14}$/.test(c)) || '') };
    }).sort((a, b) => b.score - a.score).slice(0, 2);
  }));
  return perSite.flat();
}

// info = { barcode, slug }: الباركود (sku في سلة) والرابط الإنجليزي لمنتجنا (لمواقع روابطها إنجليزية)؛ إن لم يوجد نستنتج اسماً إنجليزياً من قاموس العلامات
export async function suggestFor(name, { info = {}, fetchFn = fetch, kv = null, sites = SUGGEST_SITES } = {}) {
  const barcode = String(info.barcode || '').replace(/\D/g, '');
  let dict = {}; try { dict = JSON.parse((kv && await kv.get('brands')) || '{}'); } catch (e) { dict = {}; }
  for (const [ar, en] of Object.entries(SEED_BRANDS)) { const k = tokens(ar).join(' '); if (k && !dict[k]) dict[k] = en; }   // قاموس أساسي + ما تعلّمناه
  const slug0 = info.slug || brandSlugFor(dict, name);
  let out = await runSites(name, { ...info, slug: slug0 }, barcode, sites, fetchFn, kv);
  // نتعلّم العلامات من الصفحات التي وجدناها، ثم نعيد البحث في المواقع الإنجليزية التي لم تُعطِ مطابقة قوية
  let learned = false; for (const x of out) if (x.score >= 0.85 && learnBrand(dict, x.brand)) learned = true;
  if (learned && kv) { const keys = Object.keys(dict); if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete dict[k]; await kv.put('brands', JSON.stringify(dict)); }
  const weak = ENGLISH_SITES.filter((x) => sites.includes(x) && !out.some((r) => r.competitor === x && r.score >= 0.85));
  if (weak.length) {
    const donor = out.filter((x) => x.score >= 0.85).map((x) => latinSlug(x.url)).find(Boolean);
    const slug2 = brandSlugFor(dict, name) || donor || '';
    if (slug2 && slug2 !== slug0) {
      const seen = new Set(out.map((x) => x.url));
      out = out.concat((await runSites(name, { ...info, slug: slug2 }, barcode, weak, fetchFn, kv)).filter((x) => !seen.has(x.url)));
    }
  }
  return out.sort((a, b) => b.score - a.score);
}
