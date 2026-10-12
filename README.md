# iBrand — لوحة مبيعات تطبيق سلة

لوحة مبيعات وردية RTL تعمل كتطبيق مضمَّن (Embedded App) داخل لوحة تحكم متجر سلة، وتُستضاف على **Cloudflare Workers**.

## البنية
- `public/index.html` — الواجهة (Chart.js). بدون `?token=` تعمل ببيانات تجريبية؛ داخل سلة تجلب البيانات الحقيقية.
- `src/worker.js` — الـ Worker: استلام webhook التثبيت وحفظ التوكن في KV، والتحقق من هوية التاجر، وتجديد التوكن، و`GET /api/orders`.
- `src/salla.js` — تحويل بيانات سلة إلى شكل اللوحة.
- `test/` — اختبارات المحوّل: `npm test`.

## التشغيل والنشر
1. `npm install`
2. `npx wrangler kv namespace create TOKENS` ثم ضع الـ id في `wrangler.toml`.
3. الأسرار (لا تُرفع للمستودع):
   ```
   npx wrangler secret put SALLA_CLIENT_ID
   npx wrangler secret put SALLA_CLIENT_SECRET
   npx wrangler secret put SALLA_WEBHOOK_SECRET
   ```
4. `npm run deploy` ثم في بوابة شركاء سلة:
   - **Webhook URL:** `https://<worker>.workers.dev/webhook` (حدث `app.store.authorize`، وربما `app.uninstalled`)
   - **رابط التطبيق المضمَّن:** `https://<worker>.workers.dev/`
   - **الصلاحيات:** قراءة الطلبات والمنتجات فقط.
5. للتجربة محلياً: `npm run dev` وافتح `/?demo` لبيانات تجريبية.

## ⚠️ نقاط تحتاج مطابقة مع وثائق سلة (موسومة `[VERIFY]` في الكود)
- ترويسة وطريقة توقيع الـ webhook، وشكل بيانات `app.store.authorize`.
- نقطة التحقق من توكن التطبيق المضمَّن (introspect) وشكل استجابتها، وطريقة تمرير التوكن للصفحة.
- معاملات `GET /orders` (`from_date`/`to_date`/`per_page`/`page`) وشكل الـ pagination.
- حقول الطلب (`status.slug`، `amounts.total`، `date.date`، `customer`) وحقول `items` في تفاصيل الطلب.
- ترويسات السماح بعرض الصفحة داخل iframe سلة (frame-ancestors) إن لزم.

## حدود معروفة
- المنتجات الأكثر مبيعاً تُحسب من تفاصيل أحدث `MAX_ORDER_DETAILS` طلباً (افتراضياً 200) لحماية حدود الـ subrequests؛ الأرقام الإجمالية تُحسب من كل الطلبات.
- لا يوجد تخزين مؤقت للنتائج بعد.
