# تدقيق قراءة-فقط: `apps/files` · `apps/editor` · `apps/images` · `apps/terminal`

الأحجام: `files` 46,603 بايت/7 ملفات · `editor` 19,296/4 · `images` 33,084/9 · `terminal` 173,478/22 · المجموع **272,461 بايت**.
كل الأدلة أدناه من قراءة الملفات نفسها (لا بناء، لا تشغيل). لم يُعدّل أي ملف مصدري.

## جيد ويجب الحفاظ عليه
- `terminal/index.ts:167-175` — تنظيف كامل ومنظّم عند الإغلاق: `offData/offResize` (xterm)، `offWinResize`، `ro.disconnect()`، `backend.dispose()`، `term.dispose()`. أفضل نموذج في النطاق.
- `terminal/backends/v86.ts:133-139` — `dispose()` يضبط `disposed`، يلغي `flushTimer`، ويستدعي `emu.destroy()`؛ وكل مسارات `start()` تفحص `this.disposed` (سطور 66، 74، 109).
- `terminal/shell/util.ts:46-49` — `safeName()` يعقّم أسماء الملفات من تسلسلات التحكم قبل الطبع (يُغطّى باختبار `shell.test.ts:153`).
- `editor/index.ts:202-216` — `setCloseGuard(confirmDiscard)` + `beforeunload` مع إزالة المستمع في `onClose` (تعامل صحيح مع التغييرات غير المحفوظة).
- `images/index.ts:406-412` — إغلاق نظيف: `unsubFs`، `resizeObserver`، `galleryObserver`، وإبطال كل `objectURL` (المفرد والمعرض).
- `files/icons.ts:1-10` و`images/toolbar-icons.ts:1-10` — أيقونات SVG ثابتة عبر `DOMParser`، مع تعليق صريح أن بيانات المستخدم لا تمرّ منها أبداً.
- `files/index.ts:749-753` + `editor/index.ts:216` + `terminal/backends/sim.ts:123-126` — كل تطبيق يسجّل `onClose` ويلغي اشتراكاته.
- `terminal/index.ts:54-56` و`38` — `dir='ltr'` مفروض على جسم xterm مع إبقاء العنوان RTL عبر `\u2066…\u2069` (`index.ts:103`): حل صحيح وسليم لـ RTL.
- `images/index.ts:169-183` + `images.css:104-114` — "fullscreen" مُنفَّذ داخل `ctx.window.content` بلا أي تلاعب بـ WM.
- `terminal/shell/commands/faisal.ts:38-51` — تحقّق فعلي من أن ملفات v86 موجودة: `public/v86/{seabios.bin,vgabios.bin,bzImage}` (1.7MB kernel) موجودة فعلاً.

## مشاكل P0
**لا يوجد P0.** لا `innerHTML`/`insertAdjacentHTML`/`eval`/`new Function`/`document.write` في التطبيقات الأربعة (تحقّق شامل: المطابقات الوحيدة في المستودع كانت في `apps/ai` و`apps/monitor`، وكلها خارج النطاق)، وكل النصوص تُكتب بـ `textContent` (`files/dialog.ts:35،39`، `editor/dialog.ts:22،27`).
ملاحظة: أقرب بند إلى P0 هو P1-2 (كتابة فوق ملف بلا تأكيد = فقدان بيانات)، لكنه محصور في مسار الرفع.

## مشاكل P1
1. **P1-1 — محاكي v86 يبقى حياً بعد إغلاق النافذة.** `terminal/index.ts:117` يضع `backend=null` قبل `await import('./backends/v86')` (سطر 134)، والفحص `if (current !== kind) return` (سطر 135) لا يعرف شيئاً عن الإغلاق. فمن يغلق النافذة أثناء التحميل: `onClose` (سطر 172) لا يجد شيئاً ليُتلِفه، ثم يُنشأ `V86Backend` ويُشغَّل (`152-153`) فلا يُتلَف أبداً.
   الإصلاح الأدنى: متغيّر `closed` يُضبط في `onClose`، وفحصه بعد `await import` وقبل `backend = b` (ومثله في فرع `sim`). الخطر: نافذة مغلقة تستهلك ~64MB + نواة CPU بلا نهاية.
2. **P1-2 — الرفع يستبدل ملفاً موجوداً بلا تأكيد.** `files/index.ts:215-228`: `vfs.writeFile(join(currentPath, sanitizeUploadName(f.name)), buf)` بلا `exists`/`uniqueName`، بخلاف مسار النسخ الذي يستخدم `uniqueName` (`files/index.ts:448`). الإصلاح: استعمال `uniqueName(vfs, currentPath, …)` أو نافذة تأكيد. الخطر: فقدان بيانات صامت.
3. **P1-3 — تحديث ضائع في المحرر عند فتح الملف مرتين.** لا `singleInstance` في `editor/manifest.ts` (والافتراضي غير مُفعَّل، `kernel/apps.ts:161`)، ولا اشتراك في `fs:change` في `editor/index.ts` إطلاقاً، و`save()` (`230-242`) يكتب بلا مقارنة. فتح الملف من نافذتَي محرر (أو تعديله من الطرفية) يجعل آخر حافظ يمحو الآخر. الإصلاح الأدنى: `singleInstance: true` للمحرر، وإعادة قراءة `mtime` قبل `save` مع تنبيه. الخطر: فقدان تحريرات.

## مشاكل P2-3
1. **P2-1 — إعادة رسم كاملة + تكلفة لكل عنصر في تطبيق الملفات.** `files/index.ts:561-574` و`588` و`690-708`: كل نقرة/سهم يُعيد بناء الشبكة/القائمة كاملة بمستمعين جدد؛ وكل أيقونة تمرّ عبر `DOMParser.parseFromString` (`files/icons.ts:7` يستدعى من `612` و`653`)؛ و`formatDate` (سطر 662) ينشئ `new Intl.DateTimeFormat` لكل صف في كل رسم (`files/format.ts:17`). الإصلاح: تفويض مستمع واحد على الحاوية + تحديث صنف `is-selected` فقط، وذاكرة `Intl` بمفتاح اللغة، وتجميع `icon()` مؤقتاً. الخطر: تجمّد مع آلاف الملفات.
2. **P2-2 — قائمة السياق في `document.body` بـ `z-index: 1000`.** `files/index.ts:508` و`files.css:257-259`: القائمة `position: fixed` على مستوى الصفحة فتظهر فوق **كل** النوافذ (`wm.ts` يستخدم 10..n)، ولا تتبع النافذة عند سحبها، وتخالف قاعدة "الجذر هو `ctx.window.content`". الإصلاح: استعمال `showContextMenu` من `shell/contextmenu.ts` أو حاوية داخل `win.content`. الخطر: قوائم معلّقة فوق نوافذ أخرى.
3. **P2-3 — تسريب مستمع `mousedown` على `document`.** `files/index.ts:515` يضيفه بـ `setTimeout(…,0)` و`505` يغلق القائمة عند اختيار عنصر دون إزالة المستمع، و`518-523` لا يزيله إلا إذا مرّ `mousedown` والقائمة ما زالت مفتوحة. الإصلاح: `document.removeEventListener` داخل `closeMenu()` (سطر 486-489). الخطر: تراكم مستمعين دائمين طوال عمر الجلسة.
4. **P2-4 — تكلفة لكل ضغطة مفتاح في المحرر.** `editor/index.ts:168-172`: كل `input` يعيد بناء كل أسطر `gutter` (`150-160`) + `updateStatusLine` يقطع النص كاملاً (`163-166`)؛ و`computeMatches` يمسح المستند كاملاً لكل حرف (`292-310` عبر `333`). الإصلاح الأدنى: خنق (debounce) للـ gutter/البحث + حدّ أعلى للأسطر. الخطر: تجمّد مع ملفات كبيرة.
5. **P2-5 — `objectURL` يتيم من `loadThumb` بعد إعادة الرسم/الإغلاق.** `images/index.ts:304-305` يفرغ الخريطة ويبطل الروابط، لكن `loadThumb` (`358-364`) لا يُلغى: ما زال في الطيران يُكمل بعد الإبطال فيسجّل رابطاً جديداً في خريطة فارغة لا يُبطَل أبداً. الإصلاح: `AbortController`/`generation` token يُفحص بعد `await readFile`. الخطر: تسريب ذاكرة صور.
6. **P2-6 — كتابة DOM بعد الإغلاق في الصور.** `images/index.ts:230-260`: لا يُزاد `loadToken` في `onClose`، فمهمة `loadIndex` الجارية تُكمل `metaEl.textContent` و`updateChrome()` على DOM مفصول. الإصلاح: `loadToken++` و`imgEl.onload=imgEl.onerror=null` في `onClose`. الخطر: منخفض (بلا تسريب)، لكنه نمط قابل للتكرار.
7. **P2-7 — خطأ واضح في `ls -l`.** `terminal/shell/commands/fs.ts:51` يطبع المالك مرتين: `${r.owner.padEnd(ow)} ${r.owner.padEnd(ow)}` بدل مالك+مجموعة (ولم تُحسب `group` في `w()` سطر 43). الإصلاح: عمود `group` واحد. الخطر: مخرجات غير مطابقة لتوقّع المستخدم/الاختبارات (لا اختبار يغطي هذا السطر).
8. **P2-8 — تباين mock/الحقيقي في VFS يُخفي مسارات.** `terminal/__tests__/memvfs.ts:76` يرمي `EEXIST` عند `rename` على هدف موجود، بينما `vfs/index.ts:200-215` يستبدل الملف (أو مجلداً فارغاً) فعلاً؛ ولهذا يضطر `mv` إلى `remove(to)` مسبقاً (`fs.ts:332`) وهو سلوك لا يعكس الواقع. كذلك `memvfs` لا يملك `bus` فلا يُصدر `fs:change` إطلاقاً → مسارات `files/index.ts:742-747` و`images/index.ts:401-404` غير مغطاة بأي اختبار.
9. **P2-9 — سباق تحديث القائمة في الملفات.** `files/index.ts:294-306` مع `742-747`: استدعاءان متزامنان لـ `refresh()` لا يُرتَّبان، فقد يرسم الأقدم نتيجة أقدم فوق الأحدث. الإصلاح: `refreshToken` كما في الصور. الخطر: قائمة قديمة حتى التحديث التالي.
10. **P2-10 — ازدواج `fit()` عند تغيير الحجم.** `terminal/index.ts:163-165`: كلٌّ من `win.onResize` و`ResizeObserver` يستدعي `doFit()` مباشرة بلا `requestAnimationFrame`/خنق، فتُنفَّذ مرتين في الإطار أثناء السحب. الإصلاح: تجميع عبر rAF. الخطر: أداء منخفض.
11. **P2-11 — `ensureSampleImages` يكتب على القرص عند كل تشغيل أول للمعرض.** `images/index.ts:49-61` يكتب 3 ملفات SVG إن كان المجلد فارغاً؛ نافذتان متزامنتان = كتابتان متداخلتان. الإصلاح: علم في `settings` أو `singleInstance`. الخطر: منخفض.

## تسريبات الموارد (سبب → سطر)
- `files/index.ts:515` — `setTimeout(0)` يضيف `mousedown` على `document` بعد أن يكون `onClose` قد أزال المستمع → مستمع دائم؛ المُشغِّل: فتح قائمة سياق ثم إغلاق النافذة.
- `files/index.ts:505` + `518-523` — اختيار عنصر من القائمة يستدعي `closeMenu()` بلا `removeEventListener` → تسريب مستمع لكل استخدام للقائمة.
- `files/index.ts:478` — `setTimeout(revokeObjectURL, 4000)` غير متتبَّع؛ المُشغِّل: تنزيل ثم إغلاق النافذة فوراً (الرابط يبقى 4 ثوانٍ).
- `files/index.ts:426-432` و`440-464` — لا `cancel` أثناء `deleteSelection`/`pasteClipboard`؛ المُشغِّل: لصق/حذف شجرة كبيرة ثم إغلاق النافذة → الكتابة تستمر بلا واجهة (`copy.ts:24-36`).
- `images/index.ts:358-364` — `loadThumb` بلا token؛ المُشغِّل: وصول ملف جديد إلى Pictures (`fs:change`) أثناء تحميل المصغّرات → روابط كائن يتيمة.
- `images/index.ts:243-249` — `objectUrl` مُفرد يُبطَل في `onClose` (سليم)، لكن الوعد المعلّق في `loadIndex` يكمل بعد الإغلاق (كتابة DOM ميتة).
- `terminal/index.ts:117,134-153,167-175` — محاكي v86 يُنشأ بعد الإغلاق ولا يُتلَف أبداً؛ المُشغِّل: اختيار "لينكس" ثم إغلاق النافذة خلال التحميل/الإقلاع.
- `terminal/index.ts:88` — `requestAnimationFrame(doFit)` غير ملغى عند الإغلاق (إطار واحد، ضئيل).
- `terminal/backends/v86.ts:111` — `flushTimer` (8ms) يُلغى في `dispose` (سليم).
- **التشغيل بلا واجهة:** `wm.ts:160-167` التصغير مجرد صنف CSS (`is-minimized`) والنافذة تبقى في DOM، والمصدر `window:change` (`wm.ts:122،165`) **لا يشترك فيه أي من التطبيقات الأربعة** (تحقّق: المشتركون الوحيدون `shell/dock.ts:65-66` و`shell/session.ts:34`). النتيجة: تطبيقات الملفات/المحرر/الصور خاملة فعلاً (بلا مؤقتات دورية)، بينما **v86 يستمر في إحراق نواة CPU و~64MB وهو مصغَّر أو غير مركَّز**.

## كود مكرر مقترح للتجميع
- `promptDialog`: `files/dialog.ts:30-85` ≈ `editor/dialog.ts:12-71` (فرق: بادئة الصنف فقط) + `confirmDialog` مقابل `shell/dialog.ts:11-59` → وحدة واحدة `src/shell/dialog.ts` بوسيط بادئة (أو `src/kernel/ui/dialog.ts`).
- `errorMessage(err)`: `files/index.ts:115-118` = `editor/index.ts:181-184` حرفياً → `src/kernel/vfs-error.ts`.
- `icon(svg)` عبر `DOMParser`: `files/icons.ts:5-10` = `images/toolbar-icons.ts:5-10` = `shell/icon.ts:renderIcon` → وحدة أيقونات واحدة.
- النسخ الشجري: `files/copy.ts:24-36` (`copyRecursive`) = `terminal/shell/commands/fs.ts:257-269` (`copyTree`) → `src/kernel/vfs-extra.ts`.
- الترتيب الطبيعي: `files/index.ts:286` = `images/helpers.ts:22` (`localeCompare(..., {numeric:true})`) → `naturalCompare()` مشتركة.
- تهيئة البايت: `files/format.ts:3-13` و`images/helpers.ts:50-57` → دالة واحدة بوسيط `short|locale`.
- خرائط الامتدادات/الأنواع: `images/mime.ts:1-15`، `images/helpers.ts:3`، `terminal/shell/commands/common.ts:32-34` → جدول واحد للامتداد→(MIME، نوع أيقونة، فئة `ls --color`).
- `cssVar()` في `terminal/index.ts:21-26` ونمط `queueMicrotask(focus/select)` في النوافذ المنبثقة → مساعدات مشتركة.
- `files/copy.ts:46` — إعادة تصدير `dirname` بلا داعٍ (المستهلك `files/index.ts:4` يستوردها من `kernel/path` أصلاً).

## ديون تقنية
- `images/helpers.ts:26-39` (`indexOfPath`, `stepIndex`, `Fit`): مُختبَرة (`helpers.test.ts:34-55`) لكن **غير مستعملة**؛ `images/index.ts:262-268` و`287` تعيد المنطق يدوياً → اختبارات تمنح ثقة زائفة.
- لا اختبارات إطلاقاً لـ `apps/files` و`apps/editor` (لا ملفات `*.test.ts` في المجلدين)، مقابل تغطية جيدة للطرفية (4 ملفات) وللمساعدات في الصور.
- `memvfs.ts` بلا `bus`/`fs:change` وبنيّة `rename` مختلفة → أي منطق يعتمد على الأحداث أو على الاستبدال غير مُغطّى (انظر P2-8).
- `terminal/index.ts:19` — `ICON` معرّف وغير مستعمل.
- حدود موارد غائبة: المحرر بلا سقف حجم/أسطر (`editor/index.ts:150-160،292-310`)، والملفات بلا افتراضية (virtualization) (`files/index.ts:604-668`).
- `editor/index.ts:186-199` يفتح أي مسار يأتي في `args` بينما `saveAs` يقيّد على `/home/user` (`244-258`) → سياسة غير متسقة (VFS المقيّد يحمي، لكن الرسالة للمستخدم مضللة).
- `files/index.ts:230-233` (`sanitizeUploadName`) لا يعالج `..`/`\` ولا يمنع الاستبدال (P1-2).
- `images/index.ts:415-425` يكتب عينات على القرص كأثر جانبي للتشغيل (لا يوجد إعداد لإيقافه).

## أسئلة/غموض
1. **تسلسلات الهروب من محتوى الملفات:** يُكتب مخرج الأوامر خاماً إلى xterm (`terminal/index.ts:153`، `terminal/shell/commands/common.ts:20-22`). فحص حزمة `@xterm/xterm@6.0.0` لم يُظهر أي معالج `OSC 52`/`case 52` (ولا `windowOptions`/`setTitle` مربوطة بـ `document.title`) → لا سرقة حافظة، لكن انتحال الطرفية (ألوان/مؤشر/عنوان xterm الداخلي) ممكن. هل نريد مُرشِّح OSC/DCS للطباعة، أم نعتبره سلوك طرفية حقيقية؟
2. **v86 والتصغير:** هل المطلوب إيقاف مؤقت للمحاكي عبر `window:change` (الحدث موجود لكن لا مشترك)؟ يحتاج دعم `pause/resume` في v86.
3. **`singleInstance` للطرفية والمحرر:** غير محدَّد في المانيفستات (`terminal/manifest.ts:5-15`، `editor/manifest.ts:5-13`)؛ هل الطرفية المتعددة مقصودة؟
4. **`close()` يتجاوز حارس الإغلاق:** `kernel/types.ts:90-94` يقول `close()` يغلق دائماً، لذا `sys.apps.closeWindow`/`uninstall` يتخطيان `confirmDiscard` → هل هذا مقصود (فقدان تحريرات من "مراقب النظام")؟
5. **v86 بلا تخزين مؤقت:** `v86.ts:146،150` يستخدم `cache: 'no-cache'` لكل تشغيل → إعادة تنزيل ~1.87MB من `public/v86` في كل "إعادة تشغيل". هل هذا مقصود؟
