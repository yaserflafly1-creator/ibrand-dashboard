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
   - **الصلاحيات:** `orders.read` و`products.read` (قراءة فقط).
5. للتجربة محلياً: `npm run dev` وافتح `/?demo` لبيانات تجريبية.

## ⚠️ نقاط تحتاج مطابقة مع وثائق سلة (موسومة `[VERIFY]` في الكود)
- شكل بيانات حدث `app.store.authorize` واسم الحدث نفسه (صفحة App Events)، وهل يصل `merchant` في جذر الطلب.
- نقطة التحقق من توكن التطبيق المضمَّن (introspect) وشكل استجابتها، وطريقة تمرير التوكن للصفحة.
- ترويسات السماح بعرض الصفحة داخل iframe سلة (frame-ancestors) إن لزم.

## جلسة التطبيق المضمَّن
- عند ردّ `401` من `/api/orders` تستدعي الصفحة `embedded.auth.refresh()` (من `@salla.sa/embedded-sdk`) لإعادة تحميل الإطار بتوكن جديد، مع حارس 30 ثانية ضد الحلقات.
- ⚠️ تحميل الـ SDK نفسه (`window.sallaEmbedded`) وطريقة وصول التوكن للصفحة (نفترض `?token=`) ينتظران صفحات Embedded SDK: Installation / Initialization / Auth.

## تصنيف حالات الطلب (من List Order Statuses)
- **مكتمل:** `completed`, `delivered` · **ملغي:** `canceled`, `payment_failed` · **مسترجع:** `restored`, `restoring`
- **قيد التنفيذ:** `in_progress`, `under_review`, `shipped`, `delivering`, `waiting_for_payment_confirmation`
- **مستبعد:** `payment_pending` (لم يُدفع بعد) والمسودات.
- إن أردت تصنيفاً مختلفاً غيّر الثوابت أعلى `src/salla.js`.

## حدود معروفة
- `GET /orders` يُرجع منتجات الطلب بدون سعر، فنأخذ **السعر الحالي** من `GET /products` (مطابقة بالاسم، ويُخزَّن الكتالوج ساعة في KV). الطلبات القديمة قد تحمل سعراً مختلفاً عن سعر اليوم، وما لا يُطابَق اسمه يبقى على تقدير (إجمالي الطلب موزَّعاً على القطع).
- الجلب 30 طلباً لكل صفحة وبالتسلسل (قيد من سلة)، فالفترات الطويلة تحتاج نداءات كثيرة: خطة Workers المجانية تسمح بـ 50 نداء خارجياً للطلب الواحد، والمدفوعة 1000. النتائج تُخزَّن 5 دقائق في KV.
