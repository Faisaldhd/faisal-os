# تدقيق Fai$al OS — VFS والاستمرارية (قراءة فقط)

النطاق: `src/vfs/**` (index.ts, storage.ts, vfs.test.ts)، `src/kernel/settings.ts`، `src/kernel/path.ts`، `src/shell/session.ts`، وكل ملف يحفظ إلى localStorage/IndexedDB (بـ grep). لم يُشغَّل أي اختبار (node_modules قيد الإصلاح) — كل ما يلي من قراءة المصدر.

## جيد ويجب الحفاظ عليه
- فصل التخزين عن المنطق: `StorageBackend` في `src/vfs/storage.ts:17-25` يسمح بإضافة OPFS دون لمس منطق VFS.
- تطبيع مسار واحد: `normalize()` في `src/kernel/path.ts:3-11` و`..` عند الجذر لا يهرب (`/..`→`/`)، و`resolve()` يدعم `~` (`path.ts:14-17`). اختبارات هروب/بادئة قائمة: `src/kernel/security.test.ts:25-36` (`/home/user2`، `/home/user/../../etc`).
- حماية prototype pollution في الإعدادات: `Object.create(null)` + regex مفاتيح + `Object.hasOwn` + إسقاط `__proto__` (`settings.ts:4-19`)، مع اختبار `security.test.ts:105-107`.
- كل تحليل JSON محروس بـ try/catch مع تحقق من الشكل والحد الأقصى: `settings.ts:11-15`، `browser/model.ts:12-23`، `clock/index.ts:62-73`، `notifications.ts:20-39`.
- `stat`/`readFile` يعيدان **نسخاً** لا مراجع (`vfs/index.ts:14-16,115-119`) → لا يمكن لتطبيق تخريب الشجرة عبر كائن stat.
- حذف متكرر صحيح بادئياً: `descendants()` بادئتها تنتهي بـ `/` فتمنع خلط `/home/user` بـ `/home/user2` (`vfs/index.ts:92-95,174-179`).
- الحصة معلنة ومركزية مع اختبارات (`vfs/index.ts:6-7`, `vfs.test.ts:313-327`).
- لا symlinks (غير موجودة في العقد) وكل العمليات عدا `mkdir` بلا `await` داخلي → لا تشابك فعلي في المسار الحرج.
- تنظيف Blob URLs في عارض الصور (`images/index.ts:156-163,406-411`) والتنزيل يلغيه بعد 4s (`files/index.ts:469-478`)؛ Markdown في AI يهرّب HTML ويرفض `javascript:` (`ai/markdown.ts:14`, `markdown.test.ts:6-14`).

## مشاكل P0
1. **السقوط إلى الذاكرة صامت** — عند غياب/رفض IndexedDB يُعاد `MemoryBackend` بلا أي إشعار (`storage.ts:146-152`)، والعلم `persistent` معرّف ولا يُقرأ في أي مكان (فقط `storage.ts:18,57,135`). في private mode أو عند `onblocked` يرى المستخدم نظاماً طبيعياً ويختفي كل ما يكتبه بعد إعادة التحميل — يناقض ادّعاء المنتج "in-memory fallback, persistence errors reported" (`Faisal-Os MD Vo1.1.txt:12`). إصلاح أدنى: إرجاع `persistent` من `createVFS` (`vfs/index.ts:22`) وإشعار/شريط بعد `mountShell` (`src/main.ts:21,34`). الخطر: منخفض.
2. **الكتابة غير متينة عند `await`** — الحفظ fire-and-forget (`vfs/index.ts:51-54` ثم `141,165,179,239-245,254`)، فـ `await writeFile()` ينجح قبل وصول أي شيء إلى IndexedDB، و`QuotaExceededError` من المتصفح يظهر **بعد** إبلاغ الواجهة بالنجاح (`onPersistError`: console + إشعار أول فقط، `vfs/index.ts:44-50`) بينما الحصة الداخلية تُحسب من الذاكرة فقط. مقبول سابقاً في `docs/SECURITY_REVIEW.md:14` لكنه يبقى فقداً صامتاً. إصلاح أدنى: طابور كتابة متسلسل يُنتظر بعد كل عملية + `flush` على `pagehide`. الخطر: متوسط (يغيّر توقيت الأخطاء).

## مشاكل P1
- **ترقية القاعدة تُفقد الجلسة**: `openDb()` يرفض عند `onblocked` (`storage.ts:52`) → سقوط للذاكرة (P0-1)؛ لا `onversionchange`/`onclose` ولا إعادة محاولة. إصلاح: `db.onversionchange = () => db.close()` + إبلاغ المستخدم بدل السقوط.
- **لا `navigator.storage.persist()`** في أي مكان (فقط `estimate`: `apps/settings/index.ts:216`, `apps/monitor/index.ts:357`) → التخزين best-effort وقابل للمحو الجماعي.
- **حصة المتصفح ≠ حصة النظام**: `df` يعرض `navigator.storage.estimate` بسقف 64GB (`terminal/shell/commands/fs.ts:555-559`) والمراقب يعرض 50MB (`monitor/index.ts:53`) → ثلاث حقائق متناقضة، ولا رسالة quota (`VFSError('EINVAL',…,'quota')` تُعرض `EINVAL: /path` في `files/index.ts:116`).
- **`rename` غير ذرّي وفيه فقدان**: الاستبدال = حذف ثم إنشاء (`vfs/index.ts:210-215,242-245`)، وفي `rename(file,file)` يُنفَّذ `put(dst)` ثم `delete(src)` بنفس المفتاح فيُحذف السجل من IndexedDB وتبقى العقدة في الذاكرة → الملف يختفي بعد إعادة التحميل (`vfs/index.ts:187-215,242-245`). غير قابل للوصول حالياً (حماية `dest===src` في `files/index.ts:402,452`, `ai/tools.ts:505`, `terminal/.../fs.ts:325`) لكنه عيب عقد. إصلاح: `if (from===to) return;` + كتابة الهدف قبل حذف المصدر مع انتظار العمليتين.
- **لا تنسيق بين التبويبات**: كل تبويب يبني خريطة ذاكرة مستقلة (`vfs/index.ts:24-32`) ولا مستمع `storage`/`BroadcastChannel` (grep = 0)؛ حذف متكرر في تبويب B يمسح ما يراه فقط فيترك ملفات تبويب A يتيمة، و`stat` ينجح على عقدة أبوها مفقود (لا فحص أب في `get()`، `vfs/index.ts:76-81`) → شجرة غير متسقة بعد إعادة التحميل.
- **سباق `mkdir` المتكرر**: فحص الأب ثم `await vfs.mkdir(parent,…)` ثم الإنشاء (`vfs/index.ts:157-163`) → نافذة تشابك مع `remove`/`rename`.
- **تمرير المخزن بالمرجع**: `bytes` يُخزَّن كما هو (`vfs/index.ts:134,140`)؛ تعديل المستدعي للمصفوفة بعد الكتابة يغيّر المحتوى في الذاكرة بلا تحديث `size`/`mtime` وبلا حفظ.

## مشاكل P2-3
- **أداء O(N) لكل عملية**: `children()`/`descendants()` تمسحان كل العقد وتستدعيان `dirname()`→`normalize()` لكل عقدة (`vfs/index.ts:89-95`)، و`totalSize()` تمسح كل الملفات في **كل** `writeFile` (`vfs/index.ts:34-38,137`) → مع 10k ملف كل كتابة/`readdir` خطية. إصلاح: `Map<dir, Set<path>>` + عدّاد حجم إجمالي.
- **بصمة الذاكرة**: `loadAll()` يجلب كل السجلات ببياناتها عند الإقلاع (`storage.ts:64-79`, `vfs/index.ts:26-32`) فتقيم الشجرة كاملة (حتى 50MB) في RAM بجانب نسخة IndexedDB، و`readFile` يضاعف الذروة. إصلاح: metadata في الذاكرة والبيانات عند الطلب.
- **كتابة جزئية**: أول خطأ في `putMany/deleteMany` يرفض الوعد دون إلغاء المعاملة فتُطبَّق الطلبات الباقية (`storage.ts:89-101,111-123`).
- **سجلات تالفة/قديمة**: `loadAll` يثق بالمحتوى (`storage.ts:71`, `vfs/index.ts:26-32`): لا إصدار مخطط ولا تحقق ولا إصلاح؛ `path` نسبي أو `data` مفقود = عقدة شبح. `DB_VERSION=1` بلا هجرة (`storage.ts:29,44-49`).
- **`mode` زخرفي**: VFS لا يرمي `EACCES` أبداً (فقط `scopeVFS`، `kernel/apps.ts:30`)، و`chmod` بلا تحقق مدى (`vfs/index.ts:251-256`) → نصف عقد الصلاحيات (`types.ts:33-34,48`) غير منفَّذ.
- **لا تحقق أسماء**: لا حد طول ولا رفض NUL، والأسماء النقطية تُطوى في `normalize` (`path.ts:3-11`)؛ الفحص في التطبيق فقط (`files/index.ts:112`).
- **الرفع**: `f.arrayBuffer()` قبل أي فحص حجم (`files/index.ts:215-227`) → ملف بحجم GB يُحمَّل كاملاً ثم يُرفض بـ20MB؛ ولا أي handler لـ drag&drop رغم CSS جاهز (`files.css:353`، grep `dragover|drop` = 0).
- **الإعدادات**: `save()` يبتلع أخطاء الحصة/private mode بصمت (`settings.ts:16`) فيظن المستخدم أن التفضيل حُفظ؛ `get` يعيد القيمة بالمرجع (`settings.ts:19`).
- **الجلسة**: حفظ مؤجَّل 400ms بلا `pagehide/beforeunload` (`session.ts:25-34`) فتُفقد آخر الإجراءات؛ ولا حفظ لـ `minimized`/`snapped`/`alwaysOnTop`، والهندسة مفهرسة بـ `appId` فقط (`wm.ts:14,124-129`) فلا تُستعاد نوافذ متعددة لنفس التطبيق.
- **فجوات اختبار**: لا اختبار لـ `rename(file,file)`، ولا لترتيب/ذرّية الحفظ، ولا لسجل تالف، ولا أن السقوط للذاكرة **معلن** (`vfs.test.ts:355-371` يتحقق من الوظائف فقط).

## جدول الاستمرارية الحالي
| الحالة | المفتاح/المخزن | الوسيط | الدليل |
|---|---|---|---|
| theme, accent, locale, shell.desktop, shell.dash, shell.dnd, shell.restoreSession, shell.session, apps.installState | `faisal.settings.v1` (كائن JSON واحد) | localStorage | `settings.ts:3,16` |
| هندسة النافذة لكل appId + maximized | `faisal.wm.geometry.v1` | localStorage | `wm.ts:14,57` |
| سجل الإشعارات (50) | `faisal.notifications.v1` | localStorage | `notifications.ts:6,72` |
| مفضلة/محرك المتصفح | `faisal.browser.bookmarks`, `faisal.browser.engine` | localStorage | `browser/model.ts:8-9` |
| مفتاح/موديل Groq AI | `faisal.groq.apiKey`, `faisal.groq.model` | localStorage | `ai/index.ts:87-94` |
| مدن الساعة | `faisal.clock.cities` | localStorage | `clock/index.ts:60,76` |
| ملفات/مجلدات VFS (بالبيانات) | DB `faisal-vfs` / store `nodes` (keyPath=path, v1) | IndexedDB | `storage.ts:27-29,47` |
| سجل أوامر الطرفية | `/home/user/.bash_history` | VFS→IndexedDB | `terminal/backends/sim.ts:8,102` |

**مطلوب حسب هدف المنتج وغير محفوظ**: الخلفية (لا ميزة اختيار؛ خلفية ثابتة في `theme.css:139-158`)، مواضع أيقونات سطح المكتب (يُحفظ فقط `shell.desktop` كقائمة معرّفات، `desktop.ts:9-11`)، موضع/حجم كل **نافذة** على حدة وحالتها مصغّرة/ملتصقة/مثبّتة، آخر مجلد ووضع العرض grid/list والترتيب في الملفات (`files/index.ts:133-140` ولا localStorage في التطبيق)، cwd آخر في الطرفية، استعادة تلقائية/محتوى غير محفوظ في المحرر (`editor/index.ts:244-270` كتابة يدوية فقط)، سجل محادثة AI، حالة "غير مقروء" للإشعارات (`notifications.ts:66,217` تُصفَّر)، سجل الآلة الحاسبة.

## ديون تقنية
- ثلاث حقائق للحصة (`vfs/index.ts:6-7`, `monitor/index.ts:53`, `terminal/.../fs.ts:555-559`).
- لا اختبار لـ `storage.ts` منفرداً؛ `vfs.test.ts:21-38` يمسح القاعدة بأداة يدوية تكرّر اسم/إصدار القاعدة حرفياً.
- لا versioning للبيانات (`StoredNode` بلا حقل إصدار، `storage.ts:6-15`) ولا لـ JSON الإعدادات (الإصدار في اسم المفتاح فقط).
- `MemoryBackend` يعيد كتابة شكل السجل (`storage.ts:134-143`) وبلا اختبار فشل حفظ.
- توثيق غير مطابق: "No `innerHTML` … anywhere" (`docs/SECURITY_REVIEW.md:36`) بينما `ai/index.ts:216,263` يستخدمان `innerHTML = renderMarkdown(...)` (مهرَّب ومختبَر، لكن الادّعاء مطلق).
- Reset يحذف كل `faisal.*` (`apps/settings/index.ts:235`) بلا تصدير/نسخة احتياطية قبل الحذف.

## أسئلة/غموض
1. هل الـ50MB ضمانة منتج أم حارس ناعم؟ الواجهات تعرض رقمين مختلفين — أيّهما الصحيح عند الرفض؟
2. هل تشغيل تبويبين مدعوم؟ لا قفل ولا مزامنة: آخر كاتب يفوز أم رفض الكتابة؟
3. في private mode: السقوط للذاكرة مع إشعار أم وضع قراءة فقط/رفض الإقلاع؟
4. هل ينفّذ VFS نفسه `mode` ويرمي `EACCES`، أم يبقى ذلك في `scopeVFS` فقط؟
5. هل يُطلب `navigator.storage.persist()` قبل الوثوق ببيانات المستخدم؟
