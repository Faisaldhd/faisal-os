# تدقيق أمني مستقل — Fai$al OS

نطاق: المستودع كامل. طريقة العمل: قراءة المصادر فقط (لا `npm`، لا تشغيل، لا تعديل على شيفرة التطبيق).
مرجع للمقارنة: `docs/SECURITY_REVIEW.md`. الحالات: ما زال مفتوحاً / أُصلح فعلاً / تغيّر التصنيف.

## تحقق من المراجعة الحالية

| # | البند | الحكم | الدليل |
| --- | --- | --- | --- |
| F1 | `...sys` spread → كل تطبيق يملك `bus`/`wm`/`apps` بلا حدود | **أُصلح فعلاً** | `src/kernel/apps.ts:177-206` كائن مجمّد؛ `scopeBus` يمنع `emit` ويُرشّح `fs:change` بالنطاق (`apps.ts:52-63`)؛ `scopeWM` يرى نوافذ التطبيق فقط (`apps.ts:66-76`)؛ `register: denied(...)` (`apps.ts:186`)؛ الاختبار `src/kernel/security.test.ts:88-99` |
| F2 | الطرفية تملك `fs:system` | **أُصلح فعلاً** | `src/apps/terminal/manifest.ts:12` = `['fs:home','fs:read-all']`؛ الفرض في النواة `apps.ts:17-46` (`canWrite` يشمل `/tmp` فقط خارج home) |
| F3 | مُنقّي أيقونات SVG بقائمة منع | **أُصلح فعلاً** | `src/shell/icon.ts:36-53` قائمة سماح للأوسام والصفات + `url()` للـ fragments فقط؛ الاختبار `security.test.ts:116-133`. تحقّقت: كل نداءات `renderIcon` تأتي من `AppManifest.icon` المدمجة (32 موضعاً)، ولا مصدر خارجي |
| F4 | تلويث prototype في `createSettings` | **أُصلح فعلاً** | `src/kernel/settings.ts:4-5,13,19,22` (null-prototype + regex + `FORBIDDEN` + `Object.hasOwn`) |
| F5 | فقدان بيانات VFS صامتاً | **أُصلح فعلاً** | `src/vfs/index.ts` + `src/vfs/storage.ts` (أخطاء `put/putMany/delete` تُرفض كـ Promise، لا `void`) |
| F6 | CSP: `frame-src 'self' blob:` و`connect-src data:` | **أُصلح ثم تراجع جزئياً** | `frame-src 'self' blob:` أُزيل، لكن صار `frame-src https:` (`index.html:8`) لتطبيق المتصفح — انظر N4 |
| F7 | تنزيل بلا نوع MIME | **أُصلح فعلاً** | `src/apps/files/index.ts:470-474` (`createObjectURL` + `a.download`) |
| O1 | كل التطبيقات في نفس realm مع النواة | **ما زال مفتوحاً — التصنيف صحيح (High معماري)** | لا عزل: لا `iframe sandbox` للتطبيقات، لا Worker. التخفيف الحقيقي الوحيد أن التسجيل ممنوع على التطبيقات (`apps.ts:186`) وأن كل التطبيقات مدمجة عبر `BUILTIN_APPS` (`src/main.ts:13,33`). **تصحيح للوصف:** v86 لا يعمل في Web Worker — لا يوجد `new Worker` في المستودع كله، ومحرّك v86 يُنشأ في خيط الصفحة (`src/apps/terminal/backends/v86.ts:70-93`). العزل موجود لكنه على مستوى المُحاكي (لا بطاقة شبكة، لا قرص — `public/v86/README.md:5`) لا على مستوى الخيط |
| O2 | Clickjacking: `frame-ancestors` لا يُضبط في `<meta>` | **ما زال مفتوحاً — التصنيف صحيح** | `index.html:7-8`؛ GitHub Pages لا يسمح بترويسات مخصّصة، فالخطر باقٍ فعلياً لا نظرياً |
| O3 | `style-src 'unsafe-inline'` | **ما زال مفتوحاً — التصنيف صحيح** | `index.html:8`؛ الاستخدام الفعلي للأنماط السطرية واسع: `src/shell/wm.ts:97-100,147,230`, `src/apps/images/index.ts:201-205`, `src/shell/screenshot.ts:99-105`, `src/apps/ai/index.ts:236` |
| O4 | `grep` يُصرّف regex على الخيط الرئيسي | **ما زال مفتوحاً — التصنيف صحيح** | `src/apps/terminal/shell/commands/text.ts` (grep) يستعمل `RegExp` متزامناً؛ لا Worker ولا مهلة → تجميد التبويب (DoS ذاتي) |
| O5 | `cat` يمرّر escape sequences إلى xterm | **ما زال مفتوحاً، لكن الخطورة أقل من المذكور** | الملفات غير مرشّحة (`src/apps/terminal/shell/commands/*`)، لكن تحقّقت من الحزمة المثبّتة: `@xterm/xterm@6.0.0` — **لا يوجد دعم OSC 52 إطلاقاً** (0 تطابق لـ `osc52`/`setOrReportSelection` في `node_modules/@xterm/xterm/lib/xterm.js`)، ولا `linkHandler` مُفعّل من التطبيق (`src/apps/terminal/index.ts:62-81`). فالمخاطر: تغيير العنوان، ألوان، مسح الشاشة، bidi/overlay للحواف — بلا سرقة حافظة |
| O6 | v86: لا شبكة، أصول محلية، لا استمرارية | **ما زال دقيقاً** | `src/apps/terminal/backends/v86.ts:62-65,143-157` + `README.md:5` |

## نتائج جديدة

| معرف | الخطورة | الوصف والدليل | سيناريو الاستغلال | أقل إصلاح آمن |
| --- | --- | --- | --- | --- |
| N1 | **P1** | تطبيق المتصفح يعطي صفحات إنترنت غير موثوقة `allow-popups-to-escape-sandbox` مع `allow-popups` و`allow-same-origin` و`allow-scripts` معاً — `src/apps/browser/index.ts:294-297`. لا قائمة سماح لنطاقات التأطير (أي `https:`)، ولا اعتراض لتنقّل الإطار | أي موقع يفتحه المستخدم داخلياً يفتح نوافذ عليا **بلا صندوق رمل** (لا `noopener`): نوافذ تصيّد بنافذة حقيقية، `blob:`/`about:blank`، وتحايل على "الرابط الخارجي" كبديل آمن. لا يستطيع الوصول لبيانات الـ OS (origin مختلف — تحقّقت: `isAllowedFrameUrl` يشترط `https:` و`origin !== self`، `src/apps/browser/url.ts:72-82`) | إسقاط `allow-popups-to-escape-sandbox` (و`allow-popups` إن أمكن)، وإضافة `onload`-guard يتحقق من `contentWindow.location` غير مقروء، وقائمة سماح نطاقات اختيارية | 
| N2 | **P1** | الوكيل الذكي يقرأ أي ملف ثم يرسل محتواه إلى Groq: `src/apps/ai/tools.ts:535-551` (read_file) + `:689-692`، والإرسال في `src/apps/ai/groq.ts:154-168`. صلاحيات التطبيق: `fs:home + fs:read-all` (`src/apps/ai/manifest.ts:12`) | **حقن أوامر غير مباشر (indirect prompt injection):** ملف داخل `/home/user` (تحميل/محتوى لصق) يكتب تعليمات للنموذج؛ النموذج ينفّذ `run_command` أو `write_file`. حاجز الحماية = `confirm` الذي يعرضه النموذج، والنص المعروض للمستخدم هو `req.detail` المولّد من الوسائط (`tools.ts:394-426`) — المستخدم يقرأ أمراً حقيقياً لا وصفاً من النموذج، وهذا جيد؛ لكن الثقة تبقى بالنموذج | وسم محتوى الملفات كبيانات غير موثوقة في رسالة `tool`، وإظهار تنبيه «محتوى ملفات» في بطاقة التأكيد، وحصر `run_command` بأوامر مسموحة عند التشغيل بالوكيل |
| N3 | **P1** | مفتاح Groq يُخزَّن في `localStorage['faisal.groq.apiKey']` (`src/apps/ai/index.ts:87,112,150,243`) — ملف اعتماد دائم بنطاق الـ OS | أي ثغرة XSS مستقبلية (أو إضافة متصفح/جهاز مشترك) تقرأ المفتاح وتستهلكه/تسرّبه. المفتاح نفسه لا يُسجّل ولا يُرسل لغير `api.groq.com` (CSP و`groq.ts:9,76,156`) | تخزين المفتاح في الذاكرة فقط أو WebCrypto غير قابل للاستخراج، أو تنبيه صريح + زر حذف (موجود: `index.ts:243`) |
| N4 | **P2** | `frame-src https:` (`index.html:8`) — أي صفحة `https` قابلة للتضمين. تراجع مقصود مقابل `frame-src 'none'` السابق، لكنه يعني أن أي HTML injection مستقبلي يفتح نطاق تأطير واسع | بدون ثغرة حقن: لا مسار استغلال. مع حقن: `iframe` إلى موقع مهاجم + `postMessage` مع استقبال ضعيف = تصعيد. `postMessage` غير مستخدم في المستودع كله (لا تطابق)، فالمسار غير قائم الآن | إبقاء `frame-src https:` لكن إضافة `frame-ancestors 'none'` عبر ترويسة عند الاستضافة، ومراقبة أي `addEventListener('message')` مستقبلي |
| N5 | **P2** | لا فحص لـ `X-Frame-Options`/`frame-ancestors` للموقع المؤطَّر، ولا كشف فشل التحميل: `src/apps/browser/index.ts:278-326` (لا معالج `error`/فشل)، فقط قائمة نطاقات محظورة يدوية (`url.ts:166-181`) | موقع يحجب التأطير يظهر فارغاً؛ ووسم «افتح في المتصفح» (`index.ts:308-312`) يقود المستخدم لفتح الموقع نفسه في تبويب حقيقي. ليس ثغرة، لكنه مسار تصيّد مريح للمهاجم: صفحة تدّعي «تم الحجب، افتح خارجياً» | عرض تنبيه ثابت أن الإطار لموقع خارجي غير موثوق، وعدم جعل «الفتح الخارجي» الإجراء الافتراضي |
| N6 | **P2** | CSP الحالي يسمح `worker-src 'self' blob:` و`connect-src 'self' blob:` بلا استخدام فعلي: لا Worker في المستودع ولا `importScripts` (لا تطابق لـ `new Worker`)، ولا `XMLHttpRequest`/`WebSocket`/`sendBeacon` | تقليل سطح الدفاع فقط؛ لا مسار استغلال قائم (لا شيء ينشئ Worker) | تضييق `worker-src 'none'` و`connect-src 'self' https://api.groq.com` (حذف `blob:`) |
| N7 | **P3** | إجراءات GitHub Actions بوسوم متحركة (`actions/checkout@v4`, `setup-node@v4`, `upload-pages-artifact@v3`, `deploy-pages@v4`) — `.github/workflows/pages.yml:21-29,42` | الاختراق المعروف لهذا النمط يكفي لتنفيذ كود في الـ CI (لا أسرار مستخدمة، لكن `id-token: write` + `pages: write` يمنحان نشر محتوى) | تثبيت بالـ commit SHA (dependabot/renovate) |
| N8 | **P3** | لا إصلاح لـ `style-src` (تكرار O3) كنقطة تنفيذية: النمط السطري يُكتب بمئات المواضع في 12 ملف واجهة | بدون حقن HTML: لا استغلال | استبدال الأنماط الحركية بمتغيّرات CSS/أصناف تدريجياً |

**بنود ذكرتها المراجعة كنتائج "Done well" — تحقّقت منها:** Markdown في `src/apps/ai/markdown.ts` **آمن فعلاً وليس آمنًا بالمصادفة**: التهريب `escapeHtml` يسبق كل إدراج (`markdown.ts:10-11,14,37`)، ورابط `[..](..)` لا يقبل إلا `https?://` مطابقة صارمة (`markdown.ts:17`)، والاستعمال الوحيد لـ `innerHTML` هو ناتج هذه الدالة (`src/apps/ai/index.ts:216,263`). اختبرت ذهنياً: `` `a" onmouseover=x` `` و`<img src=x onerror=...>` و`](javascript:...)` كلها لا تخرج من سياق النص/السند. لا ثغرة.

بقية مواضع HTML: `thead.innerHTML = ''` (`src/apps/monitor/index.ts:151`) تفريغ ثابت. `DOMParser` في `contextmenu.ts:64`, `files/icons.ts:5`, `images/toolbar-icons.ts:5`, `monitor/tab-icons.ts:5` — كلها سلاسل ثابتة مدمجة.

## الأسرار

- **لا يوجد أي مفتاح أو رمز في المستودع.** بحث شامل عن `gsk_`, `sk-`, `api[_-]?key`, `Bearer`, `secret`, `token` لم يُنتج أي قيمة حقيقية: `gsk_…` نص واجهة فقط (`src/apps/ai/index.ts:18,54`)، و`gsk_x` في اختبارات (`src/apps/ai/groq.test.ts:27,30,55`).
- **كيف يحصل التطبيق على المفتاح:** من المستخدم يدوياً في شاشة الإعداد (`src/apps/ai/index.ts:122-164`)، يُتحقق منه بـ `GET /models` قبل الحفظ (`index.ts:148`), ثم يُكتب في `localStorage['faisal.groq.apiKey']` (`index.ts:87,150`).
- **مساحة التسريب:** (1) `localStorage` على نطاق الـ OS — يُقرأ بأي كود يعمل في الصفحة (لا XSS قائم اليوم)؛ (2) المفتاح يُرسل كـ `Authorization: Bearer` حصراً إلى `https://api.groq.com/openai/v1/*` (`groq.ts:9,76,156`) وهذا مسموح صراحة في CSP (`index.html:8`).
- **مفاتيح مفاتيح قديمة تُحذف:** `faisal.claude.apiKey`, `faisal.gemini.apiKey` (`index.ts:90,110`) — سلوك جيد.
- **هل يمكن أن يتسرب سر GitHub Actions إلى الحزمة؟** لا. سير العمل لا يمرّر أي `secrets.*` ولا `env` إلى `npm run build` (`pages.yml:26-28`)، و`import.meta.env` يُستخدم مرة واحدة فقط للتحقق من `PROD` (`src/main.ts:41`)؛ لا يوجد أي `VITE_*`. لا `.env` في المستودع (بحث glob: صفر نتيجة) و`.gitignore` يتجاهل `dist/` و`node_modules/`.
- ملاحظة جانبية: استرجاع `error.message` من Groq إلى الواجهة (`index.ts:365-373`, `groq.ts:61-65`) يمرّ عبر `textContent` فقط (`index.ts:330`) — لا XSS ولا تسريب مفتاح.

## CSP: الوضع الحالي والمقترح

**الحالي (`index.html:7-8`) حرفياً:**
```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' blob: https://api.groq.com;
worker-src 'self' blob:; frame-src https:; object-src 'none'; base-uri 'none'; form-action 'none'
```
**الكافي لـ v86 فعلاً:** `script-src 'wasm-unsafe-eval'` (لـ `WebAssembly.instantiate` — `v86.ts:70-78`) و`worker-src blob:` **غير مطلوب**: v86 يُبنى في الصفحة لا في Worker (`v86.ts:77-93`)، و`fetch` الأصول يخضع لـ `connect-src 'self'` فقط (كلا الطلبين لنفس الأصل: `v86.ts:146,150`). `blob:` في `connect-src` أيضاً بلا استخدام.
**المقترح كترويسة HTTP عند الاستضافة (لا يمكن في GitHub Pages):**
`Content-Security-Policy` (نفس ما سبق، مع `frame-src https:` فقط إن أُبقي متصفح الويب، وإزالة `blob:` غير المستخدم)، `frame-ancestors 'none'` (يغلق O2 فعلياً)، `X-Content-Type-Options: nosniff`، `Referrer-Policy: no-referrer`، `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=()`، `Cross-Origin-Opener-Policy: same-origin`.
**بصراحة عن GitHub Pages:** لا يدعم ترويسات استجابة مخصصة (ولا `_headers`)؛ لذلك `frame-ancestors` و`X-Content-Type-Options` و`Permissions-Policy` **غير قابلة للتطبيق على النشر الحالي**. البدائل الواقعية: (أ) Cloudflare Pages/Netlify/Vercel مع ملف `_headers`، (ب) إضافة `<meta http-equiv="Permissions-Policy" ...>` (مدعومة فعلاً في المتصفحات) و`<meta name="referrer" content="no-referrer">` كتعويض جزئي، (ج) القبول الموثّق لمخاطر clickjacking. الوسم `<meta>` للـ CSP نفسه **يُطبَّق فعلاً** هنا.

## ما تم فحصه ولم يُعثر فيه على مشكلة

- **XSS/HTML sinks:** لم أجد أي استخدام لـ `eval`, `new Function`, `setTimeout(String)`, `document.write`, `srcdoc`, `insertAdjacentHTML`, `createContextualFragment`, أو `javascript:` URLs. الوحيدان: `innerHTML` مع `renderMarkdown` (آمن — أعلاه) و`innerHTML=''`.
- **تنفيذ ديناميكي:** كل `import()` بمعامل ثابت حرفي (`v86.ts:71-72`, `screenshot.ts:61`, `terminal/index.ts:134`)؛ لا `import()` متغيّر. لا تحميل سكربت من `blob:`.
- **إطارات/تضمين:** `url.ts` يرفض `javascript:`/`data:`/`blob:`/`file:`/`about:`/`chrome:` ويحوّل `http:` إلى `https:` (`url.ts:51-62`)، ويرفض الأصل الذاتي (`url.ts:72-82`)؛ الاختبارات `url.test.ts:49,63` تغطيها. الإطار لا يستطيع الوصول لبيانات الـ OS بسبب اختلاف الأصل (لا ثغرة `allow-same-origin+allow-scripts` هنا).
- **المسارات:** `normalize`/`resolve` (`src/kernel/path.ts:3-17`) والتحقق في `apps.ts:17-46`؛ لا طريق `..` أو بادئة (`/home/user2`) يتجاوز الفحص — مغطّى بـ `security.test.ts:25-49`.
- **الحقن في الطرفية:** `safeName` يحيّد أحرف التحكم (`shell/util.ts:46-49`)، و`stripAnsi` (`util.ts:52-55`, `tools.ts:346-347`)، واسم الملف الافتراضي `rm -rf /` محجوب في أوامر `fs.ts`.
- **حماية prototype pollution:** `settings.ts` و`apps.ts:816` (`Object.prototype.hasOwnProperty.call`) و`tools.ts:305-307` (JSON → كائن غير مصفوفة).
- **التخزين والخصوصية:** `localStorage` = إعدادات، إشارات مرجعية للمتصفح (`browser/model.ts:8-9`)، سجل إشعارات (`notifications.ts:6`)، مفتاح AI. `IndexedDB` = محتوى VFS (`vfs/storage.ts:27-28`). لا كوكيز، لا بصمة، لا قياس عن بعد. مسح `localStorage` غير موجود في الشيفرة.
- **الشبكة:** كل نداءات `fetch` أربعة وكلها متوقّعة: `api.groq.com` (نداء يبدأه المستخدم بـ «إرسال» أو التحقق من المفتاح)، وأصول v86 المحلية. لا WebSocket/EventSource/XHR/`sendBeacon`. لا طلب شبكة لا يطلقه المستخدم (باستثناء تحميل إطار المتصفح الذي يطلبه المستخدم).
- **الخدمة (Service Worker):** `build/sw-template.js` معقول: `GET` فقط، وقيود الأصل والنطاق (`sw-template.js:27-29`)، ولا تخزين لطلبات غير `basic` (`:50`); `build/pwa.ts` يحسب إصداراً من SHA-256 للمحتوى (`pwa.ts:31-36`) ولا يستبعد سوى أصول v86 الضخمة (`pwa.ts:7`). لا ترويسة `skipWaiting` قسرية.
- **سلسلة التوريد:** 4 تبعيات تشغيل (`@xterm/xterm` 6.0.0، `@xterm/addon-fit` 0.11.0، `html-to-image` 1.11.13، `v86` 0.5.462) و5 للتطوير؛ `lockfileVersion: 3` مع `integrity` sha512 لكل حزمة و`resolved` من `registry.npmjs.org` حصراً (لا `git+`/`http://`). سكربت تثبيت واحد فقط: `fsevents` (اختياري، macOS) — `package-lock.json:1105-1118`. لا اسم يشبه typosquat؛ الأسماء مطابقة للحزم الرسمية. `npm scripts` لا تحتوي `postinstall`/`prepare`.
- **الشاشة/التقاط:** `src/shell/screenshot.ts` يرسم DOM بـ `html-to-image` ولا يطلب صلاحية شاشة؛ يستبعد `IFRAME` والعناصر المخصّصة (`screenshot.ts:76`) فلا يلتقط محتوى الإطارات الخارجية؛ لا `getDisplayMedia` ولا `getUserMedia` ولا `navigator.clipboard` في المستودع كله.
- **`public/manifest.webmanifest`:** بيانات وصفية فقط، بلا صلاحيات ولا `protocol_handlers`/`share_target`.
- **`src/kernel/security.test.ts`:** الاختبارات موجودة وصحيحة البنية (92 اختباراً مُدّعى في المراجعة — لم أُشغّل `vitest` بطلب من المهمة)، وتغطي `scopeVFS`, `scopeBus`, `scopeWM`, prototype pollution، ومُنقّي SVG.
