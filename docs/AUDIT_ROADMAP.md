# خطة التدقيق والتنفيذ — Fai$al OS

**الغرض:** خطة هندسية واحدة مرتّبة بالأولوية تحوّل المشروع إلى نظام ويب شخصي سريع ومستقر ومعياري مع الحفاظ على هويته، بحيث تنفّذها جلسة لاحقة **بلا إعادة قراءة التقارير الثمانية**.
**التاريخ:** 2026 (بعد اكتمال التدقيقات الثمانية؛ `docs/SECURITY_REVIEW.md` مؤرَّخ 2026-09-23 وهو أقدم من الكود الحالي).
**الطريقة:** ثمانية تدقيقات مستقلة **قراءة فقط** (`docs/audit/{kernel,shell-wm,vfs-persistence,apps-heavy,apps-registry,mobile-a11y-css,security,build-perf}.md`) + `docs/CONTRACTS.md` + `docs/SECURITY_REVIEW.md`، ثم **تحقّق من كل بند مقابل المصدر الحالي** قبل إدراجه (التقارير كُتبت على نسخة أقدم من الكود، فبعض بنودها مُصلَح فعلاً — مُعلَّم أدناه بـ`مُصلَح`).

## خط الأساس (Baseline)

- **الاختبارات:** 273 اختباراً ناجحاً في 18 ملف `*.test.ts` (`src/kernel/security.test.ts`, `src/vfs/vfs.test.ts`, `src/shell/{wm,desktop,contextmenu,screenshot}.test.ts`, `src/apps/terminal/__tests__/{parser,lineeditor,shell}.test.ts`, وبقية ملفات التطبيقات).
- **الأنواع:** `npm run typecheck` = `tsc` نظيف (`package.json:10`) — لكن `tsconfig.json:7` يفحص `src` فقط، أي `vite.config.ts` و`build/pwa.ts` خارج الفحص.
- **البناء:** `npm run build` = `tsc && vite build` (`package.json:8`)، **126 وحدة في ~412 ms**، `base: './'`، `assetsInlineLimit: 0`، بلا `manualChunks` (`vite.config.ts:5-6`). تقسيم لكل تطبيق صحيح: 11 chunk تطبيق + shell + entry، وv86 lazy.
- **قبل أول رسم:** 4 ملفات = 173,168 B = **169.1 KiB** خام / **53.5 KiB** gzip (HTML + entry 82.9 KiB + shell chunk 55.1 KiB + CSS 29.5 KiB) — لا يوجد رسم HTML قبله.
- **قيود البيئة:** هذه البيئة لا تشغّل Vite/Vitest: `npm run build`/`npm test` يفشلان بـ `spawn EPERM` من `optimizeSafeRealPathSync` في Vite (استدعاء `net use` بـ stdio ممدود يحجبه الـ sandbox). أرقام dist من `dist/` الفعلي (53 ملفاً) ومن `build-perf.md`، وFCP/LCP **لم تُقَس** في متصفح.
- **`git log` غير متاح:** `git` ليس على `PATH`، و`.git/logs/HEAD` يحوي سجلاً واحداً (clone) — لا تُبنَ استنتاجات على تاريخ الالتزامات.

## ما هو جيد ويجب الحفاظ عليه

1. **مدير نوافذ مركزي حقيقي:** المالك الوحيد `src/shell/wm.ts`، والعقد `WindowHandle`/`WindowManager` (`src/kernel/types.ts:81-108`)، والتطبيقات محصورة في نوافذها عبر `scopeWM` (`src/kernel/apps.ts:66-76`)؛ لا `wm.open` مباشر في `src/apps/**`.
2. **صلاحيات مُنفَّذة في النواة لا في التطبيق:** `fsAccess`/`scopeVFS` (`apps.ts:17-46`)، كائنات مجمّدة بدل `...sys` (`apps.ts:215-244`)، رفض انبعاث أحداث النظام (`apps.ts:61`)، ورفض مفاتيح `apps.*` (`apps.ts:235`) — مع تغطية في `src/kernel/security.test.ts`.
3. **تحميل كسول بحواجز صحيحة:** كل كود التطبيقات عبر `import()` (`src/apps/index.ts:23-33`)، cache + reset عند الفشل (`apps.ts:144-148`)، ورسالة مخصّصة للـ chunk القديم (`apps.ts:254-255`) — لا مسار ثابت من `src/main.ts` إلى كود أي تطبيق.
4. **سياسة URL للمتصفح:** رفض `javascript:`/`data:`/`blob:` بالتحويل إلى بحث (`src/apps/browser/url.ts:51-62`)، https فقط ومنع الأصل الذاتي (`url.ts:72-82`)، قائمة نطاقات مانعة (`url.ts:166-205`)، مع اختبارات (`url.test.ts`).
5. **تنقية Markdown قبل الإدراج:** `escapeHtml` أولاً (`src/apps/ai/markdown.ts:10-18,37`)، ورابط `https?://` صارم، والاستعمال الوحيد لـ `innerHTML` هو ناتج هذه الدالة (`src/apps/ai/index.ts:216,263`) — مغطّى بـ `markdown.test.ts`.
6. **سلامة مسارات VFS:** `normalize()` واحدة مشتركة (`src/kernel/path.ts:3-11`) + فحص `within` بحدّ `/` لا `startsWith` أعمى (`apps.ts:8`)، و`..`/`/home/user2` مغطّيان (`security.test.ts:25-49`).
7. **حماية prototype pollution:** `Object.create(null)` + regex المفاتيح + `Object.hasOwn` + `FORBIDDEN` (`src/kernel/settings.ts:4-22`) مع اختباراتها.
8. **انضباط العلامة وi18n:** العربية افتراضية (`index.html:2`, `src/main.ts:19`)، وسلسلة تراجع ar → en → key (`src/kernel/i18n.ts:27`)، وتكافؤ مفاتيح ar/en كامل في النطاقات المدقّقة، وخصائص CSS منطقية (262 سطراً مقابل مخالفتين)، وعزل النصوص اللاتينية بـ`\u2066…\u2069` (`apps/settings/index.ts:42`, `apps/ai/tools.ts:86-90`).
9. **CSP صارمة موثّقة:** `default-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`، و`connect-src` محصور بـ`https://api.groq.com` (`index.html:7-8`).
10. **تفكيك نظيف للموارد في الأطراف:** الطرفية (`terminal/index.ts:167-179`: offData/offResize/offWinResize/disconnect/dispose/term.dispose)، وv86 (`backends/v86.ts:133-139`)، والصور (`images/index.ts:406-412`) — أفضل نموذج في المستودع.
11. **استمرارية الجلسة والهندسة:** `faisal.wm.geometry.v1` بتحقق حقل-بحقل ورفض القيم الفاسدة (`wm.ts:39-58`) + استعادة (`wm.ts:235-248`)، وجلسة بسقف 12 نافذة (`shell/session.ts:11-15`) مع اختبارات (`wm.test.ts:108-126`).
12. **تركيب تبعيات نظيف:** 4 تبعيات تشغيل فقط (`package.json:22-27`)، `lockfileVersion: 3` بـ`integrity`، لا `postinstall`، لا مفتاح API في الكود ولا `.env`، وكل `import()` بمعامل ثابت.

## خريطة الطريق

> كل بند سطر واحد: `ID · المسار · الدليل · خطر الإصلاح · الحالة` ثم الوصف ثم **الإصلاح**.
> الترتيب داخل كل أولوية حسب الأثر: (a) فقدان بيانات → (b) انكسار مرئي → (c) أداء → (d) صقل.
> **الحالة:** `مفتوح` = تحقّقتُ منه في المصدر الحالي · `مُصلَح` = رفعه تقرير وأُصلح فعلاً (يُبقى للتوثيق ومنع الانحدار).

### P0 — فقدان بيانات أو أمان أو منع استخدام

- **P0-1 · data-loss/security · `apps/ai/tools.ts:535-551` + `apps/ai/groq.ts:154-168` + `apps/ai/index.ts:87,150` · خطر: متوسط الاحتمال، عالٍ الأثر · مفتوح.** حقن أوامر غير مباشر: الوكيل يقرأ ملفات/صفحات غير موثوقة ويرسلها إلى Groq، والمفتاح في `localStorage`، و`read_file`/`run_command` بلا تأكيد للقراءة → تعليمات داخل ملف تكفي لتسريب أي سر يصل لمخرجات الأدوات. **الإصلاح:** وسم مخرجات الأدوات كبيانات غير موثوقة + تنقيح أنماط `gsk_[A-Za-z0-9]{20,}`/`Bearer ` + تحذير «محتوى ملفات» في بطاقة التأكيد.
- **P0-2 · app-service-worker · `build/sw-template.js:12-14` + `build/pwa.ts:33` · خطر: منخفض · مفتوح.** `cache.addAll(PRECACHE)` ذرّي: أي استجابة غير 2xx لواحد من 37 مدخلاً تُسقط `install` بالكامل فيعلق العميل على نسخة قديمة/بلا offline. **الإصلاح:** `Promise.allSettled` لكل مدخل مع تسجيل الفاشل بدل إسقاط التثبيت.
- **P0-3 · app-service-worker · `build/sw-template.js:5-6,45-52` + `src/main.ts:42-52` · خطر: منخفض · مفتوح.** تبويب طويل العمر + نشر جديد = طلب `assets/ai-<hash-قديم>.js` بعد حذفه من الخادم → 404 (cache-first بلا revalidate، ولا `skipWaiting`، فالنسخة الجديدة تنتظر إغلاق كل التبويبات). **الإصلاح:** `self.skipWaiting()` + إشعار «حدّث الآن» ينفّذ `location.reload()`.
- **P0-4 · build-PWA · `build/pwa.ts:7,29-35` · خطر: منخفض · مفتوح.** استثناء `RUNTIME_ONLY` (`v86/`, `*.wasm`, `assets/libv86-`, `sw.js`) من **حساب `VERSION`** أيضاً: ترقية v86 لا تُبطل الكاش → `libv86` قديم مع wasm جديد. **الإصلاح:** احسب الـhash من كل ملفات dist، واقتصر الاستثناء على قائمة precache.
- **P0-5 · build-PWA · `build/sw-template.js:8` مقابل `docs/SECURITY_REVIEW.md:27` و`build-perf.md:74-77` · خطر: متوسط · مفتوح (خلاف — انظر «خلافات»).** `worker-src 'self' blob:` موجودة لكن `script-src` بلا `blob:`، وlibv86 ينشئ `URL.createObjectURL(new Blob(...))` ثم `new Worker(t)` عند بناء `V86` (`apps/terminal/backends/v86.ts:70-93`). **الإصلاح:** **لا تحذف `worker-src blob:`** (سياق Linux يعتمد عليه)؛ والتضييق الآمن هو إزالة `blob:` غير المستخدم من `connect-src` في `index.html:8`.
- **P0-6 · apps:ai/apps:browser · `src/kernel/apps.ts:82` + `apps/ai/manifest.ts:12` + `apps/browser/manifest.ts:13` · خطر: منخفض · مفتوح.** `network` صلاحية مُعلنة وتُعرض للمستخدم، لكن `grep` على `src` كله لا يجد أي `permissions.includes('network')` — فلا أحد يمنع أي تطبيق من `fetch` (الحدّ الفعلي CSP فقط). **الإصلاح:** `guardFetch`/`scopeNetwork` بنمط `denied(...)` في `apps.ts`، أو إزالة `network` من `POWERFUL`/أوصاف المتجر وتوثيقها كـ«غير مُنفَّذة».
- **P0-7 · kernel/shell · `index.html:15-17` + `src/main.ts:21,34` + `src/shell/splash.ts:5,65-68` · خطر: منخفض · مفتوح.** لا شيء يُرسم قبل تنفيذ 138 KiB JS، و`await createVFS()` (فتح IndexedDB + `loadAll()` لكل العُقد) يسبق `mountShell`، و`#faisal-root` فارغ، فوقه 900 ms سبلاش إلزامية. **الإصلاح:** HTML/CSS ثابت في `index.html` (خلفية + شعار + مؤشر)، وتطبيق `data-theme` قبل الـawait، وتقليل زمن السبلاش.
- **P0-8 · apps:files · `apps/files/index.ts:215-228` + `:230-233` · خطر: منخفض · مفتوح.** الرفع يكتب `join(currentPath, sanitizeUploadName(f.name))` بلا فحص `exists` وبلا تأكيد، بخلاف مسار النسخ الذي يستخدم `uniqueName` (`files/index.ts:448,453`)، و`sanitizeUploadName` لا يعالج `..`/`\`. **الإصلاح:** `uniqueName(vfs, currentPath, …)` أو نافذة تأكيد عند الوجود.
- **P0-9 · apps:editor · `apps/editor/manifest.ts:5-12` + `apps/editor/index.ts:202-242` · خطر: منخفض · مفتوح.** لا `singleInstance` للمحرر (بخلاف `settings/ai/monitor/store`): نافذتا محرر على الملف نفسه → `save()` يكتب بلا مقارنة `mtime` فيمحو آخرُ حافظ تحريرات الآخر. **الإصلاح:** `singleInstance: true` + إعادة قراءة `mtime` قبل `save` مع تنبيه عند التغيّر.
- **P0-10 · css-a11y · `apps/files/files.css:140`, `apps/editor/editor.css:70`, `apps/images/images.css:84`, `apps/browser/browser.css:290` · خطر: منخفض · مفتوح.** `outline: none` بلا بديل `:focus-visible` ⇒ فقدان كامل لمؤشر التركيز (WCAG 2.4.7)، وتغطية `:focus-visible` كلها 3 قواعد (`theme.css:330,1019,1076`) بينما `win-btn`/`dock-btn`/`app-tile`/`topbar-btn` بلا مؤشر. **الإصلاح:** قاعدة `:focus-visible` موحّدة عبر رمز `--faisal-*` + إزالة `outline:none` العارية.

### P1 — فقدان بيانات محدود أو انكسار مرئي/وظيفي

- **P1-1 · vfs · `src/vfs/index.ts:76-79` + `:44-50` · خطر: متوسط · مفتوح.** الحفظ fire-and-forget: `await writeFile()` ينجح قبل وصول أي شيء إلى IndexedDB، و`QuotaExceededError` يظهر بعد إبلاغ الواجهة بالنجاح، والحصة تُحسب من الذاكرة، والإشعار مرة واحدة لكل الجلسة (`warned`). **الإصلاح:** طابور كتابة متسلسل يُنتظر + `flush` على `pagehide` + إشعارات مصنّفة عند أخطاء الحصة.
- **P1-2 · vfs · `src/vfs/index.ts:212-271` · خطر: متوسط · مفتوح.** `rename` غير ذرّي (الاستبدال حذف-ثم-إنشاء `:225-240`)، وفي `rename(p,p)` يُحذف السجل ويبقى في الذاكرة (`:266-270`) فيختفي الملف بعد إعادة التحميل؛ غير قابل للوصول حالياً بسبب حماية `dest===src` في التطبيقات فقط. **الإصلاح:** `if (src === dst) return;` + كتابة الهدف قبل حذف المصدر بانتظار العمليتين.
- **P1-3 · vfs · بحث `BroadcastChannel|storage` = 0 في `src` مقابل `vfs/index.ts:51-57` · خطر: متوسط · مفتوح.** لا تنسيق بين التبويبات: كل تبويب يبني خريطة مستقلة و«آخر كاتب يفوز»، وحذف في تبويب B يُبقي عُقداً يتيمة. **الإصلاح:** قفل كتابة عبر `BroadcastChannel` أو رفض الكتابة عند كشف تبويب آخر (قرار المنتج).
- **P1-4 · vfs · بحث `navigator.storage.persist` = 0 (المستخدم `estimate` فقط: `apps/settings/index.ts:216`, `apps/monitor/index.ts:357`) · خطر: منخفض · مفتوح.** التخزين best-effort وقابل للمحو الجماعي بلا أي طلب استدامة. **الإصلاح:** `navigator.storage.persist()` بعد أول إقلاع ناجح مع عرض النتيجة في الإعدادات.
- **P1-5 · vfs/apps:terminal/apps:monitor · `vfs/index.ts:22` + `apps/monitor/index.ts:53,346` + `apps/terminal/shell/commands/fs.ts:555-559` · خطر: منخفض · مفتوح.** ثلاث حقائق للحصة: 50 MB داخلي، و50 MB مصطنعة في المراقب، و`estimate` بسقف 64 GB في `df`؛ ولا رسالة quota مفهومة. **الإصلاح:** رمز حصة واحد والعرض من `estimate` موسوماً «تقديري».
- **P1-6 · kernel/apps:files · `src/kernel/apps.ts:187-192` + `apps/files/index.ts:230-233` · خطر: منخفض · مفتوح جزئياً.** فتح ملف بلا امتداد يعمل الآن (`dot > lastIndexOf('/')`)، لكن `appForFile` لا يفحص صلاحية `fs` للمطابق ولا كل التطبيقات تسجّل `opens` → قد يُطلَق تطبيق لا يقرأ الملف فيرى المستخدم `EACCES` خاماً. **الإصلاح:** ترشيح بـ`fsAccess(perms).canRead(path)` وإرجاع `undefined` عند عدم وجود قارئ.
- **P1-7 · shell · `src/shell/wm.ts:141-157` + `wm.ts:220-335` · خطر: متوسط · مفتوح جزئياً.** التركيز المرئي لا يتبعه تركيز DOM دائماً: `wm.ts:155` يمنح `el.focus()` بلا `tabindex="-1"` على الحاوية، ولا Alt+Tab، و`role=dialog` بلا `aria-modal`. **الإصلاح:** `tabindex="-1"` صريح + Alt+Tab على `wm.list()` بعد اختبار التعارض مع تركيز xterm.
- **P1-8 · shell · `wm.ts:6` مقابل `theme.css:590` + `wm.ts:144-150` · خطر: منخفض · مفتوح.** `NARROW_BREAKPOINT = 700` مكرَّر نصّياً في CSS، و`desktopShown` يُصفَّر في كل `focusWindow` (`wm.ts:150`) فيُعطِّل زر «إظهار سطح المكتب» عند أي فتح برمجي. **الإصلاح:** رمز CSS واحد للـbreakpoint، وعدم تصفير الحالة عند التركيز فقط.
- **P1-9 · shell/css-a11y · `theme.css:895,1180` + `ai/ai.css:205` + `theme.css:1200` + `monitor/monitor.css:175` · خطر: منخفض · مفتوح.** `reduced-motion` ناقص: أنيمشان لانهائيان ونبض `ai-pulse` يعملون رغم التفضيل، وانتقالات على `left/top/width/height` تُسبّب layout+paint كل إطار. **الإصلاح:** إكمال كتلة `prefers-reduced-motion` وتحويل انتقالات الالتصاق/الأشرطة إلى `transform`.
- **P1-10 · css-a11y · `apps/store/store.css:84-85,119,142-143,247-251` · خطر: منخفض · مفتوح.** بانر المتجر يكتب قيم العلامة hex بأحرف صغيرة بدل رموز `--faisal-*` ⇒ لا يتغيّر مع `data-theme` (أهم مخالف لنظام التصميم). **الإصلاح:** استبدال القيم بالرموز وإزالة تكرار منطق الوضع الداكن في `@media`.
- **P1-11 · shell/apps:settings · `src/shell/appearance.ts` (بحث `matchMedia` = صفر فيه) + `apps/settings/index.ts:172-178` · خطر: منخفض · مفتوح.** وضع السمة «النظام» لا يتبع النظام فعلاً (حذف `data-theme` فقط)، وتغيير اللغة يعيد تحميل الصفحة كاملاً بلا حاجة فنية. **الإصلاح:** مستمع `matchMedia` داخل `wireAppearance` + إعادة رسم عبر `settings:change`/`setLocale` بدل `location.reload()`.
- **P1-12 · apps:terminal · `terminal/shell/commands/text.ts:145` (+ `:132-170`) · خطر: منخفض الأثر عالٍ محلياً · مفتوح.** `grep` يبني `RegExp` متزامناً على الخيط الرئيسي بلا مهلة → نمط كارثي يجمّد التبويب ولا يمكن إيقافه بـCtrl+C. **الإصلاح:** تنفيذ `grep` في Worker مع مهلة، أو حدّ على الطول/التعقيد مع إمكانية الإلغاء.
- **P1-13 · apps:terminal · `text.ts:60-63` + `terminal/index.ts:158` · خطر: منخفض · مفتوح (خلاف OSC 52 — انظر «خلافات»).** `cat` يمرّر تسلسلات التحكم إلى xterm بلا ترشيح: لا سرقة حافظة (لا دعم OSC 52 في `@xterm/xterm@6.0.0`)، لكن انتحال الطرفية (عنوان/ألوان/مسح/bidi) ممكن. **الإصلاح:** مُرشِّح OSC/DCS لمخرج الملفات لا لمخرج الأوامر الحيّة.
- **P1-14 · apps:files · `apps/files/index.ts:561-574,588,690-708` + `files/format.ts:17` · خطر: متوسط (سلوكي) · مفتوح.** كل نقرة/سهم يعيد بناء الشبكة/القائمة كاملة بمستمعين جدد، وكل أيقونة تمرّ عبر `DOMParser`، و`new Intl.DateTimeFormat` لكل صف في كل رسم. **الإصلاح:** تفويض مستمع واحد + تبديل صنف `is-selected` فقط + ذاكرة `Intl` بمفتاح اللغة وتجميع `icon()`.
- **P1-15 · apps:files · `apps/files/index.ts:294-306` مع `:742-747` · خطر: منخفض · مفتوح.** سباق `refresh()`: استدعاءان متزامنان لا يُرتَّبان فقد يرسم الأقدم نتيجة أقدم فوق الأحدث. **الإصلاح:** `refreshToken` يُفحص بعد كل `await` (نمط `images/index.ts`).
- **P1-16 · apps:images · `apps/images/index.ts:358-364` + `:230-260` · خطر: منخفض · مفتوح.** `loadThumb` بلا token: مهمة في الطيران تكمل بعد إعادة الرسم/الإغلاق فتسجّل `objectURL` في خريطة فارغة لا يُبطَل، و`loadIndex` يكتب DOM بعد الإغلاق (`loadToken` لا يُزاد في `onClose`). **الإصلاح:** `generation` token يُفحص بعد كل `await` + `loadToken++` وإبطال `onload/onerror` في `onClose`.
- **P1-17 · apps:editor · `apps/editor/index.ts:168-172,292-310` · خطر: متوسط (سلوكي) · مفتوح.** كل ضغطة مفتاح تعيد بناء كل أسطر `gutter` وتقطع النص كاملاً وتُعيد حساب المطابقات على المستند كله، بلا سقف حجم/أسطر. **الإصلاح:** خنق (debounce) للـgutter/البحث + حدّ أعلى للأسطر وحجم الملف.
- **P1-18 · apps:terminal · `apps/terminal/index.ts:163-165` · خطر: منخفض · مفتوح.** ازدواج `fit()`: `win.onResize` و`ResizeObserver` ينادِيان `doFit()` مباشرة بلا rAF/خنق ⇒ تنفيذان في الإطار أثناء السحب. **الإصلاح:** تجميع عبر `requestAnimationFrame` واحد مشترك.
- **P1-19 · css-a11y · `theme.css:173-187,560-568` + `index.html:5` · خطر: منخفض · مفتوح.** صفر `env(safe-area-inset-*)` وغياب `viewport-fit=cover` مع `display: standalone` ⇒ الشريط العلوي والـdock يدخلان تحت notch/شريط الإيماءات. **الإصلاح:** `viewport-fit=cover` + رموز safe-area في حشوة الشريط والـdock.
- **P1-20 · css-a11y · `theme.css:330,1020` (`--faisal-accent-2: #C9982F`) · خطر: منخفض · مفتوح.** حلقة التركيز في الوضع الفاتح 2.62:1 < 3:1 المطلوب لمؤشر التركيز (WCAG 1.4.11). **الإصلاح:** رمز تركيز مخصّص داكن كفاية في الوضع الفاتح بلا تغيير هوية العلامة.
- **P1-21 · css-a11y · `apps/images/images.css:105-106` + 54 `:hover` مقابل صفر `@media (hover/pointer)` · خطر: منخفض · مفتوح.** تفاعلات غير قابلة للاكتشاف باللمس (شريط أدوات الصور يظهر بـhover فقط)، ولا نموذج جوال: صفر `@media (orientation)` ولا `100dvh/svh`، و6 تطبيقات بلا استعلام عرض. **الإصلاح:** تغليف `:hover` بـ`@media (hover: hover)` + نقطة انكسار موحّدة للـshell والتطبيقات الستة.
- **P1-22 · kernel · `src/main.ts:55-58` + `src/shell/splash.ts:7,69` · خطر: منخفض · مفتوح.** فشل الإقلاع = `document.body.textContent = 'Boot failed: …'` بلا عربية ولا زر إعادة محاولة مع كشف الخطأ الداخلي، والسبلاش يُخفى بعد `FAILSAFE_MS = 8000` حتى دون إكمال الإقلاع وبلا إشارة تقدّم. **الإصلاح:** رسالة عبر `t()` + زر `location.reload()` وإشارة تقدّم بديلة.

### P2 — أداء وجودة داخلية وتناسق

- **P2-1 · vfs · `src/vfs/index.ts:59-63,89-95,137` · خطر: متوسط · مفتوح.** كل عملية خطية: `children()`/`descendants()` تمسحان كل العقد بمُناداة `normalize` لكل عقدة، و`totalSize()` تمسح كل الملفات في كل `writeFile`، و`loadAll` يقيم الشجرة كاملة في RAM. **الإصلاح:** `Map<dir, Set<path>>` + عدّاد حجم إجمالي + تحميل البيانات عند الطلب.
- **P2-2 · vfs · `src/vfs/storage.ts:89-101,120-123` + `:71` · خطر: منخفض · مفتوح.** كتابة جزئية: أول خطأ في `putMany/deleteMany` يرفض الوعد بلا إلغاء المعاملة فتُطبَّق الطلبات الباقية، و`loadAll` يثق بالمحتوى (لا إصدار مخطط ولا تحقق) فسجل تالف = عقدة شبح. **الإصلاح:** معاملة تُلغى عند الخطأ + `schemaVersion` وتحقّق/إصلاح عند التحميل.
- **P2-3 · vfs · `src/vfs/index.ts:134,140` · خطر: منخفض · مفتوح.** تمرير المخزن بالمرجع: `data` يُخزَّن كما هو، فتعديل المستدعي للمصفوفة يغيّر المحتوى بلا تحديث `size`/`mtime` وبلا حفظ. **الإصلاح:** نسخ (`slice()`) عند الكتابة والقراءة.
- **P2-4 · vfs/apps:files · `src/vfs/index.ts:276-281` + `apps/files/index.ts:220` · خطر: منخفض · مفتوح.** `mode` زخرفي (الإنفاذ في `scopeVFS` فقط) و`chmod` بلا تحقّق مدى، والرفع ينادي `f.arrayBuffer()` قبل فحص الحجم فيُحمَّل ملف بحجم GB ثم يُرفض بـ20MB. **الإصلاح:** توثيق/إنفاذ `mode` + فحص `f.size` قبل القراءة.
- **P2-5 · apps:files · `apps/files/index.ts:508` + `files.css:257-259` · خطر: منخفض · مفتوح.** قائمة سياق الملفات على `document.body` بـ`z-index: 1000` فوق كل النوافذ ولا تتبع النافذة عند سحبها — تخالف قاعدة «الجذر هو `ctx.window.content`». **الإصلاح:** `showContextMenu` من `src/shell/contextmenu.ts` أو حاوية داخل `win.content`.
- **P2-6 · apps:files · `apps/files/index.ts:426-432,440-464` + `files/copy.ts:24-36` · خطر: منخفض · مفتوح.** لا `cancel` أثناء حذف/لصق شجرة كبيرة: الكتابة تستمر بعد إغلاق النافذة بلا واجهة. **الإصلاح:** `AbortSignal` يُلغى في `onClose` وتُفحصه حلقات النسخ/الحذف.
- **P2-7 · apps:terminal · `terminal/shell/commands/fs.ts:43,51` · خطر: منخفض · مفتوح.** `ls -l` يطبع المالك مرتين بدل مالك+مجموعة (`group` لم تُحسب في `w()`)، ولا اختبار يغطي السطر. **الإصلاح:** عمود `group` واحد + اختبار.
- **P2-8 · apps:terminal · `terminal/__tests__/memvfs.ts:76` مقابل `src/vfs/index.ts:225-240` · خطر: منخفض · مفتوح.** `memvfs` يرمي `EEXIST` عند `rename` على هدف موجود بينما VFS الحقيقي يستبدل، وبلا `bus` فلا يُصدر `fs:change` → مسارات `files/index.ts:742-747` و`images/index.ts:401-404` غير مغطاة. **الإصلاح:** مواءمة `memvfs` مع `vfs/index.ts` وإضافة `bus` مصغّر.
- **P2-9 · apps:monitor · `apps/monitor/index.ts:53,346` · خطر: منخفض · مفتوح.** حصة «50 MB» مصطنعة تُعرض بجانب تقدير حقيقي (`:357-366`) ⇒ رقمان متناقضان يقوّضان مصداقية heap/FPS. **الإصلاح:** العرض من `estimate` أو وسم الصف «تقديري» وحذف الثابت.
- **P2-10 · apps:store · `apps/store/index.ts:88,228-259` · خطر: منخفض · مفتوح.** تبويب «التحديثات» يرسم دائماً «كل التطبيقات محدَّثة» ويعرض `entry.version ?? '1.0.0'` بلا أي مقارنة إصدارات. **الإصلاح:** حذف التبويب أو وسمه «قريباً» حتى يوجد مصدر إصدارات.
- **P2-11 · kernel/shell · `src/shell/wm.ts:304,312-343` مقابل `src/kernel/apps.ts:167-186` · خطر: منخفض · مُصلَح (تحقّق).** `uninstall`/`closeWindow` كانا يستدعيان `w.close()` فيتجاوزان `setCloseGuard`؛ الكود الحالي يستخدم `requestClose()` في المسارين (`apps.ts:172-186`). **الإصلاح:** لا شيء؛ أُبقيت لمنع الانحدار + إضافة تغطية لمسار الإزالة مع تعديلات غير محفوظة.
- **P2-12 · apps:files · `apps/files/index.ts:521,752` · خطر: منخفض · مُصلَح (تحقّق).** تسريب مستمع `mousedown` على `document` عند إغلاق قائمة السياق أُصلح فعلاً داخل `closeMenu()`. **الإصلاح:** لا شيء؛ يُبقى مغطّى باختبار.
- **P2-13 · shell/kernel · `src/shell/index.ts:28-48` + `src/shell/wm.ts:542-576` + `mountDock/mountOverview/mountTopbar` بلا `dispose` · خطر: منخفض · مفتوح.** مستمعو `keydown` العامّون يعملون فوق أي عنصر (لا فحص `ev.target`/`isComposing`) فقد يبتلعون مفاتيح داخل `input`/`textarea`، ولا `dispose()` مُعاد من الأجبال (مقابل `Desktop.dispose` في `desktop.ts:322`). **الإصلاح:** تجاهل الحدث عند `input/textarea/contenteditable`/`isComposing` وإرجاع `dispose()` من كل جبل.
- **P2-14 · shell · `src/shell/dock.ts:22-56,65-66` + `wm.ts:141-157` · خطر: متوسط (سلوكي) · مفتوح.** `dock.render` تُفرّغ الشريط وتعيد إنشاء كل الأزرار وأيقونات SVG في كل `window:focus`/`window:change`، والحدث يُطلق حتى لو لم يتغيّر التركيز. **الإصلاح:** عدم الإطلاق عند `focusedId === id` والتحديث تزايدياً.
- **P2-15 · build-PWA · `build/sw-template.js:12-14` + `src/main.ts:36` · خطر: منخفض · مفتوح.** الـprecache ينزّل 35 مدخلاً (772.8 KiB) بعد أول رسم فينافس أول تفاعل على شبكة بطيئة. **الإصلاح:** precache للـshell فقط وترك الـapp chunks للـruntime cache الموجود (`sw-template.js:46-52`).
- **P2-16 · build-PWA/apps:terminal · `apps/terminal/index.ts:134` + `__vite__mapDeps` في `dist/terminal-*.js` (`build-perf.md:50`) · خطر: متوسط (كبر الحزمة) · مفتوح.** فتح Terminal يُحمِّل libv86 استباقياً (91.9 KiB gzip) حتى لو بقي المستخدم على الصدفة المحلية. **الإصلاح:** `manualChunks` يفصل `v86` عن `terminal` chunk مع فحص أن التقسيم الكسول سليم بعد البناء.
- **P2-17 · css-a11y · `theme.css:139-147,151-162,180,355,397,575,517,557,1032` · خطر: منخفض · مفتوح.** تكلفة دائمة: خلفية الجدار 5 طبقات مع `background-blend-mode`، و`backdrop-filter` على 4-5 أسطح (`blur(28px)` في overview)، و7 `drop-shadow` على أيقونات بالمئات. **الإصلاح:** إسقاط `background-blend-mode` والطبقة الثانية، و`drop-shadow` على مستوى الأيقونة، و`contain: paint` لشبكة الأيقونات، وحصر `backdrop-filter` بالسطح العلوي تحت `(pointer: coarse)`.
- **P2-18 · css-a11y · `theme.css:669-670,699,702,310,1071` + `clock.css:232` + `store.css:376` + `images.css:27-28` + `browser.css:102-103,297-298` · خطر: منخفض · مفتوح.** أهداف لمسية < 44px في الـshell (حتى **6px** لمقابض التحجيم) وفي 4 تطبيقات. **الإصلاح:** توسيع المناطق إلى 44px أو hit-slop غير مرئي (`::after`) بلا تغيير الشكل.
- **P2-19 · css-a11y · `apps/browser/browser.css:41,277` · خطر: منخفض · مفتوح.** مخالفتان حقيقيتان للخصائص المنطقية: حشوة غير متناظرة تثبت مع `dir` ⇒ زر إغلاق التبويب وشريط بحث الصفحة في الجهة الخطأ. **الإصلاح:** `padding-inline` بدل `padding` الرباعي.
- **P2-20 · css-a11y · `theme.css:8-60` + `store.css` (9 hex/18 rgba) + `monitor.css:16,81,85,123` وغيرها · خطر: منخفض · مفتوح.** فجوات مركزية التصميم: لا رموز لـspacing/shadows/typography/z-index (قيم z من 1 إلى 99999)، و41 hex صريح + 111 `rgba()` خارج النظام، واحتياطيات الوضع الفاتح داخل ملفات داكنة، وأصناف عارية تخالف `BRAND.md:36` (`ai.css:9,40,173`, `theme.css:1248`). **الإصلاح:** توسيع كتلة الرموز، وبادئة `faisal-<app>-` للأصناف، وإسقاط الاحتياطيات الفاتحة.
- **P2-21 · css-a11y · صفر `role=` في 7 تطبيقات؛ `aria-live` في `notifications.ts:61` و`ai/index.ts:197` فقط · خطر: منخفض · مفتوح.** تبويبات المتصفح بلا `role="tablist"`، وشبكة الساعة بلا `role="grid"`، ونتائج الحاسبة/الطرفية/المراقب صامتة لقارئ الشاشة. **الإصلاح:** أدوار ARIA الدنيا + `aria-live="polite"` لمناطق النتائج.
- **P2-22 · kernel/build · `vite.config.ts:8` + `tsconfig.json:7` + `package.json:8` · خطر: منخفض · مفتوح.** `test: {…} as any` يُلغي فحص أنواع الإعداد، و`tsconfig` يفحص `src` فقط فيترك `vite.config.ts` و`build/pwa.ts` خارج `typecheck`، و`skipLibCheck: true` يخفي تعارضات التعريفات. **الإصلاح:** `defineConfig` من `vitest/config` + `include: ["src","build","vite.config.ts"]`.
- **P2-23 · docs/kernel/security · `docs/SECURITY_REVIEW.md:4,27,36` مقابل الكود الحالي · خطر: منخفض · مفتوح.** سجل التدقيق قديم (92 اختباراً و11 تطبيقاً مقابل 273 اختباراً الآن)، وادعاؤه المطلق «No innerHTML anywhere» يخالف `ai/index.ts:216,263`، وقوله إن `worker-src blob:` غير مطلوب يخالفه تقرير البناء. **الإصلاح:** تحديث السجل بالأرقام الحالية وتصحيح الادعاءين مع الإشارة إلى هذا المستند.

### P3 — صقل وقابلية صيانة

- **P3-1 · docs/build · لا `README.md` في الجذر (glob: لا نتيجة خارج `node_modules`/`public/v86`) · خطر: منخفض · مفتوح.** لا README ولا lint config ولا `.editorconfig` ولا `LICENSE` (المعلن في `package.json:14` فقط) ولا `engines`، و`.gitignore` لا يتضمن `.npm-cache/` الموجود فعلاً. **الإصلاح:** README قصير (التشغيل، البنية، القيود المعروفة، سياسة النشر) + `engines` + سطر `.npm-cache/`.
- **P3-2 · build · `public/v86/src/*` (`kernel.config` 40 KB, build.sh, rootfs) داخل `dist` · خطر: منخفض · مفتوح.** ملفات بناء v86 تُنشر على الإنترنت: ضوضاء وحجم بلا فائدة للمستخدم. **الإصلاح:** نقلها خارج `public/` أو استثناؤها في البناء.
- **P3-3 · build-PWA/CI · `.github/workflows/pages.yml:21-29,42` + لا خطوة typecheck مستقلة ولا smoke test · خطر: منخفض · مفتوح.** الإجراءات مثبتة بوسوم رئيسية (`@v4`/`@v3`)، ولا تحقق من `dist/sw.js` أو أن `__PRECACHE__`/`__VERSION__` استُبدلا (نشر `sw.js` بـ`__VERSION__` حرفياً ينجح بنجاح أخضر). **الإصلاح:** تثبيت بالـSHA + خطوة smoke تفحص عدم بقاء `__VERSION__` في `dist/sw.js`.
- **P3-4 · css-a11y · `index.html:10` + `manifest.webmanifest` · خطر: منخفض · مفتوح.** `theme-color` واحد `#16264F` لا يتبع الوضع الداكن، ولا `<noscript>` ولا landmarks في `index.html`. **الإصلاح:** وسما `theme-color` بـ`media="(prefers-color-scheme: …)"` + `<noscript>`.
- **P3-5 · shell · `src/shell/theme.css:404-406` + `overview.ts:136-144,180` · خطر: منخفض · مفتوح.** `.faisal-overview` المغلق بـ`opacity:0;pointer-events:none` بلا `inert`/`aria-hidden` ⇒ عناصره تُبقى قابلة للتركيز بالتاب. **الإصلاح:** `inert`/`aria-hidden` عند الإغلاق.
- **P3-6 · shell · `src/shell/desktop.ts:230` (`_wm` مُتجاهَل) + `theme.css:994` · خطر: منخفض · مفتوح.** سطح المكتب لا يتحرك حقيقياً: التحديد والأيقونات مستقلّة عن حالة النوافذ، والترتيب أبجدي فقط بلا موضع محفوظ، وشبكة `repeat(auto-fill, 96px)` لا تنعكس في RTL. **الإصلاح:** تمرير `_wm` فعلياً لتمييز المفتوح + `justify-content` منطقي.
- **P3-7 · apps:registry/settings · `apps/settings/index.ts:13,235,239,290` + `brand/logo.ts:19` + `package.json:2` · خطر: منخفض · مفتوح.** ثلاث قيم إصدار مختلفة (`0.1`/`0.1.0`/`1.0.0`)، ومفتاحا ترجمة ميتان (`settings.about.version`, `store.coreBadge`)، و«إعادة الضبط» لا يُلغي الـservice worker ولا `CacheStorage`. **الإصلاح:** مصدر إصدار واحد + حذف المفاتيح الميتة + `caches.delete` وإلغاء التسجيل في إعادة الضبط.
- **P3-8 · apps:terminal/apps:files/apps:images · `terminal/shell/commands/fs.ts:257-269` مقابل `files/copy.ts:24-36` + `images/helpers.ts:26-39` غير مستعملة · خطر: منخفض · مفتوح.** كود مكرر موثّق: `promptDialog`/`confirmDialog`، `errorMessage`، `icon()` عبر `DOMParser`، `copyRecursive`/`copyTree`، `naturalCompare`، تهيئة البايت، وخرائط الامتدادات؛ ومساعدات `images/helpers.ts` مُختبَرة لكنها غير مستعملة → ثقة زائفة. **الإصلاح:** توحيدها في `src/kernel/ui/*` و`src/kernel/vfs-extra.ts` واستخدام المساعدات المختبَرة فعلاً.
- **P3-9 · apps:clock/apps:browser · `apps/clock/index.ts:617-626,62-73` + `apps/browser/index.ts:278-326` · خطر: منخفض · مفتوح.** مؤقتات الساعة الثلاثة تعمل رغم إخفاء النافذة ولا تُحفظ عند الإغلاق، ولا منبّه حقيقي رغم وعد نص المتجر، وفشل تأطير الموقع يظهر إطاراً فارغاً مع تلميح بعد 1400ms بدل رسالة مباشرة. **الإصلاح:** إيقاف/استعادة المؤقتات عند `window:change` وحفظها + رسالة فورية عند فشل الإطار.
- **P3-10 · css-a11y · `store.css:78-93,129-136` + `monitor.css:100` + `clock.css:210-233` · خطر: منخفض · مفتوح.** بطاقة بانر المتجر 3 أعمدة ووصف بـ`white-space: nowrap` ⇒ قصّ نص على 320px، وجدول المراقب بلا التفاف، وشبكة الساعة `repeat(7,1fr)` بخلايا 36px. **الإصلاح:** نقاط انكسار للتطبيقات الثلاثة وحد لمس موحّد.

## ما لا يجب فعله (Guardrails)

1. **لا إعادة كتابة معمارية:** العقد (`src/kernel/types.ts`) وكائن القدرات هما الأساس؛ تغييرهما عبر مالك kernel وبطلب في `docs/requests/<track>.md` فقط (`docs/CONTRACTS.md:1-4`).
2. **لا استبدال لمدير النوافذ:** `src/shell/wm.ts` هو المالك الوحيد؛ لا نقل لمسؤولياته إلى التطبيقات ولا استبداله بمكتبة ولا استخدام WM المتصفح الأصلي.
3. **لا تبعيات جديدة:** لا حزم npm إضافية إلا لـTrack C في نطاق v86 حسب `docs/CONTRACTS.md:19`؛ لا framework، لا مكتبة UI، لا محلل Markdown خارجي.
4. **لا إزالة ميزة تعمل:** كل بند `مُصلَح` وميزة قائمة تبقى؛ أي تبديل سلوك يحتاج قرار المالك.
5. **لا مؤثرات بصرية على حساب الأداء:** لا `backdrop-filter`/`filter`/حركات جديدة على سطح متكرر، وأي إضافة تُقاس أولاً وتُبنى من كتلة الرموز فقط.
6. **لا اختلاق قدرات للمتصفح:** لا `navigator.*` غير موجودة، ولا `env()` بلا `viewport-fit=cover`، ولا وعود PWA غير مدعومة؛ وما لا يُقاس يُعلَّم «لم يُقَس» أو «تقديري» في الواجهة.
7. **الحفاظ على نشر GitHub Pages:** `base: './'` (`vite.config.ts:5`) والمسارات النسبية (`index.html:11-12`, `manifest.webmanifest`) وسجل `sw.js` `./` — أي تعديل يبقى صالحاً تحت مسار فرعي.
8. **لا دفع كود غير مُختبر إلى `main`:** بوابة الالتزام = `npm run typecheck` + `npm test` + `npm run build` (في بيئة تسمح بتشغيل Vite/Vitest) + فحص `dist/sw.js`؛ و`main` ينشر تلقائياً (`pages.yml`).

## ترتيب التنفيذ المقترح

بوابة كل دفعة = `npm run typecheck` + `npm test` (+ `npm run build` وفحص `dist` في ما يلمس البناء/PWA). التراجع محصور في ملفات مسار واحد كما في جدول الملكية، فالرجوع = `git checkout --` على ملفات الدفعة.

1. **حارس بيانات VFS (P1-1, P1-2, P2-3):** طابور كتابة + `if (src===dst) return` + نسخ البيانات. البوابة: `vfs.test.ts` + اختباران جديدان (`rename(p,p)`، ترتيب الحفظ). التراجع: `src/vfs/index.ts`.
2. **إقلاع مرئي (P0-7, P1-22):** HTML/CSS ثابت في `index.html` + theme قبل الـawait + رسالة فشل عبر `t()`. البوابة: `npm run build` وفتح `dist/index.html`. التراجع: `index.html`, `src/main.ts`.
3. **PWA لا يعلق (P0-2, P0-3, P0-4, P2-15):** `allSettled` + `skipWaiting` + إشعار «حدّث الآن» + hash من كل الملفات + precache للـshell. البوابة: `npm run build` وفحص `dist/sw.js`. التراجع: `build/sw-template.js`, `build/pwa.ts`.
4. **CSP و`network` (P0-5, P0-6):** إزالة `blob:` من `connect-src` فقط + البتّ في `network`. البوابة: `typecheck` + `security.test.ts` + تشغيل Linux فعلياً للتأكد من سلامة الـblob Worker. التراجع: `index.html` / `src/kernel/apps.ts`.
5. **أمان الوكيل (P0-1):** redaction + وسم محتوى غير موثوق + تحذير في بطاقة التأكيد. البوابة: `ai/tools.test.ts` + `markdown.test.ts` + اختبار redaction. التراجع: `src/apps/ai/*`.
6. **سلامة الأطراف (P0-8, P0-9, P1-6, P1-15, P1-16, P1-17, P1-18, P2-6):** `uniqueName` للرفع، `singleInstance` + `mtime` للمحرر، tokens للصور/الملفات، خنق المحرر، rAF للطرفية، `AbortSignal` للنسخ. البوابة: `npm test` + أول اختبارات في `apps/files`/`apps/editor` (فجوة مؤكدة). التراجع: لكل تطبيق ملفاته.
7. **وصولية وتركيز (P0-10, P1-7, P1-9, P1-20, P2-13, P3-5):** `:focus-visible` موحّد، رمز تركيز متباين، `reduced-motion` كامل، فحص هدف الاختصارات، `dispose()` للأجبال، `inert` للـoverview. البوابة: `npm test` + فحص يدوي بالكيبورد. التراجع: `theme.css` + `src/shell/*`.
8. **جوال وRTL (P1-19, P1-21, P2-18, P2-19, P3-10):** `viewport-fit=cover` + `env()` + `@media (hover)` + أهداف 44px + `padding-inline`. البوابة: `npm run build` + فحص 320px وRTL/LTR. التراجع: CSS فقط.
9. **أداء البيانات (P2-1, P2-2):** فهرسة الأبناء + عدّاد الحجم + تحميل عند الطلب + `schemaVersion`. البوابة: `vfs.test.ts` + اختبار 10k عقدة + `npm run build`. التراجع: `src/vfs/*`.
10. **أداء البناء والتقسيم (P2-16, P2-22):** `manualChunks` لفصل v86 + إزالة `as any` + توسيع `tsconfig`. البوابة: `npm run build` + مقارنة أحجام `dist` + `typecheck`. التراجع: `vite.config.ts`/`tsconfig.json`.
11. **CSS وتوحيد الأدوات (P1-10, P2-17, P2-20, P3-8):** رموز المتجر، إسقاط `background-blend-mode`، توسيع الرموز، توحيد المكرر. البوابة: `npm test` + فحص بصري للوضعين. التراجع: ملفات CSS/المساعدات.
12. **صدق الواجهة والصيانة (P2-9, P2-10, P3-1, P3-3, P3-6, P3-7, P3-9):** حذف الحصة الوهمية/تبويب التحديثات، README، smoke test في CI، مصدر إصدار واحد، مؤقتات الساعة. البوابة: `npm test` + `npm run build`. التراجع: ملفات مستقلة.

## خريطة الملفات → مسار المالك (من `docs/CONTRACTS.md`)

| المنطقة | المالك/المسار | ملاحظة التزامن |
| --- | --- | --- |
| `src/kernel/**`, `src/main.ts`, `index.html`, `package.json`, `vite.config.ts` | kernel | `types.ts` لا يعدّله غير المالك؛ الطلبات في `docs/requests/<track>.md` |
| `src/shell/**`, `src/apps/settings/**` | A: Shell | يملك الهيكل والسمات والإعدادات ولا يلمس `src/vfs/**` |
| `src/vfs/**`, `src/apps/files/**`, `src/apps/editor/**` | B: Files | يملك المخزن وتطبيقي الملفات والمحرر |
| `src/apps/terminal/**`, `public/v86/**` | C: Terminal | المسار الوحيد المسموح له بتبعيات v86 |
| `src/apps/{ai,browser,calculator,clock,images,monitor,store}/**`, `src/brand/**` | غير مسمّى في `docs/CONTRACTS.md` | تنسيق مباشر مع مالك kernel لأي تغيير في `apps.ts`/types؛ أضف مساراً في العقد قبل العمل المتوازي |
| `build/**`, `.github/workflows/**` | kernel فعلياً | أي تغيير في الـSW/CI يمرّ بمراجعة واحدة لتفادي تعارض النشر |

## خلافات بين التقارير وكيف حُسمت

- **v86 في Worker أم لا:** `security.md:17,58` يقول إن v86 يُبنى في خيط الصفحة و`worker-src blob:` غير مطلوب، بينما `build-perf.md:74-77` يقول إن libv86 ينشئ blob Worker. **الدليل يدعم `build-perf`:** libv86 ينشئ `URL.createObjectURL(new Blob(...))` ثم `new Worker(t)` في مسار `register_yield` المُنادى عند بناء `V86` (`apps/terminal/backends/v86.ts:70-93`) — لذلك يبقى `worker-src blob:` ويُضيّق `connect-src` فقط.
- **OSC 52:** `docs/SECURITY_REVIEW.md:26` يذكره كخطر، و`security.md:21` يقول إن الحزمة المثبّتة لا تدعمه. **الدليل يدعم `security.md`** (لا مطابقة `osc52`/`setOrReportSelection` في `@xterm/xterm@6.0.0` ولا `linkHandler` مُفعّل)، فخُفِّض إلى P1 لانتحال الطرفية لا لسرقة الحافظة.
- **فقدان VFS الصامت:** `security.md:14` يعلن «أُصلح فعلاً» و`vfs-persistence.md:18` يعلنه «فقداً صامتاً». **كلاهما صحيح جزئياً:** الإشعار موجود و`put/delete` تُعيد Promise مرفوضة (مُصلَح)، لكن الكتابة غير مُنتظرة والحصة تُحسب من الذاكرة (مفتوح) — لذلك البند P1-1 لا P0.
- **حالة البنود مقابل الكود الحالي:** التقارير كُتبت على نسخة أقدم؛ تحقّقتُ من المصدر فسجّلتُها `مُصلَح`: `appForFile` بلا امتداد (`apps.ts:187-192`)، تجاوز حارس الإغلاق (`apps.ts:172-186`)، تسريب مستمع قائمة سياق الملفات (`files/index.ts:521,752`)، انعكاس تحجيم RTL (`wm.ts:472-475`)، لوحة الإشعارات بلا إدارة تركيز (`notifications.ts:182-259`)، تسريب محاكي v86 عند الإغلاق (`terminal/index.ts:117,137-156`)، ومزامنة إشعار عدم الدوام مع `system:ready` (`vfs/index.ts:42-49`).
- **عدد الاختبارات:** `docs/SECURITY_REVIEW.md:4` يذكر 92؛ خط الأساس الحالي 273 في 18 ملفاً، والعدد النهائي يحتاج بيئة تشغيل أوسع (`spawn EPERM` هنا).

## أسئلة مفتوحة (قرارات لمالك المشروع)

1. **`network`:** إنفاذ حقيقي (`guardFetch`) أم ميزة موثّقة كـ«غير مُنفَّذة» تُزال من العرض؟ **الافتراضي:** إزالتها من `POWERFUL`/أوصاف المتجر الآن، والإنفاذ لاحقاً.
2. **تعدد التبويبات:** آخر كاتب يفوز، أم رفض الكتابة عند كشف تبويب آخر، أم قفل `BroadcastChannel`؟ **الافتراضي:** قفل كتابة مع إشعار، والقراءة حرة.
3. **private mode:** السقوط للذاكرة مع إشعار، أم قراءة فقط، أم رفض الإقلاع؟ **الافتراضي:** السقوط مع إشعار صريح (الموجود) + عرض الحالة في الإعدادات.
4. **الحصة:** هل 50 MB ضمانة منتج أم حارس ناعم، وأي رقم يُعرض عند الرفض؟ **الافتراضي:** حارس داخلي، والعرض من `navigator.storage.estimate` موسوماً «تقديري».
5. **`navigator.storage.persist()`:** هل يُطلب قبل الوثوق ببيانات المستخدم؟ **الافتراضي:** نعم بعد أول إقلاع ناجح، مع تسجيل النتيجة في الإعدادات.
6. **`mode` في VFS:** يُنفَّذ داخل VFS ويرمي `EACCES`، أم يبقى في `scopeVFS` فقط؟ **الافتراضي:** يبقى في `scopeVFS` ويُوثَّق `mode` كعرض فقط (أقل خطر انحدار).
7. **الجوال:** هدف إطلاق أم «يعمل بالصدفة»، وعلى الجوال نافذة كاملة أم شبكة نوافذ مصغّرة؟ **الافتراضي:** نافذة كاملة على `(max-width: 700px)` بنقطة انكسار موحّدة، والمانيفست `standalone` يبقى.
8. **حد اللمس:** 44px إلزامي أم 36-40px مع hit-slop؟ **الافتراضي:** 44px للأزرار الأساسية وhit-slop للمقابض الرقيقة.
9. **`singleInstance`:** للمحرر فقط أم للطرفية أيضاً؟ **الافتراضي:** المحرر فقط؛ تعدد الطرفيات ميزة مقصودة.
10. **تحديث الـSW:** إشعار فقط (بلا فقدان جلسة) أم `skipWaiting` + زر «حدّث الآن»؟ **الافتراضي:** `skipWaiting` + زر صريح (P0-3) بلا `reload` تلقائي.
11. **`v86/src/*` و`RUNTIME_ONLY`:** إبقاؤها في النشر أم استثناؤها، وهل تُدخل في الـhash؟ **الافتراضي:** إزالتها من `public/`، وhash من كل ملفات dist (P0-4).
12. **نافذتان لنفس التطبيق:** هل تُحفظ الهندسة بـ`windowId` بدل `appId` (`wm.ts:124-132`)؟ **الافتراضي:** نعم لاحقاً في مسار Shell بعد إصلاحات التركيز.
13. **مصدر الحقيقة للإصدار:** `package.json` (1.0.0) أم `brand/logo.ts:19` (0.1) أم `settings/index.ts:13` (0.1.0)؟ **الافتراضي:** `package.json` مع حقن القيمة في البناء.
14. **الاستمرارية الناقصة** (آخر مجلد، cwd، محادثة AI، «غير المقروء»، سجل الحاسبة، منبّه حقيقي): أيّها للمرحلة القادمة؟ **الافتراضي:** «آخر مجلد + cwd + غير المقروء» أولاً، والمنبّه لاحقاً مع تصحيح نص المتجر.
15. **الأسرار:** مفتاح Groq في `localStorage` مع تنبيه، أم الذاكرة فقط، أم WebCrypto؟ **الافتراضي:** الذاكرة افتراضياً + خيار «احفظ على هذا الجهاز» صريحاً.
16. **مسارات غير مسمّاة في `docs/CONTRACTS.md`:** هل تُضاف مسارات ai/browser/images/monitor/store قبل العمل المتوازي؟ **الافتراضي:** نعم، سطر لكل مسار لمنع تعارض الملفات.

## سجل التقدّم (يُحدَّث في كل جولة تنفيذ)

الفرع `audit/stability-pass`، والـPR رقم 14. كل بند أدناه تحقّق فعليًا بـ`npm run typecheck` + `npm test` + `npm run build`، والتحقق البصري بلقطات شاشة حقيقية.

**الجولة 1 — التدقيق + إصلاحات P0/P1:**
`requestClose()` في العقد واستخدامه من `uninstall`/`closeWindow` · رفض `rename(p, p)` مع اختبار انحدار · إعلان التخزين غير الدائم · عدم استبدال الملف المرفوع صامتًا · مثيل واحد للمحرّر مع كشف التغيّر الخارجي · إصلاح تسريب محاكي v86 عند الإغلاق · قلب التحجيم في RTL · تركيز DOM يتبع النافذة · `Tab` داخل مركز الإشعارات · عدم إبلاغ 0×0 عند التصغير · عدم ابتلاع مفاتيح الحقول · مطابقة الاختصارات بـ`key` أو `code` · `allSettled` بدل `addAll` في الـSW + إدخال أصول v86 في الـhash · شاشة إقلاع ثابتة · إزالة الأرقام المُختلقة (الحصة/الإصدار/0 B) · عناصر الهوية البصرية والوصولية (مناطق آمنة، حلقات تركيز، reduced motion، مخالفتا RTL).

**الجولة 2 — الأداء وPhase 5/8:**
P0-1 منجَز: `lazyVFS` يجعل الـshell يُركَّب دون انتظار IndexedDB، و`system:ready` يبقى بعد فتح المخزن كي لا يضيع إشعار التخزين غير الدائم (اختباران جديدان) · تقصير ثبات السبلاش من 900ms إلى 300ms ومن المهلة الاحتياطية 8000 إلى 4000 · شاشة فشل إقلاع مترجَمة مع زر إعادة محاولة بدل نص إنجليزي خام · `Ctrl+Alt+Tab` للتبديل بين النوافذ (بديل يعمل فعلًا لـAlt+Tab الذي لا يصل للصفحة) مع منطق قابل للاختبار في `src/shell/keys.ts` واختباراته · إزالة قواعد CSS ميتة من المتجر (مع لونين صريحين كان التدقيق قد رصدهما) · توثيق العقود الجديدة في `docs/CONTRACTS.md`.

**الجولة 3 — مزوّد ثانٍ للذكاء الاصطناعي (طلب المالك) + استقرار بيئة التطوير:**
- **DeepSeek كمزوّد إضافي داخل Faisal AI** إلى جانب GroqCloud: `src/apps/ai/providers.ts` سجل واحد لكل ما يختلف بين المزوّدين (قاعدة الـAPI، المضيف، مخزن المفاتيح، قوائم الموديلات، قواعد القدرات)، و`src/apps/ai/chat.ts` عميل OpenAI-compatible معمَّم بدل `groq.ts`. **Groq لم يتغيّر**: مفاتيح التخزين `faisal.groq.apiKey`/`faisal.groq.model` كما هي (اختبار صريح للتوافق الرجعي)، وجسم طلبه مطابق بايتًا ببايت.
- تفاصيل DeepSeek تحقّقت من المصادر الرسمية لا من الافتراض: `base_url = https://api.deepseek.com` (بلا `/v1`)، الموديلات `deepseek-flash` و`deepseek-v4-pro`، و`GET /models` بنفس شكل OpenAI (فيتحقق المفتاح ويعرض القائمة الحقيقية، والقائمة الثابتة احتياطية فقط).
- **خلل بروتوكولي حقيقي أُصلح قبل الشحن**: وضع التفكير في DeepSeek مُفعَّل افتراضيًا، وفي أي طلب يحمل `tools` يجب إرجاع `reasoning_content` كاملًا وإلا 400. العميل الآن يحتفظ به ويُرجعه للمزوّد الذي يطلبه فقط (`Provider.echoesReasoning`)، ولا يظهر أبدًا كنص إجابة ولا في المصادر. بدونه كان وضع الوكيل مع DeepSeek يفشل.
- صدق القدرات: لا بحث ويب من جواربنا — فقط موديلات `groq/compound*` تبحث على خوادم Groq وتُرجع مصادر؛ وعند اختيار DeepSeek تقول الواجهة والنظام صراحةً إن لا بحث، بدل التظاهر. والخيارات في المنتقي موسومة: «(يبحث في الويب)» و«(وكيل)».
- CSP: مضيف واحد إضافي فقط (`api.deepseek.com`) مع تحديث التعليق العربي، وتوثيق أمني يذكر المخاطرة نفسها للمفتاحين وحدود المراجعة (بلا مفتاح حقيقي).
- **استقرار بيئة التطوير**: السبب الجذري لانهيار خادم Vite المتكرر هو أن أدوات التحرير تكتب ذرّيًا عبر مجلد مؤقت داخل `src/`، فيسقط المراقب بـ`EBUSY` ويُقتل الخادم — أُصلح في `vite.config.ts` بتجاهل ملفات التحرير المؤقتة. وإزالة كود ميت (ثابت `ICON` في الطرفية، وحالة `lastResult` في الحاسبة مع `void` الذي كان يُسكتها).

**حالة الدمج (بعد الجولة 3):** `#14` و`#15` و`#16` (DeepSeek) و`#17` (أقسام الإعدادات + مدخلات `~/Desktop`) مدموجة في `main` ومنشورة على GitHub Pages، والتحقق من الإنتاج بعد كل دمج أعطى صفر أخطاء console. `main` عندئذ: 21 ملف اختبار / 361 اختبارًا.

**الجولة 4-6 — Phase 6: نموذج جوال حقيقي (PR #18):**
- `src/shell/device.ts` (جديد): السياسة في مكان واحد — `NARROW_BREAKPOINT` مصدر وحيد لقيمة 700 (كانت مكرّرة بين `wm.ts` وCSS)، ودالة **نقية** `shouldFillScreen({width, coarse})`، و`watchPointerKind` بإلغاء اشتراك، ووصول محروس إلى `matchMedia` (لا يرمي في jsdom).
- `wm.ts`: النافذة تملأ السطح على سطح ضيق **أو** مؤشر خشن، و**صفر مقابض تحجيم** تُنشأ على اللمس (كانت 8)، ورفض التحجيم كشبكة أمان، وإعادة تخطيط عند تغيّر الحجم/الاتجاه/نوع المؤشر. سلوك سطح المكتب (مؤشر دقيق + عرض واسع) مطابق تمامًا لما كان.
- `theme.css`: `100dvh` مع احتياطي، و`overflow-x: clip`، وقسم `(pointer: coarse)` يرفع عناصر التحكم الحقيقية إلى ≥44px، وإعادة تدفّق للبحث وشبكة التطبيقات ومركز الإشعارات، وتقليمات للوضع الأفقي. والـdock لم يعد يقتطع أيقونة (الحشوة نُقلت إلى شريط التمرير + `overscroll-behavior-x: contain` + شريط تمرير مخفي).
- أزرار النافذة تبقى 26px مرسومة (ثلاثة أزرار لا تتّسع لـ44px في شريط 38px) مع **منطقة نقر غير مرئية 36×44** على اللمس.
- القياس الفعلي على البناء الإنتاجي بجهاز لمسي مُحاكى: مقابض = 0، النافذة ممتلئة في الوضعين الطولي (390×844) والأفقي (844×390 — عريض لكنه لمس)، صفر فائض أفقي، كل أيقونات الـdock قابلة للوصول (التمرير مُثبت وظيفيًا)، أزرار الشريط العلوي 44px، صفر أخطاء console.

**الجولة 7-8 — Phase 9: مراقب نظام صادق (قيد التنفيذ):**
- خط الأساس من المنشور: ثلاثة تبويبات فقط، وسم «ذاكرة JS» صادق أصلًا، لكن **لا تبويب «نظام»**، وعند إخفاء التبويب **لا توجد أي حالة موقوفة** (FPS يبقى 60 ثم يهبط إلى 0–1 فعليًا) — أي قيمة مضلِّلة.
- المُنجَز: `src/apps/monitor/system-info.ts` مجمّع **نقي بلا DOM** يعيد صفوفًا `{id, labelKey, value, available}`، وقاعدة «لا تختلق» مُتحقَّق منها بفحص نصي (لا ذكر لحرارة/مراوح/ذاكرة عتاد إلا في تعليق يشرح أنها غير متاحة). المتبقّي: تبويب «النظام» في `index.ts`، وإصلاح حالة الإخفاء، والاختبارات، والتحقق البصري.

**دروس تشغيلية مهمة لجلسة قادمة:**
1. **لا تشغّل أكثر من جلسة على هذا المجلد**: لوحظت تعديلات لملفات (`src/shell/desktop.ts`) تعود إلى نسخة قديمة بعد `checkout`، ما يعني أن جلسة أخرى تعمل في نفس الشجرة. تحقّق من `git status` قبل كل التزام، والتزم بملفاتك فقط.
2. **خادم Vite كان ينهار على الكتابة الذرّية** (`EBUSY`)؛ الإصلاح في `vite.config.ts` يستثني ملفات التحرير المؤقتة. لا تُلغِه.
3. **قياسات الواجهة**: أداة اللقطات لا تنقر؛ للتحقق التفاعلي استخدم سكربت CDP مؤقت يفتح النافذة ويقيّم JS في الصفحة (وقد كشف هذا أخطاء حقيقية: مفاتيح ترجمة خام في الإعدادات، واختبار تمرير خاطئ في RTL).
4. **لا تعتمد على `scrollLeft` الموجب في RTL**: القيمة سالبة في الاتجاه العربي، والاختبار الخاطئ يعطي نتيجة مضلِّلة.



