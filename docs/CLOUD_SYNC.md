# المزامنة السحابية — Cloud sync

## بالعربي

تزامن ملفاتك (داخل مجلد المنزل) وإعداداتك والإشارات المرجعية ومدن الساعة بين الموقع وتطبيق سطح المكتب وأي جهاز آخر، عبر قاعدة بيانات D1 المجانية في حساب Cloudflare الخاص بك. مفاتيح الذكاء الاصطناعي ورمز الوسيط وأماكن النوافذ وقفل الشاشة **لا تُزامَن أبداً**.

**التجهيز (مرة واحدة):**
1. Cloudflare → **Storage & databases → D1 SQL database → Create** → الاسم `faisal-sync`.
2. مشروع `faisal-os` → **Settings → Bindings → Add → D1 database** → Variable name: `SYNC_DB` → اختر `faisal-sync` → Save.
3. الرمز السري: نفس `FAISAL_PROXY_TOKEN` يكفي (أو أضف Secret منفصلاً باسم `FAISAL_SYNC_TOKEN`).
4. **Deployments → Retry deployment**.
5. في كل جهاز: الإعدادات ← المزامنة ← الصق الرمز ← تفعيل.

أول مزامنة على جهاز جديد تأخذ نسخة السحابة (لا تستبدل ملفاتك الحقيقية بالملفات الافتراضية). بعدها: آخر تعديل يفوز. الحذف وإعادة التسمية تُزامَن. الملفات الأكبر من 1 ميغابايت تُترك.

## English

Syncs home-folder files, settings, bookmarks and world-clock cities between the website, the desktop app and any other device, through a free D1 database in the owner's Cloudflare account. Set up: create a D1 database, bind it to the Pages project as `SYNC_DB`, reuse `FAISAL_PROXY_TOKEN` (or add `FAISAL_SYNC_TOKEN`), redeploy, then Settings → Sync on each device. Server: `tools/cloud-sync.mjs`; client: `src/shell/sync.ts`.
