# ديب سيك هارنس داخل Fai$al OS (DeepSeek Harness)

> الحالة: هذا الملف وصفٌ صادق لما بُني وما لم يُتحقَّق منه بعد.
> كُتب في بيئة **لم تُؤطَّر فيها واجهة DSH الحقيقية**: خادم DSH على هذا الجهاز يردّ 401
> على كل مسار بلا رمز، فلم تُشاهَد الواجهة داخل نافذة النظام. ما تحقّق فعلاً:
> `npm run typecheck` و`npm test` و`npm run build` تمر كلها، واختبارات
> `src/apps/dsh/dsh.test.ts` (39 اختباراً) تغطّي المُدقّق والفحص والتخزين ونافذة jsdom.
> القسم «كيف تتحقّق بنفسك» هو ما يجب على المالك تشغيله بنفسه.

## ما هذه الميزة؟

تطبيق واحد داخل Fai$al OS (`org.faisal.DSH`) محتوى نافذته **إطار (iframe)** يشير إلى واجهة
ويب لـ**ديب سيك هارنس (DeepSeek Harness — DSH)**: وكيل المحادثة والبرمجة الذي يشغّله المالك
على جهازه. النافذة عادية تماماً، ومدير النوافذ والنواة لا يعرفان عنها شيئاً.

**DSH مشروع منفصل تماماً عن Fai$al OS.** لا هو جزء من النظام، ولا النظام جزء منه:

- المستودع الرسمي: <https://github.com/deepseek-ai/deepseek-harness>
- يُثبَّت ويُشغَّل **خارج** النظام، على جهاز المالك.
- حزمة سطر الأوامر هي `@deepseek-ai/dsh`، وأمر الويب هو `dsh web`.

## كيف تشغّله (خارج النظام)

**صفحة في المتصفح لا تستطيع تشغيل برنامج على جهازك.** هذا ليس قيداً في Fai$al OS، بل قاعدة
أمنية في كل متصفح. لذلك يجب تشغيل DSH بنفسك أولاً، ثم تعرض النافذة النتيجة.

على ويندوز / PowerShell — سطر واحد (هو نفسه الحرف الذي يعرضه التطبيق في شاشة الإعداد):

```powershell
cd $HOME\Projects\deepseek-harness; corepack pnpm dsh web
```

ولمن لا يريد نسخة محلية من المستودع (يكفي Node):

```powershell
npx @deepseek-ai/dsh web
```

ملاحظات على الأمرين:

- لا يوجد نص عربي داخل الأوامر عن قصد: **أمر الطرفية نص برمجي لا نص أدبي**، والحرف العربي
  داخله سبب فشل إضافي قبل أن يعمل Node أصلاً.
- `;` في PowerShell هي فاصل الجمل نفسه، فالسطر يبقى سطراً واحداً وقابل للّصق مرة واحدة.
- لا يوجد `\` في نهاية أي سطر: `\` امتداد أسطر في bash ولا معنى له في PowerShell.
- يحتاج DSH إلى **Node.js 22.19 أو أحدث** (أو 24+). تحقّق بـ`node --version` قبل أي شيء.
- على هذا الجهاز يوجد أيضاً مشغّل سطح المكتب **`Deepseek.bat`** يشغّل DSH بالنقر المزدوج.

## الواجهة محميّة برمز: انسخ العنوان كاملاً

هذا أهم تفصيل عملي في هذه الميزة:

- خادم DSH يردّ **401 على كل مسار** بلا رمز دخول — بما فيها `/` و`/index.html`.
- `/health` غير موجودة أصلاً (404).
- لذلك العنوان الذي يُفتح في متصفح عادي هو **العنوان الكامل الذي يطبعه DSH عند التشغيل**،
  وفيه `?token=…`. هذا هو ما يجب لصقه في حقل التطبيق.

التطبيق يحفظ العنوان كما هو — **بما فيه سلسلة الاستعلام** — في مفتاح محلي خاص به اسمه
`faisal.dsh.url`. لا يُحفظ في `sys.settings` (التطبيق لا يملك صلاحية `settings` ولا يطلبها)،
ولا يُرسل إلى أي مكان آخر.

## ما الذي يعبر من النظام إلى الواجهة؟ العنوان وحده

- **لا `postMessage` في أي اتجاه**، ولا `contentWindow`، ولا قراءة أو تعديل لِـ DOM الإطار.
- لا ملفات من الـ VFS، ولا إعدادات، ولا صلاحية من صلاحيات النواة، ولا مفتاح API، ولا سرّ.
- الإطار **من أصل مختلف (cross-origin)** دائماً — حتى لو كان على `127.0.0.1` بمنفذ آخر — ومعزول
  بضبط أدنى من السماح.
- عند تشغيل الواجهة لأول مرة، **قد تظهر نافذة موافقة من DSH نفسه** (لأنه خادم محلي يفتح
  جلسة). هذه نافذة DSH، لا نافذة Fai$al OS.

## sandbox وallow — والحافظة (clipboard)

القيمتان المشحونتان حرفياً:

```
sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
allow="clipboard-read; clipboard-write; fullscreen"
referrerpolicy="no-referrer"
```

- `allow-same-origin` آمن هنا فقط لأن الإطار ليس من أصل صفحة النظام أبداً، فلا يوجد هروب
  same-origin إلى مستند النظام.
- **الحافظة ممنوحة هنا، ومرفوضة عمداً في المتصفح المُبثّ** (`src/apps/stream/config.ts`).
  السبب: هذا الإطار أداة المالك المحلية على جهازه، وواجهة محادثة بلا لصق غير قابلة للاستخدام:
  كتابة طلب تعني لصق نص أو كود أو مسار. أما المتصفح المُبثّ فيؤطّر جلسة متصفح بعيدة، ومنح
  الحافظة هناك يعني تسليم صفحة غير موثوقة حافظة المالك. هذا الفرق مقصود ومُثبَّت باختبار،
  لا سهو.
- كل علم sandbox آخر خارج القائمة: لا `allow-top-navigation`، ولا
  `allow-popups-to-escape-sandbox`، ولا `allow-modals`، ولا `allow-presentation`.

## الفحص: «استجاب» ليست «مصرَّح له»

الفحص يرسل **طلباً واحداً** (`GET`، `mode: 'no-cors'`، `credentials: 'omit'`،
`cache: 'no-store'`)، ولا يقرأ الردّ ولا يفهمه:

- أي جواب — صفحة كاملة، أو صفحة 401 فارغة — يجعل الطلب **ينجح** عند المتصفح، فيُعدّ ذلك
  «استجاب».
- أي رفض (لا خادم، أو منفذ مغلق) أو انتهاء مهلة (4 ثوان) يُعدّ «لم يستجب».
- الردّ من نوع opaque؛ لا يمكن قراءة حالته ولا محتواه، وهذا مقصود: لا نريد قراءة أي شيء.

لذلك **الشارة تقول «هارنس محلي / Local harness» دائماً، ولا تقول «متصل» أبداً**، وشاشة الإعداد
تقول ذلك صراحة.

## الشاشتان

1. **الواجهة (view = ready):** إذا استجاب العنوان، يُعرض الإطار في مسرح دائم، مع زر **ملء الشاشة**،
   وزر **«افتح في تبويب جديد»**، وزر **«تغيير العنوان»** الذي **يخفي الإطار فقط** ولا يهدمه —
   فمحادثة جارية تبقى حيّة عند الرجوع.
2. **الإعداد (view = setup):** إذا لم يستجب العنوان، أو ضغط المالك «تغيير العنوان»، تظهر شاشة
   صادقة: ما هو DSH، وأنه يُشغَّل خارج النظام، والأوامر الجاهزة مع أزرار نسخ، ومشغّل
   `Deepseek.bat`، وحقل العنوان الكامل مع زر «تحقّق»، وزر صريح **«افتح الإطار على أي حال»**
   يعرض شريط «الاتصال غير مؤكَّد» فوق الإطار، والحدود الصريحة، ورابط التوثيق.
3. **الرفض (view = setup، سبب = insecure-remote):** إن كان العنوان بعيداً وبـ`http` (لا
   `https`) فلا يُنشأ إطار **ولا يُرسل أي فحص**، ويُقال السبب: سياسة النظام نفسها تسمح بـ`http`
   للعناوين المحلية فقط.

## حدود صريحة (بلا تجميل)

1. **يحتاج Node.js 22.19+ ونسخة من مستودع DSH** (أو `npx` كبديل لا يحتاج نسخة محلية).
2. **يجب تشغيله بيدك خارج النظام**: لا يستطيع النظام تشغيل برنامج على جهازك، ولا يبدأ DSH
   ولا يوقفه. إن لم يكن الخادم يعمل فلا واجهة.
3. **الواجهة محميّة برمز**: رابط بلا `token` يعرض 401، ولا يمكن للنظام تجاوز ذلك.
4. **النظام يعرض الإطار فقط**: لا يقرأ محتواه، ولا يتحكّم فيه، ولا يرسل إليه بيانات.
5. **إن أوقفت DSH** فسيبقى الإطار في النافذة معطّلاً حتى تضغط «تغيير العنوان» ← «تحقّق».
6. **لم تُجرَّب واجهة DSH حقيقية داخل هذه النافذة** أثناء بناء الميزة: المنفذ يردّ 401 على كل
   مسار بلا رمز، فالتغطية الحقيقية هي اختبارات jsdom لا مشاهدة بشرية.
7. **على الويب (نطاق عام) قد لا يستطيع النظام الوصول إلى `127.0.0.1` أصلاً** — وهذه نتيجة
   قياس، لا تخمين: من رابط معاينة Cloudflare العام جرّبتُ فتح التطبيق في Chrome، فظهرت **شاشة
   الإعداد الصادقة** ولم يُنشأ إطار، بلا أي خطأ في Console. السبب أن المتصفح يفرض **Private
   Network Access** على الطلبات من أصل عام إلى الحلقة المحلية، وخادم DSH لا يجيب على طلبها
   المسبق. أما من `localhost` (وضع التطوير) فالإطار يُنشأ فعلاً ويشير إلى `http://127.0.0.1:3080/`
   بنفس صندوق الرمل، وتطبيق سطح المكتب (أصل `app://`) لا يخضع لهذا القيد.
   الحلّ العملي على الويب: افتح واجهة DSH في تبويب عادي، أو استخدم تطبيق سطح المكتب.

## سياسة النظام التي تعتمد عليها هذه الميزة

صفحة Fai$al OS تحمل سياسة أمان محتوى (CSP) في `index.html`، وهي تسمح أصلاً بـ:

- `frame-src`: `https:` و`http://127.0.0.1:*` و`http://localhost:*`
- `connect-src`: نفس عناوين الحلقة المحلية (localhost loopback)

أي أن **`index.html` لم يُلمَس في هذه الميزة**: القاعدتان موجودتان سابقاً لتطبيق المتصفح
المُبثّ. لذلك عنوان بعيد بـ`http` يُرفض، والحلّ ليس تعطيل السياسة بل وكيل عكسي بشهادة موثوقة.

## كيف تتحقّق بنفسك

1. **شغّل DSH خارج النظام** بالأمر أعلاه، وانتظر حتى يطبع عنوان الواجهة الكامل (وفيه `token`).
2. **تأكّد من الواجهة قبل النظام**: افتح العنوان الكامل في متصفح عادي — يجب أن ترى واجهة DSH.
3. **افتح التطبيق**: من المشغّل (Activities) أو الشريط السفلي — «ديب سيك هارنس».
4. **الصق العنوان الكامل** (مع `?token=…`) في الحقل ثم اضغط «تحقّق».
5. **ما يجب أن تراه**: شارة دائمة «هارنس محلي / Local harness»، العنوان بجانبها، وأزرار
   ملء الشاشة و«افتح في تبويب جديد» و«تغيير العنوان»، والإطار يعرض الواجهة نفسها التي رأيتها
   في الخطوة 2.
6. **تحقّق من الصدق عند الفشل**: أوقف DSH من نافذة الطرفية (Ctrl+C) ثم «تغيير العنوان» ←
   «تحقّق». يجب أن ترى شاشة الإعداد مع «لا شيء يستجيب على هذا العنوان» والأوامر والحدود —
   **لا إطار فارغ ولا رسالة نجاح ملفّقة**.
7. **تحقّق من الرمز**: الصق العنوان **بدون** `token` واضغط «تحقّق». الفحص سينجح (الخادم
   يستجيب!) ويُعرض الإطار، لكنك سترى 401 داخل الإطار. هذا هو الفرق بين «استجاب» و«مصرَّح له»
   بالضبط، وهو ما تقوله شاشة الإعداد بأمانة.

---

# DeepSeek Harness inside Fai$al OS

> Status: an honest description of what was built and what has not yet been verified.
> It was written in an environment where **the real DSH interface was never framed**: the
> DSH server on this machine answers 401 on every path without a token, so the interface was
> never observed inside an OS window. What is actually verified: `npm run typecheck`,
> `npm test` and `npm run build` all pass, and `src/apps/dsh/dsh.test.ts` (39 tests) covers
> the validator, the probe, storage and a jsdom window. The section "Verify it yourself" is
> what the owner must run.

## What this feature is

One app inside Fai$al OS (`org.faisal.DSH`) whose window content is an **iframe** pointing at the
web interface of the **DeepSeek Harness (DSH)**: the agent/chat harness the owner runs on his own
machine. The window is ordinary, and neither the window manager nor the kernel knows about it.

**DSH is a project entirely separate from Fai$al OS.** It is not part of the system, and the
system is not part of it:

- Official repository: <https://github.com/deepseek-ai/deepseek-harness>
- It is installed and started **outside** the OS, on the owner's machine.
- The command-line package is `@deepseek-ai/dsh`, and the web command is `dsh web`.

## How to start it (outside the OS)

**A page in a browser cannot start a program on your machine.** That is not a Fai$al OS
limitation but a security rule in every browser. So DSH must be started by hand first, and the
window then shows the result.

On Windows / PowerShell — one line (the same literal the app shows on its setup screen):

```powershell
cd $HOME\Projects\deepseek-harness; corepack pnpm dsh web
```

And for anyone without a local copy of the repository (Node is enough):

```powershell
npx @deepseek-ai/dsh web
```

Notes on both commands:

- No Arabic text appears inside the commands on purpose: **a terminal command is program text,
  not prose**, and an Arabic word inside it is one more way to fail before Node even starts.
- `;` is PowerShell's own statement separator, so the line stays one line and one paste.
- No trailing `\`: a backslash continuation is bash syntax and means nothing in PowerShell.
- DSH needs **Node.js 22.19 or newer** (or 24+). Check `node --version` first.
- On this machine there is also a desktop launcher, **`Deepseek.bat`**, which starts DSH on a
  double click.

## The interface is token-protected: copy the whole address

This is the most important practical detail of the feature:

- The DSH server answers **401 on every path** without a credential — including `/` and
  `/index.html`.
- `/health` does not exist at all (404).
- Therefore the address that works in a normal browser is **the full URL DSH prints when it
  starts**, carrying `?token=…`. That is what must be pasted into the app's field.

The app stores the address exactly as pasted — **query string included** — in its own local key
named `faisal.dsh.url`. It is not stored in `sys.settings` (the app has no `settings` permission
and does not request one), and it is sent nowhere else.

## What crosses from the OS into the interface? The URL, and nothing else

- **No `postMessage` in either direction**, no `contentWindow`, and no reading or scripting of
  the frame's DOM.
- No VFS files, no settings, no kernel capability, no API key, no secret.
- The frame is **cross-origin** always — even on `127.0.0.1` on a different port — and sandboxed
  to the least it needs.
- The first time the interface runs, **DSH itself may show a consent screen** (it is a local
  server opening a session). That is DSH's own screen, not a Fai$al OS one.

## sandbox and allow — and the clipboard

The two shipped values, literally:

```
sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
allow="clipboard-read; clipboard-write; fullscreen"
referrerpolicy="no-referrer"
```

- `allow-same-origin` is safe here only because the frame is never on the OS page's origin, so
  there is no same-origin escape into the OS document.
- **The clipboard is granted here and deliberately refused in the Streamed Browser**
  (`src/apps/stream/config.ts`). The reason: this frame is the owner's own local tool on his own
  machine, and a chat UI without paste is unusable — composing a prompt means pasting text, code
  or a path. The Streamed Browser frames a remote browser session, where granting the clipboard
  would hand the owner's clipboard to an untrusted page. The difference is intentional and
  pinned by a test, not an oversight.
- Every other sandbox flag stays out: no `allow-top-navigation`, no
  `allow-popups-to-escape-sandbox`, no `allow-modals`, no `allow-presentation`.

## The probe: "answered" is not "authorised"

The probe sends **one request** (`GET`, `mode: 'no-cors'`, `credentials: 'omit'`,
`cache: 'no-store'`), and neither reads nor parses the reply:

- Any answer — a full page, or an empty 401 page — makes the request **succeed** at the browser,
  which counts as "answered".
- Any rejection (no server, closed port) or timeout (4 seconds) counts as "did not answer".
- The response is opaque; neither its status nor its body can be read, and that is intentional:
  nothing should be read.

So **the badge always says "هارنس محلي / Local harness" and never "connected"**, and the setup
screen says so in as many words.

## The two views

1. **Interface (view = ready):** if the address answers, the frame is shown in a persistent stage
   with a **fullscreen** button, an **"open in a new tab"** button, and a **"change address"**
   button that only *hides* the frame instead of destroying it — so a live chat survives the trip
   to the setup screen.
2. **Setup (view = setup):** if the address does not answer, or the owner presses "change
   address", an honest screen appears: what DSH is, that it must be started outside the OS, the
   copy-ready commands with copy buttons, the `Deepseek.bat` launcher, the full URL field with a
   "Check" button, an explicit **"open the frame anyway"** action that shows a "connection not
   confirmed" bar above the frame, the honest limits, and the documentation link.
3. **Refusal (view = setup, reason = insecure-remote):** if the address is remote and plain
   `http` (not `https`), no frame is created **and no probe is sent**, and the reason is stated:
   the system's own policy allows `http` for loopback addresses only.

## Honest limits

1. **Needs Node.js 22.19+ and a copy of the DSH repository** (or `npx` as the no-checkout route).
2. **You must start it yourself, outside the OS**: the OS cannot start a program on your machine,
   and it neither starts nor stops DSH. If no server is running, there is no interface.
3. **The interface is token-protected**: a link without the `token` shows 401, and the OS cannot
   bypass that.
4. **The OS only shows the frame**: it does not read it, does not control it, and sends it no
   data.
5. **If you stop DSH**, the frame stays in the window broken until you press "change address" →
   "Check".
6. **The real DSH interface was never framed while this feature was built**: the port answers 401
   on every path without a token, so the real coverage is the jsdom tests, not human observation.
7. **On the web (a public origin) the OS may not be able to reach `127.0.0.1` at all** — measured,
   not assumed: opening the app in Chrome from the public Cloudflare preview URL showed the honest
   **setup screen and created no frame**, with no console error, because the browser enforces
   **Private Network Access** on a public page's request to loopback and the DSH server does not
   answer its preflight. From `localhost` (development) the frame IS created and points at
   `http://127.0.0.1:3080/` with the sandbox above, and the desktop build (origin `app://`) is not
   subject to that rule. The practical workaround on the web: open the DSH interface in an ordinary
   tab, or use the desktop app.

## The system policy this feature relies on

The Fai$al OS page carries a Content-Security-Policy in `index.html`, which already allows:

- `frame-src`: `https:`, `http://127.0.0.1:*`, `http://localhost:*`
- `connect-src`: the same loopback addresses

That means **`index.html` was not touched by this feature**: both rules exist already for the
Streamed Browser app. A remote `http` endpoint is therefore refused, and the fix is not to weaken
the policy but to put a reverse proxy with a trusted certificate in front of it.

## Verify it yourself

1. **Start DSH outside the OS** with the command above and wait for it to print the full interface
   URL (the one carrying `token`).
2. **Confirm the interface outside the OS**: open that full URL in a normal browser — you should
   see the DSH interface.
3. **Open the app**: from the launcher (Activities) or the bottom dock — "DeepSeek Harness".
4. **Paste the full URL** (with `?token=…`) into the field and press "Check".
5. **What you must see**: a permanent badge "هارنس محلي / Local harness", the address next to it,
   the fullscreen / "open in a new tab" / "change address" buttons, and the frame showing the same
   interface you saw in step 2.
6. **Verify honest failure**: stop DSH in its terminal (Ctrl+C), then "change address" → "Check".
   You must see the setup screen with "Nothing answers on this address", the commands and the
   limits — **never a blank frame and never a fabricated success**.
7. **Verify the token**: paste the address **without** the `token` and press "Check". The probe
   will succeed (the server does answer!) and the frame will load, but you will see the 401 inside
   the frame. That is exactly the difference between "answered" and "authorised", and it is what
   the setup screen states plainly.
