# تدقيق مسار الـShell — إدارة النوافذ والتكوين (قراءة فقط)

النطاق: `src/shell/**` فقط. كل الأدلة من قراءة الملفات (لا npm/vitest — لم يُشغَّل أي اختبار).
Inventory كامل لعمليات النوافذ: open/close/minimize/maximize/restore/focus/z-index/drag/resize/snap/always-on-top/show-desktop موجودة كلها في `src/shell/wm.ts` (587 سطرًا).

## جيد ويجب الحفاظ عليه

- مركزية الـWM حقيقية عبر العقد: `WindowHandle`/`WindowManager` في `src/kernel/types.ts:81-108`، والتطبيقات تُقيَّد بنوافذها في `src/kernel/apps.ts:66-76` (`scopeWM`)، ولا يوجد في `src/apps/**` أي `wm.open` مباشر أو كتابة إلى `style.left/top` لنافذة — فقط `src/kernel/apps.ts:163` ينشئ النافذة. لا يوجد تسريب منطق نوافذ إلى التطبيقات.
- z-index مركزي بالكامل: الكتابة الوحيدة في `wm.ts:147`، والترتيب المنطقي `list()` تصاعديًا `wm.ts:580`؛ طبقات الواجهة عبر CSS (`theme.css:604-629`, `theme.css:186`).
- عدّاد z-index لا يُعاد ضبطه أبدًا (`wm.ts:74-75`) ولا يوجد إعادة استخدام لمعرّف نافذة (`wm.ts:221`)، لذا لا تعارض ولا "قفزة" للخلف عند الإغلاق.
- تجميع الـreflow أثناء السحب/التحجيم: كتابة واحدة لكل إطار عبر `requestAnimationFrame` مع إلغاء عند الـup (`wm.ts:429-434`, `wm.ts:478-484`) — لا thrash لكل pointermove كما يخشى السؤال 3.
- Pointer capture مستخدم فعليًا للسحب والتحجيم (`wm.ts:391`, `wm.ts:459`, `screenshot.ts:150`) مع إزالة مستمعات `pointermove/pointerup/pointercancel` في `onUp` (`wm.ts:436-438`, `wm.ts:485-487`).
- Clamping موحّد لسطح سطح المكتب (`wm.ts:104-114`) ومستخدم في الفتح/الاستعادة/سحب/تحجيم/resize النافذة (`wm.ts:238`, `wm.ts:406`, `wm.ts:537`) → لا نوافذ خارج الشاشة (لا يوجد دعم شاشات متعددة لأن WM الأصلي غير مستخدم أصلًا).
- الحفاظ على هندسة النوافذ موجود فعلًا: `GEOMETRY_KEY='faisal.wm.geometry.v1'` مع تحقق من كل حقل ورفض المحارف غير الرقمية و`Object.create(null)` ضد prototype pollution (`wm.ts:39-58`)، ويُعاد الفتح عند الموضع والحجم (`wm.ts:235-248`, `wm.ts:496`) مع اختبار يغطي التخزين والقيم الفاسدة (`wm.test.ts:108-126`).
- استعادة الجلسة موجودة ومقيّدة: `shell.session` + سقف 12 نافذة + فلترة التطبيقات المثبَّتة (`session.ts:11-15`, `session.ts:36-45`).
- حماية البوابة قبل الإغلاق: `setCloseGuard`/`requestClose` مع منع النقر المزدوج (`wm.ts:298-313`, `wm.ts:379`) واختبار صريح له (`wm.test.ts:128-145`).
- `aria` وبناء DOM آمنان في القوائم: `role=menu/menuitem/separator` + `aria-checked/aria-disabled` (`contextmenu.ts:80-99`)، تنقّل لوحة مفاتيح مع تجاهل المعطّل (`contextmenu.ts:136-196`) وإرجاع التركيز للمُستدعي (`contextmenu.ts:155`) — مغطّى بـ`contextmenu.test.ts:49-111`. كل النصوص عبر `textContent` (لا innerHTML) والـSVG يُنقّى بقوائم سماح (`icon.ts:36-65`).
- RTL في الإطارات: كل CSS للنوافذ/الشريط/القوائم يستخدم `inset-inline/block` و`margin-block` (15 استخدامًا لـ`inset-inline` في `theme.css`، مثل `theme.css:699-711`, `theme.css:202`)، ولا يوجد `margin-left/right` أو `text-align:left/right` مطلقًا؛ ووضع القائمة يُرتَّب منطقيًا مع RTL في `contextmenu.ts:34-57`.
- i18n سليم لأزرار النافذة (`strings.ts:6-8`, `strings.ts:73-75`) عبر `t()` في `wm.ts:507`.

## مشاكل P0

- P0-1: مبدّل حجم النافذة معكوس في RTL (الواجهة عربية افتراضيًا). المقابض `e/w/ne/nw/se/sw` تُوضع بخصائص منطقية (`theme.css:702-711`) فتقع `faisal-resize-w` في RTL على الحافة اليمنى، بينما `wm.ts:471` يفسّر `w` فيزيائيًا (`left = o.left + (o.width - w)`)، والنتيجة أن سحب الحافة اليمنى يقلّص/يحرّك النافذة من اليسار. الإصلاح الأدنى: حساب الاتجاه الفيزيائي من `getComputedStyle(el).direction` مرة واحدة في `startResize` وقلب `e/w` (و`ne/nw/se/sw`) عند RTL. المخاطرة: منخفضة ومعزولة في `startResize` فقط، ومغطاة يدويًا لا آليًا.
- P0-2: لوحة مركز الإشعارات غير قابلة للوصول بالكيبورد ومغطاة بصريًا. `panel` تُلحق بـ`document.body` (`notifications.ts:215`) والزر يفتحها دون نقل التركيز (`notifications.ts:242`)، ولا يوجد `aria-modal` ولا focus trap؛ الأثر: Tab ينتقل خلف اللوحة و`Escape` يُعالَج بـ`stopPropagation` فقط (`notifications.ts:238-240`). الإصلاح: `role=dialog` + `aria-modal="true"` + `focus()` على زر الإغلاق/القائمة + trap بسيط على `Tab`، تمامًا كما في `shellConfirm` (`dialog.ts:17-18`, `dialog.ts:57`). المخاطرة: منخفضة.

## مشاكل P1

- P1-1: لا إدارة لتركيز DOM إطلاقًا داخل النافذة: لا `tabindex` ولا `el.focus()` في `wm.ts:220-335`، و`focusWindow` تُبدّل صنفًا بصريًا فقط (`wm.ts:132-150`)؛ `focusedId` قد يخالف `document.activeElement`، و`role=dialog` بلا `aria-modal` ولا اسم مرتبط (`aria-label` نصّي فقط `wm.ts:229`). لا يوجد Alt+Tab بين النوافذ. الإصلاح: `tabindex="-1"` + `focus()` على النافذة (أو أول عنصر قابل للتركيز) داخل `focusWindow`، وإضافة `aria-modal="false"`/Alt+Tab (تبديل على `wm.list()`). المخاطرة: متوسطة (تعارض محتمل مع تركيز تطبيقات مثل xterm).
- P1-2: النوافذ مصغَّرة تبقى موجودة بـ`display:none` (`theme.css:629`) ومرصودها `ResizeObserver` لا يزال متصلًا (`wm.ts:337-345`, يفصل فقط عند الإغلاق `wm.ts:326`)، فقد تُبلَّغ تطبيقات بأبعاد 0×0 بعد `minimize` ثم تُعيد الرسم خطأً. الإصلاح: في `minimize` أبلغ `resizeCbs` بالأبعاد المخزّنة أو اقطع الرصد مؤقتًا (`obs.unobserve`) وأعد الوصل عند الاستعادة. المخاطرة: منخفضة.
- P1-3: الإغلاق في مسار التطبيقات النظامية يتجاوز بوابة الحماية: `uninstall` يستدعي `w.close()` (`src/kernel/apps.ts:138`) و`closeWindow` كذلك (`src/kernel/apps.ts:149`) أي أن إزالة تطبيق تُغلق نافذة بها تعديلات غير محفوظة دون سؤال، بينما النقر على × يسأل (`wm.ts:302-313`). الإصلاح: تمرير `requestClose` عبر واجهة WM أو تعريض `WindowHandle.requestClose` واستخدامه من مسار الإزالة. المخاطرة: منخفضة.
- P1-4: مستمعو `keydown` العامّون يعملون فوق أي عنصر: `wm.ts:542-576` (Ctrl+Alt+W وSuper+أسهم) و`index.ts:28-48` — لا يوجد فحص `ev.target`/`activeElement`، و`preventDefault()` قد يبتلع مفاتيح من مربعات نص/`contenteditable`، كما أن `Super+Shift+S` (`index.ts:34`) قد يتصادم مع اختصار النظام لأنه غير مسجّل عبر Keyboard Lock إلا في ملء الشاشة (`topbar.ts:234-236`). الإصلاح: تجاهل الحدث إذا كان الهدف `input/textarea/contenteditable` أو كان `isComposing`. المخاطرة: منخفضة.
- P1-5: تسريبات منطقية عند التكوين/الفكّ: `mountDock` يشترك في 6 أحداث بلا إلغاء ولا `dispose` (`dock.ts:59-67`)، و`mountOverview` كذلك (`overview.ts:136-144`) مع مستمع `document.keydown` دائم (`overview.ts:180`)؛ و`mountTopbar` يضيف `document.fullscreenchange/keydown/pointerdown` ولا تُنظَّف (`topbar.ts:65`, `topbar.ts:212-219`)؛ وطبقة أيقونات سطح المكتب تسبق النوافذ دائمًا بـ`z-index:1` (`theme.css:988-991`) لا في مستوى واحد معها. الإصلاح: إرجاع `dispose()` من كل جبل وتخزين مُلغيات الاشتراك. المخاطرة: منخفضة (الجبل يُنادى مرة واحدة اليوم).
- P1-6: إعادة بناء DOM كاملة في كل حدث: `dock.render` تُفرّغ الشريط وتعيد إنشاء كل الأزرار وأيقونات SVG في كل `window:focus`/`window:change` (`dock.ts:22-56`, `dock.ts:65-66`)، و`window:focus` يُطلق عند كل استدعاء لـ`focusWindow` حتى لو لم يتغير التركيز (`wm.ts:137-150`)، وكذلك `overview.ts:60-83`, `overview.ts:85-111` عند كل فتح. الإصلاح: تجاهل `window:focus` إذا كان `focusedId === id`، وتحديث الأصناف/الترتيب تزايديًا بدل التفريغ. المخاطرة: متوسطة (سلوك بصري).
- P1-7: سطح المكتب لا يتحرك حقيقيًا: `mountDesktop` يستقبل `_wm` ويتجاهله (`desktop.ts:230`) ولا يستمع لأي حدث نوافذ — التحديد والأيقونات مستقلّة عن الحالة، والترتيب أبجدي فقط (`desktop.ts:85-94`) بلا حرّية موضع أو شبكة محفوظة؛ شبكة الأيقونات `grid-template-rows: repeat(auto-fill, 96px)` (`theme.css:994`) لا تنعكس في RTL. الإصلاح: تمرير `_wm` فعليًا لتمييز التطبيقات المفتوحة، واستخدام `justify-content:flex-start` المنطقي أو `direction` صريح. المخاطرة: منخفضة.

## مشاكل P2-3

- P2 الاستعادة الكاملة (الفتح) تُلغي "إظهار سطح المكتب": `desktopShown` يُصفَّر في كل `focusWindow` (`wm.ts:145`) — فيكفي فتح نافذة برمجيًا لتعطيل زر الإرجاع (`wm.ts:514-524`).
- P2 `window.addEventListener('resize')` (`wm.ts:528-540`) يمسح كل النوافذ ويكتب مستطيلاتها في كل تغيير حجم نافذة المتصفح.
- P2 تكرار قيمة الـbreakpoint: `NARROW_BREAKPOINT = 700` (`wm.ts:6`) مقابل `@media (max-width: 700px)` (`theme.css:590`) — أي انحراف لاحق يخلق عدم تطابق.
- P2 `prefers-reduced-motion` ناقص: يغطي الشرح/السبلاش فقط (`theme.css:916-919`) ولا يوقف `transition` على `.faisal-overview` (`theme.css:406`)، `.faisal-snap-preview` (`theme.css:1200`)، `faisal-notif-in` (`theme.css:364`)، hovers المتحركة.
- P3 ميزانية `backdrop-filter` 8 استخدامات (`theme.css:180`, `theme.css:355`, `theme.css:397`, `theme.css:575`) مع `blur(28px)` في الـoverview — مكلف على أجهزة ضعيفة.
- P3 نقص أنماط `:focus-visible` (3 فقط: `theme.css:330`, `theme.css:1019`, `theme.css:1076`) — أزرار الشريط العلوي/الdock/أزرار النافذة بلا حلقة تركيز تعريفية.
- P3 `.faisal-overview` المغلق بـ`opacity:0;pointer-events:none` (`theme.css:404-406`) دون `inert`/`aria-hidden` — عناصره تُبقى قابلة للتركيز بالتاب.
- P3 انزلاق الموضع المحفوظ بنافذتين لنفس التطبيق: `remember`/`geometry` بالمفتاح `appId` (`wm.ts:124-130`) فتكتب النافذة الأخيرة المُغلقة فوق هندسة الأخرى.

## خريطة منطق إدارة النوافذ الحالي

- `src/shell/wm.ts` — المالك الوحيد: دورة الحياة (`open/close`)، الحالة المخزّنة في `WinRecord` (`wm.ts:20-37`)، z-index والتركيز (`wm.ts:132-158`)، تصغير/تكبير/استعادة/التصاق/دائم في المقدمة (`wm.ts:160-218`)، السحب والتحجيم (`wm.ts:383-493`)، اختصارات WM (`wm.ts:542-576`)، حفظ الهندسة (`wm.ts:39-58`, `wm.ts:124-130`)، إظهار سطح المكتب (`wm.ts:514-524`).
- `src/shell/desktop.ts` — طبقة الأيقونات وقوائم سياق التطبيقات فقط؛ لا تملك أي نافذة (`desktop.ts:230-324`) لكنها تتحكم في قائمة الـdash المشتركة (`desktop.ts:60-82`) التي تقرأها `dock.ts:28` و`overview.ts:115`.
- `src/shell/dock.ts` — عرض حالة WM (يعمل/مُصغَّر/نشط) ورفع/تصغير جماعي (`dock.ts:45-50`)؛ لا حالة خاصة.
- `src/shell/overview.ts` — سطح الأنشطة: `wm.list()` للمصغّرات (`overview.ts:60-83`) + شبكة تطبيقات + dock خاص (`overview.ts:113-134`).
- `src/shell/contextmenu.ts` — قائمة سياق عامة بمثيل واحد فقط لكل الصفحة (`contextmenu.ts:21`, `contextmenu.ts:72-73`) + دعم long-press للمس (`contextmenu.ts:244-257`).
- `src/shell/session.ts` / `src/shell/appearance.ts` — استعادة جلسة، وسمات/لون التمييز عبر CSS variables (`appearance.ts:32-53`).
- `src/shell/screenshot.ts` / `dialog.ts` / `splash.ts` / `notifications.ts` / `icon.ts` — أدوات محيطة لا تتدخل في هندسة النوافذ.
- `src/kernel/apps.ts:66-76` — الجدار الذي يمنع التطبيقات من رؤية/التحكم في نوافذ غيرها.

## ديون تقنية

- لا API للتخطيط: `WindowManager` بلا `move/resize/position/restore/snap/alwaysOnTop` (`types.ts:98-108`) → أي ميزة تخطيط تتطلب تعديل العقد، و`toggleMaximize` هو المخرج الوحيد.
- لا تصدير لدورة حياة التكوين: لا `dispose` في `mountDock`/`mountOverview`/`mountNotifications`/`mountTopbar` (مقابل `Desktop.dispose` الموجود في `desktop.ts:225-228`).
- تكرار بنية dock بين `dock.ts:22-56` و`overview.ts:113-134`.
- اختصارات WM مبرمجة بشرط `metaKey` (`wm.ts:550`) بلا سجل اختصارات مركزي، والتوثيق نصّي في `src/apps/settings/index.ts:25-34` قد ينحرف عن التنفيذ.
- لا اختبارات إطلاقًا لـ: السحب، التحجيم، الالتصاق، إظهار سطح المكتب، اختصارات النوافذ، `dock.ts`, `topbar.ts`, `overview.ts`, `notifications.ts`, `dialog.ts` — المغطّى فقط wm الأساسي (`wm.test.ts`) والـdesktop/session/notifications النقية (`desktop.test.ts`) والقوائم (`contextmenu.test.ts`) ولقطة الشاشة (`screenshot.test.ts`).

## أسئلة/غموض

- هل المطلوب دعم اللمس لسحب النافذة؟ حاليًا العنوان يسحب بالفأرة و`pointerdown` بلمس (لا شرط `pointerType`) لكن لا يوجد أي دعم لمس مخصّص في التطبيقات، و`touch-action:none` على العنوان (`theme.css:642`).
- هل يجب أن يحتفظ `remember` بهندسة كل نافذة على حدة (مفتاح windowId) بدل `appId`؟
- هل التركيز المرئي (`is-focused`) يكفي أم يجب أن يتبعه تركيز DOM فعلي (مسار P1-1) قبل إضافة Alt+Tab؟
- هل يوجد قرار تصميمي بعدم إظهار المصغَّرات في Activities؟ (`overview.ts:62` يعرض الكل بلا وسم "مُصغَّر").
