# تدقيق CSS — الجوال + RTL/LTR + التصميم + الأداء + الوصولية

**النطاق (قراءة فقط):** `src/shell/theme.css` (1319 سطرًا)، `src/apps/**/*.css` (10 ملفات، 2510 سطرًا)، `BRAND.md`، `brand/icons.ts`، `brand/logo.ts`، `shell/icon.ts`، `index.html`. **لم يُعدَّل أي ملف مصدر.** أرقام الأسطر = ترقيم أداة `read`.

## ١) جيد ويجب الحفاظ عليه

- **نظام الرموز مركزي وموثَّق:** كل `--faisal-*` في كتلة واحدة `theme.css:8-60`، مع نسختَي الداكن `theme.css:62-86` و`theme.css:88-110`. اللوحة مطابقة حرفيًا لـ `BRAND.md:16-26` و`logo.ts:20-30`.
- **Logical properties هي القاعدة:** **262 سطرًا** تستخدم خصائص منطقية مقابل **مخالفتين حقيقيتين فقط** (القسم ٣). أمثلة: `theme.css:699-711` (المقابض الثمانية كلها `inset-inline/block`)، `theme.css:819`، `images.css:135-136`.
- **`text-align` منطقي بالكامل:** ‏37 استخدامًا بـ `start/end/center`، و`left` في 3 مواضع مقصودة فقط (كتلة كود + مخرجات الطرفية): `ai.css:89,217`، `terminal.css:92` — مرافقة بـ `direction: ltr; unicode-bidi: isolate` (`terminal.css:90-91`).
- **مدير النوافذ يمنع الفائض الأفقي:** `wm.ts:104-113` — `Math.max(Math.min(minW, sw), Math.min(r.width, sw))` ⇒ لا نافذة تتجاوز سطح الشاشة.
- **القوائم المنبثقة تُقلَب وتُحصر داخل الشاشة:** `contextmenu.ts:42-56` + `contextmenu.ts:131` (`window.innerWidth/Height`).
- **وصولية الـ shell قوية:** `role="menu"/menuitem/separator` + `aria-disabled`/`aria-checked` (`contextmenu.ts:80,89,96,98,99`)، `role="switch"` (`notifications.ts:207`)، إدارة تركيز `contextmenu.ts:136`، مناطق حيّة `aria-live="polite"` (`notifications.ts:61`، `ai/index.ts:197`)، وحالات معلَنة: `aria-expanded` (`topbar.ts:33,47,91,210`)، `aria-pressed` (`topbar.ts:59`، `settings/index.ts:202,205`)، `aria-current` (`dock.ts:41`).
- **عناصر أصلية بدل div:** `<button>`، `<summary>` (`ai.css:203`)، `<input type="range">` ⇒ تنقّل بالمفاتيح مجانًا.
- **reduced-motion مطبَّق فعلًا:** `theme.css:916-919` + `splash.ts:30-32,43` (تخطّي السبلاش) + `store.css:430-431` (تعطيل الـ spinner).
- **الأهداف الكبرى سليمة لمسيًا:** `dock-btn` ‏56×56 (`theme.css:543-544`) و44×44 عند ≤700px (`theme.css:592-593`)؛ `app-icon` ‏72px (`theme.css:509-510`).
- **`lang`/`dir` مُداران ديناميكيًا:** `i18n.ts:20-21`؛ الحالة الابتدائية `index.html:2`.
- **تباين النص الأساسي ممتاز:** أدنى نسبة للنص العادي المستخدم فعليًا **5.25:1** (القسم ٦).

## ٢) الفجوات على الجوال — لا يوجد نموذج جوال أصلًا

إجمالي `@media` في النطاق = **3 فقط**، و`@container` = **4**: `theme.css:62,590,817,916` | `store.css:250,430` | `browser.css:352` | `calculator.css:259` | `files.css:359` | **صفر** في `ai, clock, editor, images, monitor, terminal`.

1. **`env(safe-area-inset-*)` = صفر استخدام في كل الملفات** ⇒ الشريط العلوي (`theme.css:173-187`، 34px) والـ dock (`theme.css:560-568`) سيدخلان تحت notch/شريط الإيماءات، مع أن المانيفست يعلن `display: standalone`.
2. **`viewport-fit=cover` غائب:** `index.html:5` = `width=device-width, initial-scale=1` ⇒ حتى `env()` لن يعمل لو أُضيف.
3. **صفر `@media (pointer|hover)`** مقابل **54 ظهورًا لـ `:hover`** في 11 ملفًا ⇒ تفاعلات غير قابلة للاكتشاف باللمس: `theme.css:556`، `images.css:105-106` (شريط الأدوات يظهر بـ hover فقط في fullscreen)، `browser.css:333`، `store.css:392`، `ai.css:40`.
4. **صفر `@media (orientation)`** وصفر `100dvh/svh` (التخطيط كله `height:100%`، `theme.css:114-119`).
5. **السحب/التحجيم باللمس بلا أي قيد:** `wm.ts:348` (سحب)، `wm.ts:282` (مقابض)، `wm.ts:450-491`؛ ولا نمط «نافذة كاملة» تلقائي.
6. **صفر كشف جوال في `src/**`** (بحث `maxTouchPoints|ontouchstart|coarse|display-mode|isMobile` = 0).
7. **تخطيطات لا تُعاد هيكلتها على العرض الضيق** (لا media ولا container في ملفاتها): `store.css:78-93` بطاقة بانر 3 أعمدة و`store.css:129-136` وصف بـ `white-space: nowrap` + `overflow:hidden` ⇒ **قصّ نص** على 320px؛ `monitor.css:100` جدول بلا التفاف؛ `clock.css:210-233` شبكة `repeat(7,1fr)` بخلايا **36px**؛ `ai.css:32,145`.
8. **أهداف لمسية < 44px في الـ shell:** `theme.css:669-670` (26px)، `theme.css:323-324` (22px)، **مقابض التحجيم 6px** (`theme.css:699,702`)، `theme.css:310` و`theme.css:1071` (‏34px)، `theme.css:1288` (‏`padding:4px 8px`).
9. **`theme-color` واحد ثابت** `#16264F` (`index.html:10`) لا يتبع الوضع الداكن (وكذلك `manifest.webmanifest`).

## ٣) مشاكل RTL/LTR — مخالفتان حقيقيتان فقط

| الملف:سطر | الكود | الحكم |
|---|---|---|
| `browser.css:41` | `padding: 7px 8px 7px 10px` | **كاسر** — حشوة غير متناظرة تثبت مع `dir` ⇒ زر إغلاق التبويب على الحافة الخطأ |
| `browser.css:277` | `padding: 4px 6px 4px 16px` | **كاسر** — شريط بحث الصفحة الرئيسية |
| `browser.css:43` | `border-radius: 8px 8px 0 0` | بنيوي: تبويبات تنحني للأعلى فقط — مقبول |

**فيزيائي لكنه صحيح/مقصود:** `terminal.css:48` (`right 10px center`) — يُقلَب صراحةً في `terminal.css:51-52` لأن سهم القائمة الأصلي يبقى يمينًا. `theme.css:961-962` + `1259,1272` — تمركز (`left:50%` + `translateX`) مع معالجة `[dir="rtl"]`. `theme.css:908-913` — لونا أنيميشن متعاكسان مع `[dir="rtl"]` في `theme.css:897`. `images.css:118-119` (`translateY(-50%)`) و`images.css:82` (نمط متماثل) — محايدان. كل `translateY` أخرى (`theme.css:385,461,518,556,904`، `browser.css:192,333`) رأسية ⇒ محايدة. `scaleX(-1)` الصحيح: `browser.css:117`، `store.css:341`.

**الأعداد:** ‏54 `:hover` بلا حماية `(hover)`؛ 5 محدِّدات `[dir=...]` (`theme.css:897,1272`، `browser.css:117`، `store.css:341`، `terminal.css:51`).

## ٤) مركزية التصميم

**الرموز (كلها `theme.css:8-60`):** 9 ألوان علامة، 9 ألوان ثيم، `--faisal-danger`، 3 مرادفات تمييز، **2 radius** (`10px`,`6px`)، **2 ارتفاع shell** (`titlebar 38px`, `topbar 34px`)، 2 خطوط، 4 خلفيات جدار/سبلاش.
**الفجوة:** **لا رموز لـ spacing، ولا shadows (عدا `--faisal-shadow` واحد)، ولا typography scale، ولا z-index** (قيَم صريحة: 1,400,500,800,900,950,2000,3000,4000,10000,99999).

**الأرقام الصريحة:** ‏357 ظهور hex إجمالًا، منها **41 قيمة صريحة فعلية** (316 تعريف/احتياطي)، و**111 قيمة `rgba()`** خارج التعريفات، و11 `filter` ترجمة.

| الملف | hex صريح | rgba | أسوأ مثال |
|---|---|---|---|
| `store.css` | **9** | **18** | `store.css:84-85,119,142-143` |
| `theme.css` | 18 (منها 2 تعليق و3 `#000` لأقنعة) | 26 | `theme.css:539,1016` |
| `images.css` | 4 | 6 | `images.css:124,125,132,134` |
| `terminal.css` | 3 | 5 | `terminal.css:2-3,56,80` |
| `browser.css` | 3 | 9 | `browser.css:178,190,203` |
| `ai.css` | 2 | 2 | `ai.css:84-85` |
| `files/calculator/clock/editor/monitor` | 1/0/0/0/1 | 12/10/12/7/4 | `files.css:303`، `editor.css:135` |

**أسوأ المخالفين:** `store.css:84-85,119,142-143` بانر Fai$al AI يكتب `#22386f`,`#16264f`,`#0b1530`,`#f7f1e3`,`#e3b650` **بأحرف صغيرة** بدل الرموز ⇒ لا يتغيّر مع `data-theme`. `store.css:247-251` قيمة `#2e7d4f`/`#7fd9a4` مع **تكرار منطق الداكن مرتين** (سطر + `@media`). `store.css:89,102,246,276,399,447,484,485` ثماني قيم `rgba()` ذهبية/خضراء/حمراء يدوية. **احتياطيات الوضع الفاتح داخل ملفات تدعم الداكن:** `monitor.css:16,81,85,123`، `images.css:18,44,168`، `calculator.css:25,33,48,61,77,84,102,152,183,195`، `files.css:16,66,113,207,262,285,318,349,369`، `browser.css:21,93,128,144,220,280,326`، `clock.css:18,82,100,152,196,226,265,296,322,344`، `store.css:20,29,45,160,189,295,425,479` ⇒ إن غاب رمزٌ ظهر الفاتح فوق خلفية داكنة.
**مخالفة `BRAND.md:36`:** أصناف عارية غير مُنَطَّقة، أخطرها `ai.css:9,40,173` (`primary`,`error`,`note`,`grow`,`user`,`assistant`) و`theme.css:1248` (`.faisal-notif-icon.has-app` — الشاذ الوحيد في الـ shell)؛ و`is-*` عامة متكررة في 10 ملفات (`is-active` في 6 تطبيقات).

## ٥) أداء الأنماط

**دائم طوال الجلسة (الأغلى):**
- **خلفية الجدار: 5 طبقات** منها 4 `radial-gradient` بأحجام `78vh/96vh/900px/1000px` + `background-blend-mode: screen` (`theme.css:139-147`)، فوقها نقش SVG كامل بـ `mask-image` (`theme.css:151-162`).
- **`backdrop-filter` على 4-5 أسطح متزامنة:** `theme.css:180` (`blur(18px) saturate(1.3)`) الشريط العلوي، `theme.css:575` الـ dock، `theme.css:355` التنبيهات، `theme.css:397` الـ overview (`blur(28px)`). أغلى بند GPU على الجوال.
- **7 ترجمات `drop-shadow` على أيقونات تتكرر بالمئات:** `theme.css:517` (شبكة 72px)، `theme.css:557` (dock)، `theme.css:1032` (سطح المكتب)، `theme.css:241,797,870`.
- **أنيمشان لا نهائيان لا يمكن إيقافهما:** `theme.css:895` (`faisal-splash-sweep 1.1s infinite`)، `theme.css:1180` (`faisal-spin 0.8s infinite`) — كلاهما **مستثنى** من كتلة reduced-motion (`theme.css:916-919` تذكر السبلاش و`is-opening` فقط).

**مكلف ومشروط (يُشغَّل بالتفاعل):**
- **انتقالات على خصائص layout:** `theme.css:1200` = `transition: left/top/width/height 0.08s` على `.faisal-snap-preview` ⇒ layout+paint كل إطار؛ و`monitor.css:175` = `transition: width .25s` على أشرطة الموارد. كلاهما يجب أن يصير `transform`.
- `ai.css:205-206` — `faisal-ai-pulse 1.2s infinite` على كل خطوة نموذج ⇒ نبض `opacity` دائم **لا يوقفه reduced-motion**.
- `store.css:427` spinner 0.75s infinite (مشروط ومعطَّل تحت reduced-motion ✅).
- `theme.css:512-518` و`554-556` — `transition: transform` على عنصر يحمل `filter: drop-shadow` ⇒ إعادة تنقيط.

**يُزال/يُقيَّد فورًا:** إسقاط `background-blend-mode` وطبقة الهلال الثانية (`theme.css:141`)؛ `drop-shadow` على مستوى الأيقونة بدل كل نسخة؛ `contain: paint` لشبكة الأيقونات؛ حصر `backdrop-filter` بالسطح العلوي تحت `(pointer: coarse)`؛ تحويل `theme.css:1200` إلى `transform`.

## ٦) الوصولية

**تباين محسوب (WCAG 2.x، sRGB النسبية):**

| الزوج | النسبة | الحكم |
|---|---|---|
| Light `#8F6412` على `#FFFFFF` (accent) | **5.25:1** | ✅ AA |
| Light `#FFFFFF` على `#8F6412` (نص الزر) | **5.25:1** | ✅ AA |
| Light `#1a1d26` على `#f5f4f1` | **15.30:1** | ✅ AAA |
| Light `#565b67` على `#f5f4f1` | **6.18:1** | ✅ AA |
| Dark `#E3B650` على `#0E1A3A` | **9.02:1** | ✅ AAA |
| Dark `#0E1A3A` على `#E3B650` (نص الزر) | **9.02:1** | ✅ AAA |
| Dark `#E3B650` على `#1f2533` | **8.08:1** | ✅ AAA |
| Dark `#F7F1E3` على `#16264F` | **13.09:1** | ✅ AAA |
| Dark `#aab1c2` على `#1f2533` | **7.13:1** | ✅ AAA |
| Store `#e3b650` على البانر `#16264f` | **7.77:1** | ✅ AAA |
| Terminal `#f6f5f4` على `#1e1e1e` | **15.31:1** | ✅ AAA |
| **Light `#F0CF7A` على `#FFFFFF`** | **1.51:1** | ❌ فشل |
| **Light `#E3B650` على `#FFFFFF`** | **1.90:1** | ❌ فشل |
| **Light `#C9982F` (accent-2) على `#FFFFFF`** | **2.62:1** | ❌ دون 3:1 |
| Light `#B8862B` (gold-deep) على `#FFFFFF` | **3.24:1** | ⚠️ كبير/UI فقط |
| Dark `#8F6412` على `#0E1A3A` | **3.26:1** | ⚠️ غير مستخدم كنص داكن |

**الخلاصة:** كل أزواج **النص** المستخدمة فعليًا ≥ 4.5:1 ✅؛ الفشل يتركّز في **الوضع الفاتح**: `--faisal-accent-2: #C9982F` يُستخدم **كحلقة تركيز** (`theme.css:330` و`theme.css:1020`) = **2.62:1 < 3:1** المطلوب لمؤشر التركيز (WCAG 1.4.11)؛ ويظهر أيضًا في `logo.ts:95,101,122` و`store.css:142`.

**الفجوات مرتّبة:**
1. **`outline: none` بلا بديل `:focus-visible` (WCAG 2.4.7):** `files.css:140`، `editor.css:70` (المحرّر)، `images.css:84`، `browser.css:290`.
2. **تغطية `:focus-visible` = 3 قواعد في النطاق كله** (`theme.css:330,1019,1076`) + 2 (`terminal.css:64-68`). **لا مؤشر تركيز** لـ: `win-btn` (`theme.css:668`)، `dock-btn` (`542`)، `app-tile` (`492`)، `menu-item` (`300`)، `topbar-btn` (`208`)، `notif-open`/`notif-clear` (`1292`,`1280`)، `settings-nav-btn` (`732`)، `shell-dialog-btn` (`1151`).
3. **`:focus` غير `:focus-visible`** في `ai.css:147`، `browser.css:133`، `store.css:35` ⇒ حلقة تظهر عند النقر بالماوس.
4. **reduced-motion ناقص:** الأنيميشان اللانهائيان (`theme.css:895,1180`) و`ai.css:205` تعمل رغم التفضيل، وكذلك `theme.css:1200` و`monitor.css:175`.
5. **أهداف < 44px:** `theme.css:669-670`، `323-324`، `699,702` (6px)، `310`، `1071`؛ `clock.css:232` (36px)؛ `store.css:376` (34px)؛ `images.css:27-28` و`browser.css:102-103` (30px)؛ `browser.css:297-298` (34px).
6. **صفر `role=` في 7 تطبيقات** (`browser, clock, files, images, settings, store, monitor`) ⇒ لا `role="tablist"` لتبويبات `browser.css:35`، ولا `role="grid"` لشبكة `clock.css:210`.
7. **`aria-live` مرحّبة فقط في `notifications.ts:61` و`ai/index.ts:197`** — نتائج `calculator`، مخرجات `terminal`، وشارات `monitor` صامتة لقارئ الشاشة.
8. **`index.html` دلاليًا فقير:** لا `<noscript>`، لا landmarks، والحاوية `<div id="faisal-root">` فارغة (`index.html:16`) وكل الـ shell يُبنى بـ JS؛ عند فشل التحميل يظهر نص `Boot failed` (`main.ts:49`) بلا دلالة.

## ٧) `index.html`

| البند | الحالة | سطر |
|---|---|---|
| `lang="ar"` + `dir="rtl"` | ✅ ويُحدَّثان في `i18n.ts:20-21` | `2` |
| `viewport` | ⚠️ بلا `viewport-fit=cover` | `5` |
| CSP | ✅ صارمة (`default-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`)، استثناء `wasm-unsafe-eval` لـ v86 و`api.groq.com` — معلَّلة بالعربية | `7-8` |
| `theme-color` | ⚠️ قيمة واحدة `#16264F` بلا نسخة داكنة | `10` |
| `preload`/`prefetch` | ❌ لا يوجد | — |
| الخط | ✅ خطوط نظام ⇒ **لا طلب يحجب الرسم** (`theme.css:46`) | — |
| الأيقونة | ✅ SVG `data:` مطابقة لـ `logo.ts:133-137` ⇒ بلا طلب شبكة | `13` |
| السبلاش | يُبنى بـ JS ويُخفى بعد 900ms أو فورًا تحت reduced-motion (`splash.ts:5-6,43`) | — |

**أول رسم:** لا شيء يحجبه (لا CSS خارجي، لا خط، لا صورة)؛ لكن CSS يأتي عبر `import './theme.css'` في `shell/index.ts:1` داخل حزمة Vite ⇒ نافذة قصيرة بخلفية `body` الافتراضية قبل تطبيق الثيم (لا `style` حرج ولا `preload` للـ CSS).

## ٨) ملخّص P0 / P1 / P2-3

**P0 — يمنع الاستخدام على الجوال أو يخالف معيارًا:**
1. صفر `env(safe-area-inset-*)` + غياب `viewport-fit=cover` ⇒ notch/شريط إيماءات يغطي الشريط العلوي والـ dock (`theme.css:173-187,560-568`؛ `index.html:5`).
2. `outline: none` بلا `:focus-visible` ⇒ فقدان كامل لمؤشر التركيز (`files.css:140`، `editor.css:70`، `images.css:84`، `browser.css:290`).
3. `--faisal-accent-2` كحلقة تركيز على سطح فاتح = **2.62:1** < 3:1 (`theme.css:330,1020`).
4. صفر `@media (hover/pointer)` مقابل 54 `:hover` ⇒ عناصر غير قابلة للاكتشاف باللمس (`images.css:105-106` أوضح مثال).

**P1:**
5. لا نموذج جوال في `wm.ts` (سحب/تحجيم باللمس دائمًا) ولا استعلام عرض في 6 ملفات تطبيقات.
6. انقطاع reduced-motion عن 3 أنيميشنات لا نهائية (`theme.css:895,1180`، `ai.css:205`).
7. انتقالات على خصائص layout (`theme.css:1200`، `monitor.css:175`).
8. ‏41 hex صريح + 111 `rgba()` خارج النظام؛ الأسوأ `store.css:84-85,119,142-143` و`store.css:247-251`.
9. أهداف لمسية < 44px في الـ shell (`theme.css:669-670,699,702`).
10. `backdrop-filter` على 4-5 أسطح + 7 `drop-shadow` على أيقونات مكرّرة.

**P2-3:**
11. لا رموز لـ spacing/shadows/z-index/typography (‏z من 1 إلى 99999 بلا رمز).
12. احتياطيات الوضع الفاتح داخل ملفات تدعم الداكن (`monitor.css:16,81,85,123`، `images.css:18,44,168`…).
13. تسمية عارية: `ai.css` (`primary`,`error`,`note`,`grow`,`user`,`assistant`)، `theme.css:1248` (`has-app`)، `is-*` عامة في 10 ملفات.
14. صفر `role=` في 7 تطبيقات؛ `aria-live` ناقص في `calculator`/`terminal`/`monitor`.
15. `theme-color` لا يتبع الوضع الداكن.
16. مخالفتا RTL حقيقيتان فقط: `browser.css:41,277`.

## ٩) أسئلة/غموض

1. هل الجوال **هدف إطلاق** أم «يعمل بالصدفة»؟ المانيفست يعلن `standalone` + `display_override` بينما لا يوجد أي كود/CSS جوال — أيّهما المصدر؟
2. هل النموذج المطلوب «نافذة كاملة على الجوال» أم «شبكة نوافذ مصغّرة»؟ يحدّد إن كان الحل قيدًا في `wm.ts` أم media queries للـ shell.
3. الاستعلامات الحاوية الأربعة بحدود مختلفة (`620/560/480px`) — هل المقصود تغطية كل تطبيق بحاوية نافذته بدل media queries؟ إن نعم فالفجوة تنظيمية لا معمارية، والتوصية توحيد الحد في رمز واحد.
4. هل يوجد تدقيق جوال/وصولية سابق في `docs/audit/` (`shell-wm.md`، `kernel.md`، `apps-registry.md`، `security.md`) يجب الدمج معه تفاديًا للازدواج؟
5. هل `@xterm/xterm/css/xterm.css` (`terminal/index.ts:9`) داخل النطاق مستقبلًا؟ يحتوي أنماطًا عالمية (`.xterm`, `.xterm-viewport`) تخرج عن قاعدة `.faisal-*` — لم أُدقّقه لأنه خارج النطاق المحدَّد.
6. حد اللمس المقبول: ‏44px إلزامي أم يكفي 36-40px مع توسيع منطقة النقر غير المرئي (`::after`/hit-slop)؟
