# تدقيق: سجل التطبيقات + تطبيقات النطاق (src/apps, src/brand) — قراءة فقط

النطاق: `src/apps/index.ts`, `src/apps/{ai,browser,calculator,clock,monitor,settings,store}/**`, `src/brand/**`. لم يُعدَّل أي ملف مصدر.

## خريطة التطبيقات

| app id | static/lazy | permissions | أهم الميزات | ملاحظات |
|---|---|---|---|---|
| `org.faisal.Claude` (Faisal AI) | manifest+icon static — code lazy (`apps/index.ts:10,27`) | `network, fs:home, fs:read-all, system:monitor, settings, notifications` (`ai/manifest.ts:12`) | وكيل Groq مع function-calling، أدوات ملفات/تطبيقات/طرفية/مظهر، بطاقة تأكيد لكل تغيير، مصادر ويب، 4 نماذج مرتّبة | P0/P1 أدناه؛ `fs:read-all` أوسع من الحاجة الفعلية |
| `org.faisal.Browser` | static+icon، code lazy (`apps/index.ts:9,26`) | `network` (`browser/manifest.ts:13`) | لسانات + مفضلة (localStorage) + بحث، سياسة URL صارمة https فقط ومنع same-origin، إعادة كتابة يوتيوب إلى nocookie، قائمة نطاقات مانعة للتضمين | تحديثات معطّلة للـ iframe تُظهر بطاقة فارغة + تلميح بعد 1.4s (`browser/index.ts:280,323`) |
| `org.faisal.Calculator` | static+icon، code lazy (`apps/index.ts:11,28`) | `[]` (`calculator/manifest.ts:10`) | أساسي/متقدم، sin/cos/tan/ln/log/√/²/^/π/e/! و%، deg-rad، أرقام عربية، سجل آخر 50، لوحة مفاتيح | `lastResult` غير مستخدم (`calculator/index.ts:372`)؛ لا ذاكرة M+/MR |
| `org.faisal.Clock` | static+icon، code lazy (`apps/index.ts:13,30`) | `notifications` (`clock/manifest.ts:10`) | وقت عالمي (cities.ts) + هجري/ميلادي + ساعة إيقاف + لفّات + مؤقت + نغمة + إشعار | لا منبّه/تنبيهات فعلاً، لكن وصف المتجر يقول «التنبيهات» (`store/model.ts:54`) |
| `org.faisal.SystemMonitor` | static+icon، code lazy (`apps/index.ts:14,31`) | `system:monitor, fs:read-all` (`monitor/manifest.ts:10`) | العمليات (نافذة/مدة/صلاحيات + إنهاء)، الموارد (JS heap + FPS)، أنظمة الملفات (مشي VFS + الحصة) | P1: حصة وهمية `50MB` (`monitor/index.ts:53,346`) |
| `org.faisal.Settings` | static+icon، code lazy (`apps/index.ts:16,33`) | `settings` (`settings/manifest.ts:10`) | 4 أقسام فقط: المظهر/اللغة/النظام/حول — سمة + لون تمييز + لغة + استعادة الجلسة + تقدير التخزين + إعادة ضبط + اختصارات + إصدار/UA | يكتب عبر `sys.settings` فعلاً؛ لا Performance/Keyboard/Privacy مستقلة |
| `org.faisal.Store` | static+icon، code lazy (`apps/index.ts:15,32`) | `apps:manage, notifications` (`store/manifest.ts:10`) | استكشف/مثبّت/تحديثات، بحث+تصنيفات، صفحة تطبيق+أذونات، تثبيت/إزالة مع تأكيد وإشعارات | P1: تبويب «التحديثات» غير وظيفي |

**سلسلة الاستيراد الثابتة من `src/main.ts` (كلها في الحزمة الأولية — manifests + أيقونات فقط، لا كود تطبيقات):**
`main.ts:13` → `apps/index.ts:6-16` (`./files/manifest`, `./terminal/manifest`, `./editor/manifest`, `./browser/manifest`, `./ai/manifest`, `./calculator/manifest`, `./images/manifest`, `./clock/manifest`, `./monitor/manifest`, `./store/manifest`, `./settings/manifest`) → كل manifest يستورد `./icon` (مثال `ai/manifest.ts:2`, `browser/manifest.ts:2`, `store/manifest.ts:2`) → `icon.ts` يستورد `{ tile, GOLD }` من `src/brand/icons.ts:12,29` (و`settings/manifest.ts:2` يستورد `brand/icons` مباشرة). الثقل الحقيقي للأيقونات = `src/brand/icons.ts` فقط (~3.5KB)، والأيقونات الخاصة صغيرة (531–1196 بايت).

**التحقق من الـ lazy:** كل استدعاءات التحميل هي `import()` ديناميكي في `apps/index.ts:23-33`، ويُنفَّذ مرة واحدة عند أول تشغيل عبر `apps.ts:110-114,210`. لا يوجد أي مسار ثابت من `main.ts` إلى كود أي تطبيق (فحص grep على `from '../apps` أعطى نتيجتين فقط: `main.ts:13` و`security.test.ts:4`).

## جيد ويجب الحفاظ عليه

1. **تحميل كسول حقيقي بحواجز صحيحة:** `apps/index.ts:18-19` + `kernel/apps.ts:110-113` (cache + reset عند الفشل) + مؤشر تحميل `apps.ts:209` + رسالة chunk قديم `apps.ts:216-217`.
2. **عزل الصلاحيات في النواة لا في التطبيق:** `apps.ts:17-46` (fsAccess/scopeVFS)، `52-63` (منع انبعاث الأحداث)، `66-76` (WM خاص بالتطبيق)، `193-201` (رفض مفاتيح `apps.*`)، واختبار مباشر في `store/kernel-install.test.ts:124-131`.
3. **سياسة URL في المتصفح:** `browser/url.ts:51-62` (يرفض `javascript:`/`data:`/`blob:` بالتحويل إلى بحث)، `72-82` (https فقط + رفض أصل النظام نفسه)، `166-205` قائمة النطاقات المانعة، وتوثيق السبب في `browser/index.ts:290-293`.
4. **بوابة التأكيد في الوكيل:** `ai/agent.ts:31-39` + `ai/tools.ts:296-297` (MUTATING) + `isReadOnlyCommand` الصارم `tools.ts:40-81` + تأكيد «رفض المستخدم» يعود للنموذج كنص `tools.ts:466`.
5. **Markdown مُهرَّب قبل البناء:** `ai/markdown.ts:10-18,37` — كل شيء يمر بـ `escapeHtml` أولاً؛ لا `eval/new Function` في الحاسبة (`calculator/engine.ts:5`) ولا في المحلل.
6. **CSP صارمة وموثّقة:** `index.html:7-8` — `connect-src` محصور بـ `https://api.groq.com`، `object-src 'none'`، `base-uri 'none'`.
7. **تكافؤ ar/en كامل في النطاق:** فحص مفاتيح `settings/strings.ts` (46 مفتاحاً لكل لغة) و`calculator` (13/13) متطابقان؛ `defineStrings` يسقط إلى en ثم إلى المفتاح (`kernel/i18n.ts:27`) فلا انهيار عند نقص ترجمة.
8. **العزل البصري للنصوص اللاتينية داخل RTL:** `settings/index.ts:42` (`\u2066…\u2069`)، `tools.ts:86-90` (`iso`)، `monitor/index.ts:222`، `browser/index.ts:241,267`، `ai/index.ts:303`.

## مشاكل P0

1. **حقن أوامر عبر محتوى ويب غير موثوق → تسريب مفتاح المخزن.** الوكيل يقرأ صفحات ويب (`ai/groq.ts:32,139-148`) ثم يملك `read_file`/`run_command` بلا تأكيد للقراءة (`tools.ts:521-551,790-795` + `isReadOnlyCommand`)، والمفتاح محفوظ في `localStorage` (`ai/index.ts:87,149-150`). لا توجد أداة تقرأ localStorage اليوم، لكن `cat` لأي ملف يكتبه المستخدم + تعليمات داخل صفحة كافية لتسريب أي سر يصل إلى مخرجات الأدوات. **الإصلاح الآمن:** تنقيح (redact) مخرجات الأدوات بحثاً عن `gsk_[A-Za-z0-9]{20,}`/`Bearer `، ومنع `run_command` من أوامر تقرأ تخزين المتصفح، ووضع حدّ على حجم/نطاق القراءة قبل الإرسال. **الخطر:** متوسط الاحتمال، عالٍ الأثر.
2. **CSS مكسور: فئة `.detail` بلا بندلة.** `ai/index.ts:270` ينشئ `faisal-ai-confirm-detail` و`269` يحمل `is-danger`، ولا وجود للفئتين في `ai/ai.css` (الموجود `faisal-ai-confirm` فقط). **الإصلاح:** إضافة بندلة `.faisal-ai-confirm-detail` + `.faisal-ai-confirm.is-danger`. **الخطر:** منخفض (عرض فقط) لكنه على أهم بطاقة في التطبيق.

## مشاكل P1

1. **تبويب «التحديثات» في المتجر غير وظيفي:** `store/index.ts:228-259` يرسم دائماً «كل التطبيقات محدَّثة» ويعرض `entry.version ?? '1.0.0'` (`:255`) بلا أي مقارنة إصدارات. **الإصلاح:** إزالته أو وسْمه «قريباً» حتى يوجد مصدر إصدارات. **الخطر:** ادعاء غير صحيح للمستخدم.
2. **حصة وهمية في المراقب:** `monitor/index.ts:53` `QUOTA_BYTES = 50MB` تُستخدم في `:346` بجانب التقدير الحقيقي `navigator.storage.estimate()` (`:359-363`) — رقمان متناقضان. **الإصلاح:** استخدام `est.quota` أو وسم الصف «تقديري». **الخطر:** تضليل يقوّض مصداقية الأرقام الحقيقية (heap/FPS).
3. **وضع السمة «النظام» لا يتبع النظام:** `shell/appearance.ts:34` يحذف `data-theme` فقط ولا يوجد `matchMedia('(prefers-color-scheme: dark)')` في `appearance.ts` كله. **الإصلاح:** مستمع matchMedia داخل `wireAppearance`. **الخطر:** إعداد معروض لا يؤثر دائماً.
4. **مفاتيح ترجمة ميتة:** `settings.about.version` (`settings/strings.ts:18,64`) و`store.coreBadge` (`store/strings.ts:18,58`) غير مستخدمين في أي ملف. **الإصلاح:** حذفهما. **الخطر:** التباس لاحق.
5. **«إعادة الضبط» لا تحذف كل شيء:** `settings/index.ts:235,239` يحذف مفاتيح `faisal.*` و`indexedDB 'faisal-vfs'` لكنه لا يلغي service worker ولا `CacheStorage`، رغم `settings.system.resetDesc` (`strings.ts:35`) و`resetBody` (`:38`). **الإصلاح:** `caches.delete` + إلغاء التسجيل. **الخطر:** بيانات متبقية.

## مشاكل P2-3

- `browser/url.ts:166-181` قائمة نطاقات يدوية، وما ليس فيها يعطي إطاراً فارغاً + تلميحاً بعد 1400ms (`browser/index.ts:322-323`) بدل رسالة مباشرة.
- `monitor/index.ts:292` الـ FPS يُحسب من تعداد rAF كل ثانية → التبويب المخفي يعطي 0–1 (ليس خطأً لكنه مُضلّل)؛ و`performance.memory` غير متاح إلا في Chromium (`monitor/index.ts:228`).
- `kernel/apps.ts:161,168` `singleInstance` يُنفَّذ بالتركيز على أول نافذة فقط؛ التبويبات المتعددة في المتصفح تُدار داخل التطبيق — سلوك غير موثّق في `AppManifest` (`kernel/types.ts:130`).
- `ai/index.ts:216,263` استخدام `innerHTML` لمخرجات النموذج؛ المهرّب escape صحيح (`markdown.ts:10`) لكن نمط `innerHTML = renderMarkdown(...)` هشّ — يُفضَّل بناء DOM أو إبقاء escape داخل نفس الدالة (وهو كذلك) مع اختبار XSS في `markdown.test.ts`.
- `settings/index.ts:172-178` تغيير اللغة يعيد تحميل الصفحة كاملاً (`location.reload()`) — لا حاجة فنية لذلك.
- `clock/index.ts:617-626` ثلاثة `setInterval` تعمل حتى عند إغلاق المخفي؛ المؤقت لا يُحفظ عند إغلاق النافذة.
- `settings/index.ts:290` و`brand/logo.ts:19` و`settings/index.ts:13`: ثلاث قيم إصدار مختلفة (`0.1.0` / `0.1` / `OS_VERSION`) — مصدر انحراف.
- تكرار أيقونات SVG داخلية string-by-string: `settings/index.ts:15-21`، `store/index.ts:19-22`، `monitor/tab-icons.ts`، بالإضافة إلى `brand/icons.ts` و`brand/logo.ts` — مرشّح واقعي للتجميع في وحدة أيقونات واحدة.

## خطر الأسرار/المفاتيح

**لا يوجد أي مفتاح API أو رمز سري في كود العميل إطلاقاً** — تم فحصه بـ grep على `gsk_|sk-|AIza|Bearer …|api_key =` في `src/**` و`index.html` والنتيجة صفر، ولا توجد أي قراءة لـ `import.meta.env` في كود التطبيقات (الاستخدام الوحيد في `main.ts:41` لفحص `PROD`).

**كيف يُحصل المفتاح:** يُدخل المستخدم مفتاحه يدوياً (`ai/index.ts:133-137`)، يُتحقَّق منه عبر `GET /models` (`ai/index.ts:148` → `groq.ts:75-80`)، ثم يُكتب في `localStorage['faisal.groq.apiKey']` (`ai/index.ts:87,150`)، ويُرسَل كـ `Authorization: Bearer` إلى `https://api.groq.com` فقط (`groq.ts:9,76,156`) — وهو ما تسمح به CSP (`index.html:8`).

**هل يمكن أن يتسرّب؟ نعم، بثلاث طرق مرتّبة حسب الاحتمال:** (1) حقن XSS في أي تبعية/مسار داخل نفس الأصل يقرأ localStorage؛ (2) مسار الوكيل أعلاه (P0-1)؛ (3) إعادة ضبط النظام تحذف المفتاح لأن كل مفاتيح `faisal.*` تُمسح (`settings/index.ts:235`). لا يوجد تشفير ولا خيار «عدم الحفظ» ولا مسح عند طلب `removeKey` فقط (`ai/index.ts:243`). التوثيق داخل الواجهة صادق (`ai/strings.ts:21,57`).

## ديون تقنية

- ثلاث دوال `formatBytes` مستقلة ونصوص منفّذة: `settings/index.ts:37-43` (+`\u2066…\u2069`)، `monitor/helpers.ts:35-42`، `files/format.ts:3`، و`images/helpers.ts:50` (`formatBytesShort`) — توحيدها يقلّل انحراف التنسيق بين الشاشات.
- عدة `formatUptime`/`formatSize` متشابهة: `monitor/helpers.ts:4`، `ai/tools.ts:339-343`، `calculator/index.ts:472`.
- v86 يُحمَّل كاملاً في `terminal/backends/v86.ts:71-72`، والاستثناء في `build/pwa.ts:7` شهادة على حجم الأصول (~1.9MB في `public/`).
- لا شبكة اختبارات لسطح المكتب: لا اختبارات لـ `ai/index.ts`, `browser/index.ts`, `monitor/index.ts`, `settings/index.ts`, `store/index.ts`, `clock/index.ts` (يوجد فقط `markdown.test.ts`, `groq.test.ts`, `tools.test.ts`, `url.test.ts`, `store.test.ts`, `helpers.test.ts`, `engine.test.ts`).
- `browser/index.ts:212,352,488` `window.open(..., 'noopener,noreferrer')` صحيح، لكن الاعتماد على نوافذ حقيقية للبحث الخارجي يعني تجربة مبعثرة بين نافذتين.

## أسئلة/غموض

1. هل المتجر مقصود أن يكون «تنشيط/إخفاء» لأدوات مدمجة فقط (`apps.ts:78-143`) وليس تنزيلاً حقيقياً؟ النصوص الحالية توحي بتثبيت فعلي.
2. ما المقصود بـ `defaultInstalled: false`؟ لا يستخدمه أي manifest في النطاق (المتجر وحده يصرّح `true`).
3. هل `org.faisal.Claude` (معرّف مُبقى للتوافق) يجب أن يبقى أم يُحرَّك إلى `org.faisal.AI` مع ترحيل `apps.installState`؟
4. مصدر الحقيقة للإصدار: `package.json` (1.0.0) أم `brand/logo.ts:19` (0.1) أم `settings/index.ts:13` (0.1.0)؟
5. هل مطلوب منبّه حقيقي في الساعة (نص المتجر يعد به) أم يكفي المؤقت الحالي؟
