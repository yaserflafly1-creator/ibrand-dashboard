const Anthropic = require('@anthropic-ai/sdk');

const TAG_COUNT = 12;
const MAX_TAG_LENGTH = 40;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';

let client;
const anthropic = () => (client ||= new Anthropic());

const SYSTEM = `أنت خبير SEO وبحث داخل متاجر التجارة الإلكترونية العربية.
مهمتك: توليد وسوم (tags) تساعد العميل يلقى المنتج في بحث المتجر حتى لو كتب الكلمة غلط.
أعد JSON فقط بالشكل {"tags": ["..."]} وفيه بالضبط ${TAG_COUNT} وسم، بدون أي نص آخر.
وزّع الوسوم تقريباً هكذا:
- 3 مرادفات/أسماء بديلة للمنتج (فصحى وعامية خليجية)
- 3 أخطاء إملائية شائعة لاسم المنتج (همزات، ة/ه، ى/ي، حروف متقاربة، حذف حرف)
- 2 كتابة بالإنجليزي أو الحروف اللاتينية للاسم (Arabizi أو ترجمة) إن كان مناسباً
- 2 صفات/استخدامات يبحث عنها العميل (مثل: هدية، رجالي، للسفر)
- 2 تصنيف أو ماركة أو نوع المنتج
كل وسم كلمة أو كلمتين كحد أقصى، بدون رموز أو # ولا تكرر وسماً.`;

function normalize(tags) {
  const seen = new Set();
  const out = [];
  for (const raw of tags) {
    const t = String(raw).replace(/^#/, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LENGTH);
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function parseTags(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('رد غير متوقع من Claude');
  return normalize(JSON.parse(match[0]).tags || []);
}

function stripHtml(html = '') {
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

async function generateTags(product) {
  const info = [
    `اسم المنتج: ${product.name}`,
    product.categories?.length ? `التصنيفات: ${product.categories.map((c) => c.name).join('، ')}` : '',
    product.brand?.name ? `الماركة: ${product.brand.name}` : '',
    `الوصف: ${stripHtml(product.description).slice(0, 1200)}`,
  ].filter(Boolean).join('\n');

  let tags = [];
  // نحاول مرتين عشان نوصل بالضبط 12 وسم بعد إزالة المكرر
  for (let attempt = 0; attempt < 2 && tags.length < TAG_COUNT; attempt++) {
    const extra = attempt ? `\nالوسوم التالية موجودة، أعطني وسوماً مختلفة تكمّل لـ${TAG_COUNT}: ${tags.join('، ')}` : '';
    const msg = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 600,
      system: SYSTEM,
      messages: [{ role: 'user', content: info + extra }],
    });
    tags = normalize([...tags, ...parseTags(msg.content[0].text)]);
  }
  return tags.slice(0, TAG_COUNT);
}

module.exports = { generateTags, normalize, parseTags, TAG_COUNT };
