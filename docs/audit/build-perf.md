# تدقيق أداء البناء — Fai$al OS (`D:\Faisal-OS`)

قياس مباشر على `dist/` الحقيقي (53 ملفاً) + قراءة الكود. وسمت ما لم أستطع قياسه بـ **(لم يُقَس)**.

---

## 1) أرقام البناء الفعلية

`npm run build` = `tsc && vite build` (package.json:8). 126 وحدة، ~412ms، `base: './'`، `sourcemap: false`، `assetsInlineLimit: 0`، `build.target: 'es2022'` (vite.config.ts:5-6).
**لا يوجد bundle عملاق واحد** — تقسيم لكل تطبيق صحيح (11 app chunk + shell + entry)، والأصول الثقيلة (v86) lazy. لا تحذير chunk-size، ولا eval، ولا dynamic-import-vars. التحذيرات الوحيدة: `crypto`/`node:crypto`/`node:fs/promises`/`perf_hooks` externalized من `node_modules/v86/build/libv86.mjs` (تُستبدل بـ `__vite-browser-external-BuXAV7Xc.js` = 60 B)، وهي غير ضارة.

| الأصل (dist/) | خام | gzip |
|---|---|---|
| `assets/v86-BshLEa5c.wasm` | 2,101,621 B = 2052.4 KiB | 394.9 KiB |
| `v86/bzImage` | 1,704,448 B = 1664.5 KiB (1.63 MiB) | لا يفيد * |
| `assets/libv86-1Of43BIS.js` | 355,983 B = 347.6 KiB | 91.9 KiB |
| `assets/terminal-DGFhe7fl.js` | 347,648 B = 339.5 KiB | 89.2 KiB |
| `v86/seabios.bin` | 131,072 B = 128 KiB | — |
| `assets/index-PLRJT2C1.js` (entry) | 84,913 B = 82.9 KiB | 27.0 KiB |
| `assets/shell-C72YdIut.js` | 56,380 B = 55.1 KiB | 19.9 KiB |
| `v86/src/kernel.config` | 40,999 B | — |
| `assets/ai-DXI-DEvA.js` | 38,630 B | 14.8 KiB |
| `v86/vgabios.bin` | 36,352 B = 35.5 KiB | — |
| `assets/index-C8jEzKPv.css` | 30,193 B = 29.5 KiB | 6.5 KiB |
| ملفات JS متبقية (10 chunks تطبيقات) | 33.9 KB→7.6 KB لكل واحد | — |
| ملفات CSS متبقية (10 ملفات) | 9.0 KB→3.2 KB | — |
| `index.html` | 1,682 B | 0.94 KiB |
| `sw.js` | 3,016 B | — |

- **إجمالي dist:** 5,180,215 B = **4.94 MiB** خام، **2.42 MiB** لو gzip للكل.
- JS كله **1005.1 KiB** خام، CSS كله **86.6 KiB**.
- **أكبر 5 أصول:** wasm 2052 KiB، bzImage 1664 KiB، libv86 347.6 KiB، terminal chunk 339.5 KiB، seabios 128 KiB.
- *bzImage مضغوط أصلاً بـ gzip داخلياً (zImage)، فـ gzip للنقل لا يفيده (1.73 MiB ≈ 1.66 MiB).

## 2) تكلفة التحميل الأول

| المسار | ملفات | خام | gzip |
|---|---|---|---|
| قبل أول رسم (HTML + entry + CSS + shell chunk) | 4 | 173,168 B = **169.1 KiB** | **53.5 KiB** |
| فتح التطبيق Terminal لأول مرة | +5 | +712,634 B = 695.9 KiB | +179.4 KiB |
| تشغيل Linux (v86) لأول مرة | +4 | +3,973,493 B = **3.79 MiB** | **2.13 MiB** |
| قائمة precache للـ SW (تُنزَّل بعد first paint) | 35 | 791,319 B = 772.8 KiB | 244.7 KiB |

**ما يحجب أول رسم فعلاً:**
1. `index.html` (بلا أي محتوى مرئي — `<div id="faisal-root"></div>` فقط، index.html:16) → لا يوجد first paint مفيد إطلاقاً قبل JavaScript.
2. `src/main.ts:17` → `entry chunk` 82.9 KiB ثم `shell chunk` 55.1 KiB (shell/index.ts:1-13 مستورد ساكنياً) = 138 KiB JS + 29.5 KB CSS تُفسَّر وتُنفَّذ.
3. `src/main.ts:21` `await createVFS(bus)` → `vfs/index.ts:23` `createStorageBackend()` + `vfs/index.ts:26` `backend.loadAll()` (فتح IndexedDB + مسح مؤشر كامل) **قبل** `mountShell` في `src/main.ts:34`. في أول زيارة: `onupgradeneeded` + seed يطلق ~29 عملية IDB (vfs/index.ts:266-317) والكتابة غير مُنتظَرة (vfs/index.ts:51) فهي لا تحجب.
4. `shell/splash.ts:55` شاشة الإقلاع تُضاف في نفس المهمة، ثم 900 ms إلزامية قبل الاختفاء (splash.ts:5,65-68).
- xterm / v86 / html-to-image **ليست** في مسار الإقلاع: لا يوجد أي bare import ساكن في الرسم المتحرك (46 وحدة src فقط، 209.4 KiB خام). xterm يأتي مع `terminal` chunk (dynamically imported، apps/index.ts:24)، وlibv86 عبر `v86-Ch-OX_2a.js`، وv86 bzImage/seabios/vgabios + wasm عند اختيار Linux (terminal/index.ts:134 → backends/v86.ts:62-73).
- ملاحظة سلبية: `__vite__mapDeps` في `terminal-DGFhe7fl.js` يجعل فتح Terminal **يُحمِّل libv86 (91.9 KiB gzip) استباقياً** حتى لو اختار المستخدم الصدفة المحلية.

## 3) P0 / P1 / P2-3

### P0 — لا يوجد أي رسم قبل تنزيل/تنفيذ JS (شاشة بيضاء)
- الدليل: `index.html:15-17` (CSS render-blocking + `#faisal-root` فارغ)، `src/main.ts:17`.
- التأثير: FCP = نهاية تنفيذ حزمة 138 KiB JS + انتظار IndexedDB.
- الإصلاح الأدنى: HTML/CSS ثابت داخل `index.html` (خلفية + شعار + مؤشر) أو `<noscript>`/skeleton، وتأجيل استيراد `shell` في main.ts:12. الخطر: منخفض.

### P0 — برنامج Service Worker يمكن أن يبني حالة "لا تحديث أبداً"
- الدليل: `build/sw-template.js:13` `cache.addAll(PRECACHE)` ذرّي؛ `build/pwa.ts:33` يضيف `'./'` و`index.html` من القائمة المُولَّدة. أي استجابة غير 2xx لواحد من 37 مدخلاً تُسقط `install` بالكامل، و`sw.js` **يُستثنى** من precache (pwa.ts:7) والنسخة تُحسب من نفس القائمة (pwa.ts:31-35).
- التأثير: عميل قديم يطلب `dist/sw.js` قديماً بعد نشر جديد → 404 لأحد الـ chunks → التثبيت يفشل دائماً → المستخدم عالق على نسخة قديمة/بلا offline حتى يمسح بيانات الموقع.
- الإصلاح الأدنى: `cache.addAll` → `Promise.allSettled` لكل مدخل، أو تخطي الفاشل وتسجيله.

### P1 — Contextual window: تبويب مفتوح عبر نشرين يفقد chunk
- الدليل: `build/sw-template.js:5-6` + `:46-52` (cache-first بلا revalidate لأي أصل) + لا `skipWaiting` في القالب كله ⇒ النسخة الجديدة تنتظر إغلاق كل التبويبات (`src/main.ts:46-49` يعرض إشعاراً فقط بدون reload).
- التأثير: تبويب قديم يطلب `assets/ai-<hash-قديم>.js` بعد أن حذفه GitHub Pages → 404 → التطبيق مكسور.
- الإصلاح: `self.skipWaiting()` + رسالة "تحديث الآن" تقوم بـ `location.reload()`، و`network-first` مع fallback للـ HTML.

### P1 — `RUNTIME_ONLY` يستثني `assets/libv86-*` من الـ version hash
- الدليل: `build/pwa.ts:7` + `pwa.ts:29` (يُستبعد من `files` المستخدمة في `hash.update`، pwa.ts:31-32).
- التأثير: ترقية `v86` لا تُغيّر `VERSION` ⇒ المستخدم العائد يأخذ `libv86` قديماً من الكاش بينما wasm قد يكون جديداً (النسبة `assets/v86-BshLEa5c.wasm` تُستثنى أيضاً) ⇒ تعارض إصدارات.
- الإصلاح: احسب الـ hash من كل ملفات dist (بمن فيها المستثناة من precache).

### P1 — CSP قد تمنع blob Worker الخاص بـ v86
- الدليل: `index.html:8` `script-src 'self' 'wasm-unsafe-eval'` بلا `blob:`؛ و`libv86` ينشئ `URL.createObjectURL(new Blob([...]))` ثم `new Worker(t)` داخل `register_yield` ويُنادى في باني `H` أي عند إنشاء `V86` (backends/v86.ts:77). تسلسل branch: `process` غير معرّف → `scheduler` غير مفعّل → `Worker` ⇒ blob worker.
- التأثير: احتمال `SecurityError` عند تشغيل Linux؛ تحققت من الكود فقط — **لم أختبره في متصفح**.
- الإصلاح: أضف `blob:` إلى `script-src` (أو `worker-src 'self' blob:` موجودة أصلاً، لكن لا تتكل عليها).

### P1 — الـ precache ينزّل 772.8 KiB بعد أول رسم
- الدليل: `build/sw-template.js:13` + قائمة 35 مدخلاً (كل chunks التطبيقات الـ 11 + 11 CSS + الأيقونات) في وقت واحد بعد `system:ready` (main.ts:36).
- الإصلاح: `skipWaiting` لا يُغيّر الحجم؛ الحل: precache للـ shell فقط، والـ app chunks عند أول استخدام (runtime cache موجود أصلاً `sw-template.js:50`).

### P2-3
- **P2** `vite.config.ts:8` يستخدم `as any` لتجاوز الأنواع — إعداد `test` غير مفحوص.
- **P2** لا `engines` في package.json (سطر 1-30) — البناء على Node 22 في CI فقط (pages.yml:24).
- **P2** GitHub Pages لا يرسل `Cache-Control`؛ لا رؤوس `immutable` لأصول الـ hash ⇒ إعادة تحقق دائماً (يخففها الـ SW).
- **P3** `v86/src/*` (kernel.config 40 KB، build.sh، rootfs) داخل `public/` ⇒ تُنشر على الإنترنت (dist/v86/src/...). ليست خطيرة لكنها ضوضاء وحجم.
- **P3** `.gitignore` (3 أسطر) لا يتضمن `.npm-cache/` — موجود فعلاً في مساحة العمل و`git status` يظهره كـ `?? .npm-cache/`؛ خطر `git add -A`.
- **P3** لا `README.md`، لا lint config، لا `.editorconfig`، لا `LICENSE` (MIT/ISC معلنة في package.json:14 فقط).

## 4) تقييم PWA و service worker

- **التوليد:** في `closeBundle` فقط (`build/pwa.ts:24-26,37`) ⇒ غير موجود في `npm run dev`. `apply: 'build'` صحيح.
- **قائمة precache:** مُشتقّة من مخرجات البناء فعلاً (walk على dist، pwa.ts:9-13,27-30) — ليست hardcoded. لكن `VERSION` = sha256 لأول 12 حرفاً من محتوى الملفات **بعد** استثناء `RUNTIME_ONLY` (pwa.ts:31-35).
- **v86:** `v86/**` و`*.wasm` و`assets/libv86-*` خارج الـ precache (pwa.ts:7) ⇒ لا offline للـ VM قبل أول تشغيل؛ يُخزَّن عند الاستخدام عبر `sw-template.js:46-52`.
- **التخزين المؤقت للأصول:** cache-first بلا تحقق (`sw-template.js:46-48`) للأصول الـ hashed — مقبول نظرياً لكن **لا يُبطَل أبداً** ما دام `VERSION` ثابتاً؛ والملفات غير الـ hashed (`manifest.webmanifest`, `icons/*`) نفس المعاملة ⇒ أيقونة قديمة لأجل غير مسمى.
- **التنقل:** network-first مع fallback إلى `./` (sw-template.js:31-42) — لكن كتابة الكاش تحدث بعد استجابة الشبكة، والـ `request` الأصلي هو ما تُعاد استجابته، لذا هو صحيح (لا سباق «HTML قديم/جديد»).
- **الإصدار/التحديث:** لا `skipWaiting` ⇒ **كل** التبويبات يجب أن تُغلق. `clients.claim()` موجود (sw-template.js:21).
- **هل يمكن نشر تطبيق مكسور للمستخدمين؟ نعم، ثلاثة مسارات:**
  1. `addAll` ذرّي + نافذة نشرين ⇒ تثبيت يفشل للأبد (P0 أعلاه).
  2. تبويب طويل العمر + نشر جديد ⇒ chunks محذوفة من الخادم وغير موجودة في كاش ذلك العميل ⇒ 404 (P1 أعلاه).
  3. `libv86`/wasm خارج الـ hash ⇒ خليط إصدارات قديم/جديد (P1 أعلاه).
- **manifest.webmanifest:** `name/short_name "Fai$al OS"`، `lang: "ar"`، `dir: "rtl"` ✔، `start_url: "./"` و`scope: "./"` (نسبيان ⇒ صحيحان لأي مسار)، `display: standalone` + `display_override: [window-controls-overlay, standalone]`، `background_color #0E1A3A`/`theme_color #16264F` (يطابقان index.html:10)، 4 أيقونات: svg any + 192 + 512 any + 512 maskable ✔. لا `screenshots` ولا `shortcuts` (اختياري).

## 5) تقييم CI/Nasher (`.github/workflows/pages.yml`)

يفعل: push على `main` أو dispatch → `ubuntu-latest` + Node 22 + `cache: npm` → `npm ci` → `npm test` → `npm run build` → `upload-pages-artifact@v3 (path: dist)` → وظيفة `deploy` بـ `deploy-pages@v4` داخل بيئة `github-pages`، مع `permissions: contents:read, pages:write, id-token:write` و`concurrency: pages / cancel-in-progress`.

**لا يضمن:**
- **لا `npm run typecheck` خطوة مستقلة** — يُنفَّذ ضمنياً لأن `build` = `tsc && vite build` (package.json:8). لو غُيّر السكربت لاحقاً إلى `vite build` سقط فحص الأنواع بصمت.
- **لا فحص بعد البناء (smoke test):** لا تحقق من وجود `dist/sw.js`، ولا أن `__PRECACHE__`/`__VERSION__` استُبدلا فعلاً. لو تغيّر القالب أو ترتيب الإضافات، يُنشر `sw.js` فيه `__VERSION__` حرفياً بنجاح أخضر. (لم أتحقق من artifacts المنشورة فعلاً على الرابط العام.)
- **لا تشغيل متصفح/قياس أداء/تحقق من العمل دون اتصال** ⇒ كل مخاطر PWA أعلاه لا تكتشفها CI.
- **لا matrix** (Node واحد) ولا `engines`، ولا `dependabot`، ولا فحص أمني/`npm audit`، ولا `--ignore-scripts`/تجربة تثبيت نظيفة ثانية.
- لا `timeout-minutes` على الوظائف، ولا `environment` على مرحلة البناء.
- الإجراءات مثبتة على وسوم رئيسية (`@v4`, `@v3`) لا على SHA — مقبول لكنه عرضة لانزلاق الوسم.
- عند الفشل: `test` أو `build` يفشلان الوظيفة قبل الرفع، و`deploy` يعتمد على `build` ⇒ **لا ينشر بناءً مكسوراً** ✔. في المقابل، الفشل **لا** يُلغي النشر السابق (يبقى آخر نشر ناجح، وهذا مرغوب) ولا يوجد إشعار/تعليق على PR (لا تشغيل على PR أصلاً).
- `cancel-in-progress: true` مع مجموعة `pages` واحدة ⇒ push سريع متتابع قد يُلغي بناءً جارياً (آمن لكن قد يؤخر النشر).

## 6) أفضل 5 مخاطر أداء (مرتّبة بالأثر)

1. **لا first paint قبل تنفيذ 138 KiB JS + انتظار IndexedDB.** `index.html:15-17` + `src/main.ts:17` + `src/main.ts:21` (`await createVFS` في `vfs/index.ts:23,26` قبل `mountShell` في `main.ts:34`). الأثر: شاشة بيضاء/FCP متأخر ويرتبط بزمن فتح IndexedDB على الأجهزة البطيئة (غير مقيس بالمتصفح).
2. **شاشة الإقلاع تفرض 900 ms إضافية.** `src/shell/splash.ts:5` + `:65-68`. الأثر: +900 ms قبل أي تفاعل مرئي حتى لو كان الإقلاع فورياً.
3. **فتح Terminal يُحمِّل libv86 استباقياً (91.9 KiB gzip).** `terminal-DGFhe7fl.js` يستورد libv86 ساكنياً بسبب `__vite__mapDeps` المُولَّد من `src/apps/terminal/index.ts:134` (dynamic import لـ `./backends/v86`) — ويُستدعى prefetch فور فتح التطبيق حتى لو بقي المستخدم على الصدفة المحلية. الأثر: +92 KiB و+356 KiB تفسير عند أول فتح Terminal.
4. **SW ينزّل 772.8 KiB (35 مدخلاً) بعد الإقلاع مباشرة.** `build/sw-template.js:13` + `src/main.ts:36`. الأثر: منافسة عرض النطاق أثناء أول تفاعل على شبكة بطيئة.
5. **دخول Linux يكلّف 3.79 MiB (2.13 MiB gzip).** `public/v86/bzImage` (1.66 MiB) + `assets/v86-BshLEa5c.wasm` (2.05 MiB) + seabios/vgabios، تُجلب كلها عبر `Promise.all` واحد في `src/apps/terminal/backends/v86.ts:62-65,70-73` ثم تُحلَّل/تُبنى على الخيط الرئيسي. الأثر: تأخير طويل وجُمود محتمل عند أول تشغيل للـ VM (لا progress per-file).

## 7) أسئلة / غموض

- **لم أستطع إعادة البناء محلياً:** `spawn EPERM` من `optimizeSafeRealPathSync` في Vite (يحجب الـ sandbox تنفيذ `net use` بـ stdio ممدود). كل أرقام dist مأخوذة من مخرجات البناء التي شغّلتها الجهة الأعلى ومن `dist/` الفعلي على القرص (53 ملفاً) — متسقة مع ما ذكرته (126 وحدة، 412ms) لكن **أرقام gzip للـ chunks المفردة** منقول عنها، وأرقامي المجمّعة gzip محسوبة بـ zlib عندي.
- هل التنبيه عند وجود نسخة جديدة (`src/main.ts:44-49`) كافٍ عمداً، أم أن عدم `reload` مقصود لتجنّب فقدان الجلسة؟ (يحدد ما إذا كان إصلاح P1 مقبولاً).
- هل `RUNTIME_ONLY` لـ `assets/libv86-` مقصود لأجل تجنّب الـ precache فقط (فيُصلح الـ hash)، أم لتجنّب التخزين؟ القالب يخزّنه runtime على أي حال.
- هل `.npm-cache/` داخل مساحة العمل مقصود أم بقايا؟ و`Faisal-Os MD Vo1.1.txt` غير مُتتبّع في الجذر.
- لم أختبر: CSP/blob-worker فعلياً، عمل الـ SW على `faisaldhd.github.io/faisal-os/`، زمن IndexedDB على جهاز حقيقي، أي قياس FCP/LCP/INP — كلها **(لم تُقَس)**.
