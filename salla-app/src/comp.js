// مراقبة أسعار المنافسين (مجانية: fetch من الـWorker + قراءة بيانات المنتج المنظّمة JSON-LD/Open Graph؛ بلا Firecrawl).
// أنت تحدد رابط صفحة المنتج عند كل منافس؛ والـWorker يجلبها مرة يومياً ويحفظ السعر والتوفر وتاريخ الأسعار.

const AR_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '٫': '.', '٬': ',' };
export function toNum(v) {
  if (v == null) return null;
  let s = String(v).replace(/[٠-٩٫٬]/g, (c) => AR_DIGITS[c]).replace(/[^\d.,]/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) s = s.replace(/,/g, '');                 // 1,299.50
  else if (s.includes(',')) s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');   // 12,50 أو 1,299
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const availOf = (a) => { const s = String(a || ''); return /InStock|LimitedAvailability|PreOrder|BackOrder/i.test(s) ? 1 : /OutOfStock|SoldOut|Discontinued/i.test(s) ? 0 : null; };
const meta = (html, re) => { const m = re.exec(html); return m ? m[1] : null; };
const decode = (t) => String(t || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

function* walk(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return;
  if (Array.isArray(node)) { for (const x of node) yield* walk(x, depth + 1); return; }
  yield node;
  for (const k of ['@graph', 'mainEntity', 'itemListElement', 'item']) if (node[k]) yield* walk(node[k], depth + 1);
}

// يرجع { price, currency, avail, title } أو null إن لم يوجد سعر
export function parseProductPage(html) {
  html = String(html || '');
  let found = null;
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (let m; (m = re.exec(html)) && !found;) {
    let j; try { j = JSON.parse(m[1].trim()); } catch (e) { continue; }
    for (const n of walk(j)) {
      const t = [].concat(n['@type'] || []).join(',');
      if (!/Product/i.test(t) || !n.offers) continue;
      const offers = [].concat(n.offers), o = offers.find((x) => toNum(x?.price ?? x?.lowPrice ?? x?.priceSpecification?.price)) || offers[0];
      const price = toNum(o?.price ?? o?.lowPrice ?? o?.priceSpecification?.price);
      if (price) { found = { price, currency: String(o.priceCurrency || o.priceSpecification?.priceCurrency || '').slice(0, 5), avail: availOf(o.availability), title: decode(n.name).slice(0, 200) }; break; }
    }
  }
  if (!found) {
    const price = toNum(meta(html, /<meta[^>]+(?:property|name)=["'](?:product:price:amount|og:price:amount|twitter:data1)["'][^>]*content=["']([^"']+)["']/i) || meta(html, /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:product:price:amount|og:price:amount)["']/i) || meta(html, /itemprop=["']price["'][^>]*content=["']([^"']+)["']/i));
    if (price) found = { price, currency: String(meta(html, /(?:product:price:currency|og:price:currency)["'][^>]*content=["']([^"']+)["']/i) || '').slice(0, 5), avail: availOf(meta(html, /(?:product:availability|og:availability)["'][^>]*content=["']([^"']+)["']/i)), title: '' };
  }
  if (!found) return null;
  if (!found.title) found.title = decode(meta(html, /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) || meta(html, /<title[^>]*>([^<]+)<\/title>/i)).slice(0, 200);
  return found;
}

// رابط https لموقع عام فقط (لا IP ولا localhost)
export function validCompetitorUrl(u) {
  let x; try { x = new URL(String(u).trim()); } catch (e) { return null; }
  if (x.protocol !== 'https:' || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(x.hostname) || /^\d+(\.\d+){3}$/.test(x.hostname) || /(^|\.)(localhost|local|internal)$/i.test(x.hostname)) return null;
  return x.toString();
}

export async function checkCompetitorUrl(url, fetchFn = fetch) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetchFn(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (compatible; iBrandPriceCheck/1.0)', accept: 'text/html,application/xhtml+xml', 'accept-language': 'ar,en;q=0.8' } });
    if (!r.ok) return { err: `HTTP ${r.status}` + (r.status === 403 || r.status === 429 ? ' (الموقع يحجب الجلب الآلي)' : '') };
    const html = (await r.text()).slice(0, 2_000_000);
    const p = parseProductPage(html);
    if (p) return { ok: true, ...p };
    if (/<meta[^>]+http-equiv=["']refresh["']/i.test(html)) return { err: 'الصفحة محوّلة لصفحة أخرى (غالباً المنتج أُزيل أو الرابط قديم)' };
    return { err: 'لا يوجد سعر منظّم في الصفحة (قد تكون الصفحة تُحمّل بالجافاسكربت)' };
  } catch (e) { return { err: e && e.name === 'AbortError' ? 'انتهت مهلة الجلب' : 'تعذّر الجلب' }; }
  finally { clearTimeout(timer); }
}

/* ---------- قاعدة البيانات ---------- */
export const compList = async (db, m) => (await db.prepare('SELECT id, product, competitor, url, price, currency, avail, title, checked, err, ignored FROM comp_item WHERE merchant = ? ORDER BY product, competitor').bind(m).all()).results;
export async function compUpsert(db, m, { product, competitor, url }) {
  await db.prepare('INSERT INTO comp_item (merchant, product, competitor, url) VALUES (?, ?, ?, ?) ON CONFLICT(merchant, product, competitor) DO UPDATE SET url = excluded.url, checked = 0, err = \'\', ignored = 0').bind(m, product, competitor, url).run();
  return (await db.prepare('SELECT id FROM comp_item WHERE merchant = ? AND product = ? AND competitor = ?').bind(m, product, competitor).first()).id;
}
export const compDelete = (db, m, id) => db.batch([db.prepare('DELETE FROM comp_item WHERE merchant = ? AND id = ?').bind(m, id), db.prepare('DELETE FROM comp_hist WHERE merchant = ? AND item_id = ?').bind(m, id)]);
export const compIgnore = (db, m, id, on) => db.prepare('UPDATE comp_item SET ignored = ? WHERE merchant = ? AND id = ?').bind(on ? 1 : 0, m, id).run();
export const compOne = (db, m, id) => db.prepare('SELECT * FROM comp_item WHERE merchant = ? AND id = ?').bind(m, id).first();
export const compDue = async (db, m, beforeTs, limit) => (await db.prepare('SELECT id, url FROM comp_item WHERE merchant = ? AND ignored = 0 AND checked < ? ORDER BY checked LIMIT ?').bind(m, beforeTs, limit).all()).results;
export async function compSave(db, m, id, res, now, day) {
  if (res.ok) {
    await db.batch([
      db.prepare('UPDATE comp_item SET price = ?, currency = ?, avail = ?, title = ?, checked = ?, err = \'\' WHERE merchant = ? AND id = ?').bind(res.price, res.currency || '', res.avail ?? null, res.title || '', now, m, id),
      db.prepare('INSERT INTO comp_hist (merchant, item_id, day, price, avail) VALUES (?, ?, ?, ?, ?) ON CONFLICT(merchant, item_id, day) DO UPDATE SET price = excluded.price, avail = excluded.avail').bind(m, id, day, res.price, res.avail ?? null)
    ]);
  } else {
    await db.prepare('UPDATE comp_item SET checked = ?, err = ? WHERE merchant = ? AND id = ?').bind(now, String(res.err || 'خطأ').slice(0, 200), m, id).run();   // نُبقي آخر سعر ناجح
  }
}
