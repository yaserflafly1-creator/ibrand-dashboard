# Salla Smart Tags — وسوم ذكية لمنتجات سلة

تطبيق سلة يضيف تلقائياً **12 وسم** لكل منتج (مرادفات، عامية/فصحى، أخطاء إملائية شائعة، إنجليزي/Arabizi، استخدامات، تصنيف) عشان بحث المتجر يلقى المنتج حتى لو العميل كتب غلط.

## كيف يشتغل
1. التاجر يثبّت التطبيق ← سلة ترسل `app.store.authorize` (Easy Mode) فنحفظ التوكنات.
2. عند `product.created` / `product.updated` نجلب المنتج، نولّد الوسوم عبر Claude، ونحدّثها بـ `PUT /products/{id}`.
3. نحفظ بصمة (اسم+وصف+تصنيف) للمنتج لتجنب حلقة لا نهائية، لأن تحديثنا للوسوم نفسه يطلق `product.updated`.

## الإعداد
1. أنشئ تطبيقاً في [بوابة شركاء سلة](https://salla.partners) بنمط **Easy Mode** مع صلاحية **Products: Read & Write**.
2. فعّل Webhooks: `product.created`, `product.updated`, `app.store.authorize`, `app.uninstalled` على الرابط `https://<APP_URL>/webhooks/salla` واختر **Signature** وانسخ السر.
3. `cp .env.example .env` وعبّي القيم، ثم:
   ```
   npm install
   npm start
   ```
4. انشره على استضافة HTTPS (Render / Railway / Fly...). ملاحظة: التخزين الحالي ملف JSON — استخدم قرص دائم أو بدّله بقاعدة بيانات.

## معالجة المنتجات الحالية
```
curl -X POST https://<APP_URL>/admin/backfill/<MERCHANT_ID> -H "Authorization: Bearer <SALLA_WEBHOOK_SECRET>"
```

## ملاحظات
- الوسوم الجديدة **تستبدل** وسوم المنتج الحالية (12 بالضبط).
- لم أختبر الربط الفعلي مع سلة لأنه يحتاج بيانات تطبيقك؛ تأكد من اسم حقل `tags` في استجابة `GET /products/{id}` عند أول تجربة.
- الاختبارات: `npm test`.
