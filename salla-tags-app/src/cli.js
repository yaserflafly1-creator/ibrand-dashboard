// تشغيل من جهازك بدون استضافة.
// معاينة فقط (بدون كتابة):  npm run tag -- --count=10
// تطبيق فعلي على سلة:        npm run tag -- --count=10 --apply
// منتجات محددة:              npm run tag -- --ids=123,456 --apply
// يحتاج في .env:  SALLA_ACCESS_TOKEN  و  ANTHROPIC_API_KEY
const store = require('./store');
const salla = require('./salla');
const { generateTags } = require('./tags');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

async function main() {
  const token = process.env.SALLA_ACCESS_TOKEN;
  if (!token) throw new Error('ضع SALLA_ACCESS_TOKEN في ملف .env');
  const MERCHANT = 'cli';
  store.setMerchant(MERCHANT, { access_token: token });

  const count = Number(args.count) || 10;
  let ids;
  if (args.ids) {
    ids = String(args.ids).split(',').map((x) => x.trim()).filter(Boolean);
  } else {
    // ملاحظة: سلة لا تعطي ترتيباً بتاريخ الإضافة، فهذا ترتيب الـ API الافتراضي وليس بالضرورة الأحدث
    const r = await salla.listProducts(MERCHANT, 1);
    ids = r.data.filter((p) => p.status !== 'deleted').slice(0, count).map((p) => p.id);
  }

  console.log(`${args.apply ? 'تطبيق فعلي' : 'معاينة فقط (أضف --apply للكتابة)'} على ${ids.length} منتج\n`);
  for (const id of ids) {
    try {
      const product = await salla.getProduct(MERCHANT, id);
      const tags = await generateTags(product);
      console.log(`${product.name} (${id})\n  ${tags.join(' | ')}`);
      if (args.apply) {
        await salla.setTags(MERCHANT, id, tags);
        console.log('  ✔ تم الحفظ في سلة');
      }
    } catch (err) {
      console.error(`  ✘ ${id}: ${err.message}`);
    }
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
