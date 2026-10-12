# ibrand-dashboard
Sales dashboard for iBrand online store

Live: https://yaserflafly1-creator.github.io/ibrand-dashboard/

## كيف تشتغل
- `index.html` الصفحة، تقرأ الأرقام من `data.json` وتتحقق من وجود تحديث كل 5 دقائق.
- `data.json` بيانات حقيقية من متجر سلة (المبيعات والطلبات اليومية، حالات الطلبات، الأكثر مبيعاً، أحدث الطلبات).
- مهمة مجدولة في Claude تسحب الأرقام من سلة وتحدّث `data.json` تلقائياً عبر `scripts/update_data.py`.
- أسماء العملاء تُختصر (الاسم الأول + أول حرف من العائلة) لأن الصفحة عامة.
