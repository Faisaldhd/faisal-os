# المتصفح المُبثّ (Streamed Browser)

> الحالة: هذا الملف وصفٌ صادق لما بُني وما لم يُتحقَّق منه بعد.
> كُتب داخل بيئة **لا يوجد فيها Docker**، فلم تُشغَّل حاوية ولم تُشاهد صورة مبثوثة.
> ما تحقّق فعلاً هنا: الكود يُبنى، واختبارات `src/apps/stream/stream.test.ts` تمر،
> وأوامر Docker أدناه مأخوذة من التوثيق الرسمي الحالي (روابط المصادر في آخر الملف)
> لا من تجربة عملية. القسم «كيف تتحقّق بنفسك» هو ما يجب على المالك تشغيله.

## ما هذه الميزة؟

تطبيق واحد داخل Fai$al OS (`org.faisal.Stream`) محتوى نافذته **إطار (iframe)** يشير إلى
عميل بثّ يشغّله المالك بنفسه. داخل الحاوية يعمل **Chromium حقيقي**، والشاشة التي تراها في
النافذة هي شاشة ذلك المتصفح.

لماذا هذا يحلّ مشكلة جوجل ويوتيوب؟ لأن `X-Frame-Options` و`frame-ancestors` تمنعان
**هذه الصفحة** من تأطير موقعهما. هنا لا نؤطّر جوجل ولا يوتيوب إطلاقاً: الحاوية تفتحهما
كصفحتين عاديتين في متصفحها، وما نؤطّره نحن هو عميل البثّ فقط. لا التفاف ولا وسيط ولا كسر
لأي سياسة.

**لا يتغيّر شيء في مدير النوافذ ولا في النواة.** هذه نافذة عادية، ومحتواها إطار، تماماً
مثل أي تطبيق ويب آخر في النظام.

## أمر التشغيل (نيكو / neko — WebRTC)

```bash
docker run -d --rm --name faisal-neko \
  --shm-size=2g \
  -p 127.0.0.1:8080:8080 \
  -p 127.0.0.1:56000-56100:56000-56100/udp \
  -e NEKO_WEBRTC_EPR=56000-56100 \
  -e NEKO_WEBRTC_NAT1TO1=127.0.0.1 \
  -e NEKO_MEMBER_MULTIUSER_USER_PASSWORD=<password> \
  -e NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=<adminpassword> \
  ghcr.io/m1k1o/neko/chromium:latest
```

ثم افتح في Fai$al OS تطبيق **المتصفح المُبثّ** بعنوانه الافتراضي `http://127.0.0.1:8080`.

تفصيل كل سطر، ولماذا هو مكتوب هكذا:

| الجزء | المعنى |
| --- | --- |
| `ghcr.io/m1k1o/neko/chromium:latest` | صورة Chromium الرسمية الحالية من GHCR (متعددة المعماريات). اسم `m1k1o/neko:chromium` على Docker Hub هو بناء تطويري من فرع `master` وبمعمارية AMD64 فقط؛ التوثيق الرسمي يفضّل GHCR. |
| `-p 127.0.0.1:8080:8080` | المنفذ الافتراضي `8080` (TCP): صفحة العميل + الـ WebSocket الذي يجري فيه التفاوض. الربط بـ `127.0.0.1` يعني أن الحاوية **لا تُرى من الشبكة**، فقط من هذا الجهاز. |
| `-p 127.0.0.1:56000-56100:56000-56100/udp` + `NEKO_WEBRTC_EPR=56000-56100` | نطاق منافذ WebRTC الفعلية (UDP). يجب أن يكون **النطاق نفسه على الطرفين بلا إعادة تعيين**، وأن يُفتح كما هو في جدار الحماية. لا يوجد نطاق «مقدّس» واحد: أمثلة التوثيق الرسمي تستخدم `56000-56100` و`52000-52100`؛ القاعدة الوحيدة أن `NEKO_WEBRTC_EPR` = المنافذ المنشورة. بديل منفذ واحد: `NEKO_WEBRTC_UDPMUX=56000` مع نشر `56000/udp` واحد. |
| `--shm-size=2g` | **ضروري** لصور Chromium: حجم `/dev/shm` الافتراضي في Docker أصغر من أن يحتمله Chromium، وبدونه ترى شاشة سوداء أو انهيارات. |
| `-e NEKO_WEBRTC_NAT1TO1=127.0.0.1` | يُخبر العميل بأن يصل إلى `127.0.0.1` — صحيح **فقط** لأن العميل والحاوية على الجهاز نفسه. على خادم بعيد: احذفه (يكتشف العنوان العام تلقائياً) أو ضع العنوان العام أو عنوان الشبكة المحلية الصحيح. تحذير التوثيق الرسمي: لا تضع `127.0.0.1` إذا كان العملاء على أجهزة أخرى، لأن كل عميل سيحاول الاتصال بـ localhost الخاص به ولن ينجح شيء. |
| `NEKO_MEMBER_MULTIUSER_USER_PASSWORD` / `..._ADMIN_PASSWORD` | كلمتا مرور يختارهما المالك (مستخدم/مدير). هذه هي أسماء الإعدادات في الإصدار 3؛ في الإصدار 2 كانت `NEKO_PASSWORD` و`NEKO_PASSWORD_ADMIN`. **لا تُشغّل الحاوية بلا كلمة مرور.** |

### على ويندوز (PowerShell): سطر واحد لكل أمر

`\` في نهاية السطر أعلاه **خاص بـbash** ولا معنى له في PowerShell. لصق الأمر متعدد الأسطر في
نافذة PowerShell ينفّذ السطر الأول فقط، ثم يفشل الباقي برسائل مثل
`-p : The term '-p' is not recognized`. لذلك على ويندوز استخدم السطر الواحد التالي
(واستبدل `<password>` و`<adminpassword>` بكلمات مرور تختارها، **بالإنجليزية**: نص عربي داخل
أمر shell سبب ثانٍ للفشل قبل أن يعمل Docker أصلاً):

```powershell
docker run -d --rm --name faisal-neko --shm-size=2g -p 127.0.0.1:8080:8080 -p 127.0.0.1:56000-56100:56000-56100/udp -e NEKO_WEBRTC_EPR=56000-56100 -e NEKO_WEBRTC_NAT1TO1=127.0.0.1 -e NEKO_MEMBER_MULTIUSER_USER_PASSWORD=<password> -e NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=<adminpassword> ghcr.io/m1k1o/neko/chromium:latest
```

وللبديل الأخف على ويندوز:

```powershell
docker run -d --name faisal-chromium --shm-size=1gb -p 127.0.0.1:3001:3001 -e PUID=1000 -e PGID=1000 -e TZ=UTC -e CUSTOM_USER=<user> -e PASSWORD=<password> -v faisal-chromium-config:/config lscr.io/linuxserver/chromium:latest
```

وإن ظهر `docker : The term 'docker' is not recognized`، فـDocker غير مثبَّت على الجهاز أصلاً
(على ويندوز يحتاج Docker Desktop، وهو بدوره يحتاج WSL2: `wsl --install` من نافذة مسؤول ثم
إعادة تشغيل). تحقّق بـ`docker --version` قبل أي شيء آخر. ومن لا يريد Docker إطلاقاً: تطبيق
سطح المكتب في المستودع يحمّل المواقع داخل webview بلا قيود التأطير، والوسيط المحلي
(`docs/LOCAL_PROXY.md`) يحتاج Node فقط.

### البديل الأخف للأجهزة الضعيفة (WebSocket بدل WebRTC)

```bash
docker run -d --name faisal-chromium \
  --shm-size=1gb \
  -p 127.0.0.1:3001:3001 \
  -e PUID=1000 -e PGID=1000 -e TZ=UTC \
  -e CUSTOM_USER=<user> -e PASSWORD=<password> \
  -v faisal-chromium-config:/config \
  lscr.io/linuxserver/chromium:latest
```

ثم استخدم العنوان `https://127.0.0.1:3001` في التطبيق (لاحظ **https**، لا http).

- هذه الصورة تبثّ عبر WebSocket لا WebRTC، فلا تحتاج نطاق منافذ UDP ولا تفاوض ICE:
  أخفّ على معالج ضعيف وعلى شبكة مقيّدة تمنع UDP.
- المنفذ `3001` يقدّم **HTTPS بشهادة موقّعة ذاتياً** افتراضياً، و`3000` هو منفذ HTTP
  المخصّص للوقوف خلف وكيل عكسي. متطلبات WebCodecs في المتصفحات الحديثة تحتاج سياقاً آمناً
  (https) لعرض الصورة والفيديو، ولهذا نستخدم `3001` مباشرة.
- الصورة الحالية مبنية على منصّة **Selkies** (فرع KasmVNC القديم مُهمَل حسب سجل إصدارات
  الصورة)، والتشغيل ما زال عبر WebSocket. لذلك لا نصفها هنا بأنها «WebRTC».
- **الشهادة الموقّعة ذاتياً عقبة حقيقية**: الإطار داخل نافذة النظام هو سياق آخر، وعند رفض
  الشهادة سيظهر خطأ بدل الصورة. الحلّان: (١) افتح `https://127.0.0.1:3001` مرة واحدة في
  نفس المتصفح واقبل الاستثناء (يُحفظ للملف الشخصي نفسه فيُقبل لاحقاً داخل الإطار)، أو
  (٢) الأفضل: وكيل عكسي بشهادة موثوقة (mkcert أو Let's Encrypt) أمام الحاوية.
- لا مصادقة افتراضية في هذه الصورة. `CUSTOM_USER` + `PASSWORD` يفعّلان HTTP basic auth
  (مناسب لشبكة محلية موثوقة). تحذير الصورة الرسمية: واجهتها تحتوي طرفية بـ sudo بلا كلمة
  مرور — **من يصل إلى الواجهة يصل إلى root داخل الحاوية**.

## على خادم بعيد (VPS): وكيل عكسي بـ TLS + مصادقة

الشكل الصحيح:

1. **TLS أولاً**: Caddy أو nginx أمام الحاوية، بشهادة موثوقة، والعنوان العام `https://…`.
2. **مصادقة إلزامية** بأحد طريقين:
   - **دخول العميل نفسه**: كلمة مرور نيكو للمستخدم/المدير (أو `CUSTOM_USER`/`PASSWORD`
     لصورة linuxserver). هذا هو الأفضل مع الإطار، لأن تسجيل الدخول صفحة عادية داخل العميل.
   - **HTTP basic auth** على الوكيل العكسي (`auth_basic` في nginx، `basicauth` في Caddy)،
     إن أردت حماية إضافية قبل وصول الطلب إلى الحاوية.
3. **منافذ WebRTC لا تمرّ عبر الوكيل العكسي**: WebRTC ليس HTTP، ولا يمكن لـ nginx أو أي
   وكيل عكسي تمريره. إما تفتح نطاق UDP للعالم، أو تستخدم خادم TURN، أو تختار صورة
   WebSocket (linuxserver/chromium) التي تمرّ كلها عبر منفذ واحد.

لماذا المصادقة ليست تفصيلاً؟ **حاوية متصفح مكشوفة بلا مصادقة = وكيل مفتوح**. أي شخص
يعثر على العنوان يملك متصفحاً كاملاً يعمل من خادمك: يتصفّح، يسجّل الدخول بحساباتك إن
تركت جلسة محفوظة، يستهلك نطاقك ومعالجك، ويستعمل عنوانك في نشاط لا علاقة لك به.
مع نيكو تحديداً يمكن للمستخدم أن يشارك الملفات ويشغّل الحافظة (clipboard) ويرى كل ما
يجري على سطح المكتب. هذا ليس خطراً نظرياً؛ إنه التعريف الحرفي لوكيل مفتوح.

## المكسب الأمني: العزل

- **متصفح الحاوية لا يرى متصفحك الحقيقي**: كوكيز جلساتك، كلمات المرور المحفوظة، سجل
  التصفّح، إضافاتك، وملفاتك — لا شيء من ذلك موجود داخل الحاوية. ملفها الشخصي مستقل تماماً.
- **لا شيء من Fai$al OS يصل إلى الحاوية**: لا ملفات من الـ VFS، ولا إعدادات، ولا صلاحية
  من صلاحيات النواة، ولا مفتاح API، ولا سرّ. التطبيق يقرأ عنواناً واحداً من `localStorage`
  ويمرّره إلى الإطار. لا `postMessage` في أي اتجاه، ولا `contentWindow`، ولا قراءة لِـ DOM
  الإطار.
- **الإطار عبر أصل مختلف (cross-origin)** ومعزول بأقلّ سماح ممكن:
  `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"`،
  و`allow="fullscreen; encrypted-media; picture-in-picture"`، و`referrerpolicy="no-referrer"`.
  `allow-same-origin` آمن هنا فقط لأن الإطار ليس من أصل النظام أبداً، فلا يوجد هروب
  same-origin إلى صفحة النظام.
- **لا إذن حافظة (clipboard) في هذه النسخة الأولى** — لا في `sandbox` ولا في `allow` ولا
  في سياسة النظام. نقل نصّ من جهازك إلى المتصفح المُبثّ ميزة حقيقية، لكنها تحتاج قراراً
  صريحاً، وهي بند متابعة في `docs/SECURITY_REVIEW.md` لا افتراضٌ صامت.

## الملف الشخصي: مؤقّت افتراضياً

- **الافتراضي مؤقّت**: الأمر أعلاه لا يربط أي مجلد، فكل ما تفعله داخل متصفح الحاوية —
  بما فيه تسجيلات الدخول — يضيع عند حذف الحاوية. هذا هو الخيار الآمن.
- **لتثبيت تسجيلات الدخول** اربط مجلداً (مثال لـ Chromium):

  ```bash
  -v faisal-neko-profile:/home/neko/.config/chromium
  ```

  ⚠️ تحذير صريح: المجلد الدائم يحفظ **كوكيز جلساتك ومفاتيح دخولك** على قرص الجهاز. من
  يقرأ ذلك الملف يقرأ حسابك. لا تفعل هذا على جهاز مشترك، ولا على خادم لا تملكه وحدك، ولا
  تحفظ فيه حساباً حسّاساً. ولصورة linuxserver/chromium المجلد هو `/config` (كما في الأمر
  أعلاه). التوثيق الرسمي يحذّر أيضاً من أن ملفاً شخصياً تالفاً أو مملوكاً لمستخدم خاطئ
  يمنع المتصفح من الإقلاع (شاشة سوداء).

## حدود صريحة (بلا تجميل)

1. **يحتاج Docker يعمل** على جهاز أو خادم تملكه. **لا يعمل على GitHub Pages وحده**:
   الصفحة الثابتة لا تستطيع تشغيل حاوية، وميزة البثّ بلا حاوية خلفها لا وجود لها.
2. **الموارد**: نحو معالج واحد (CPU) و١–٢ جيجابايت من الذاكرة أثناء التشغيل، فوق ما
   تستهلكه الحاوية نفسها في القرص (~ جيجابايت للصورة).
3. **زمن استجابة أعلى من متصفح محلي**: كل صورة تُرمَّز في الحاوية ثم تسافر إلى جهازك.
   الكتابة والتمرير يظهران بتأخير ملحوظ، والعمل التفاعلي السريع (تحرير نص طويل) مزعج.
4. **لوحة المفاتيح لا تعمل حتى تنقر داخل النافذة مرة واحدة**: المكتبات الرسومية داخل
   الحاوية لا تعرف من يملك التركيز إلا بعد نقرة. قبل ذلك يذهب ما تكتبه إلى النظام، لا إلى
   المتصفح المُبثّ. هذه طبيعة البثّ، لا خلل في النظام.
5. **فيديو 4K والألعاب لن تكون سلسة**: الترميز يجري على معالج الحاوية (بلا GPU)، والصوت
   والفيديو يتأخران. فيديو 1080p مضبوط الإعداد مقبول؛ 4K و60 إطاراً ليسا هدفاً واقعياً.
6. **الفحص يُثبت «استجاب» فقط**: التطبيق يرسل طلباً واحداً، وأي جواب — صفحة فارغة أو غير
   مفهومة أو معتمة (opaque) — يُعدّ وصولاً. «استجاب» لا تعني «الصورة ستعمل»، ولذلك الشارة
   تقول دائماً «متصفح مُبثّ» ولا تقول «متصل».
7. **لا يوجد Docker في بيئة بناء هذه الميزة**، فلم تُجرَّب حاوية ولا صورة مبثوثة هنا.

## سياسة النظام التي تعتمد عليها هذه الميزة

صفحة Fai$al OS تحمل سياسة أمان محتوى (CSP) في `index.html`. القاعدتان المتعلّقتان بهذه
الميزة:

- `frame-src` يجب أن يسمح بالعنوان المستخدم: الأصول البعيدة **يجب أن تكون https**، والعناوين
  المحلية (`127.0.0.1` / `localhost`) مسموحة بـ http لأن الحاوية على الجهاز نفسه.
- `connect-src` يجب أن يسمح بالعنوان نفسه، وإلا فشل فحص الوصول (probe) ولو كانت الحاوية
  تعمل — وهذا موثّق في سابقتين داخل المستودع (`src/apps/web/search.ts`).

لذلك: **عنوان بعيد بـ http يُرفض**. التطبيق لا يعرض إطاراً فارغاً في هذه الحالة، بل يقول
صراحة إن العناوين البعيدة يجب أن تبدأ بـ https، والسبب هو سياسة النظام. الحلّ ليس تعطيل
السياسة، بل وكيل عكسي بشهادة موثوقة أمام الحاوية.

## كيف تتحقّق بنفسك (على جهاز فيه Docker)

1. **شغّل الحاوية** بالأمر أعلاه (استبدل `<password>` بكلمة مرور تختارها).
2. **تأكّد أن الواجهة تعمل قبل النظام**: افتح `http://127.0.0.1:8080` في متصفح عادي،
   سجّل الدخول بكلمة المرور، ويجب أن ترى شاشة Chromium داخل الحاوية.
3. **افتح التطبيق**: من المشغّل (Activities) أو من الشريط السفلي — «المتصفح المُبثّ».
4. **ما يجب أن تراه في النافذة**:
   - شارة دائمة في الشريط: **«متصفح مُبثّ»** وبجانبها العنوان المفحوص؛
   - زر **ملء الشاشة** (أيقونة الزوايا) وزر **«تغيير العنوان»**؛
   - الإطار يعرض واجهة العميل نفسها التي رأيتها في الخطوة 2.
5. **تحقّق من ملاحظة لوحة المفاتيح**: قبل النقر داخل الإطار اكتب شيئاً — لن يظهر في
   المتصفح المُبثّ. انقر مرة واحدة داخل الإطار ثم اكتب — سيظهر. هذه هي السلوك المتوقّع
   الموثّق، لا خطأ.
6. **تحقّق من الصدق عند الفشل**: أوقف الحاوية (`docker stop faisal-neko`) ثم اضغط
   «تغيير العنوان» ← «تحقّق». يجب أن ترى شاشة الإعداد مع رسالة «لم يستجب هذا العنوان»،
   وأمر التشغيل، والحدود — **لا إطار فارغ ولا رسالة نجاح ملفّقة**.

## قائمة استكشاف الأعطال

| العَرَض | السبب المرجّح | ما تفعله |
| --- | --- | --- |
| الإطار أسود، أو الشاشة داخل الحاوية سوداء مع مؤشّر | `--shm-size` صغير جداً (وهذا أشهر سبب لصور Chromium) | أضف `--shm-size=2g` وأعد إنشاء الحاوية |
| الواجهة تفتح ثم «connection timeout» / «disconnected» | منافذ UDP غير منشورة أو محجوبة، أو `NEKO_WEBRTC_EPR` لا يطابق المنافذ المنشورة | تأكّد أن النطاق منشور `/udp` بنفس الأرقام (`docker ps`)، وافتحه في جدار الحماية، واختبر الوصول بـ `nc -ul`، أو انتقل إلى `NEKO_WEBRTC_UDPMUX` بمنفذ واحد، أو إلى صورة WebSocket |
| «Failed to ping without candidate pairs» | `NEKO_WEBRTC_NAT1TO1` يشير إلى عنوان لا يستطيع العميل الوصول إليه | على الجهاز نفسه: `127.0.0.1`. على خادم بعيد: العنوان العام أو الشبكة المحلية الصحيحة، أو احذفه ليكتشفه تلقائياً |
| الشاشة تعمل من الخارج ولا تعمل محلياً | الراوتر لا يدعم NAT Loopback | استخدم TURN، أو انظر التوثيق الرسمي لاستكشاف الأخطاء |
| خطأ شهادة داخل الإطار (مع linuxserver/chromium أو وكيل عكسي) | شهادة موقّعة ذاتياً | اقبل الشهادة مرة في نفس الملف الشخصي للمتصفح، أو ضع وكيلاً عكسياً بشهادة موثوقة |
| يتصل لكن الصورة ممزّقة/متأخرة، أو الجهاز ضعيف | WebRTC + ترميز على المعالج | للأجهزة الضعيفة: استخدم بديل WebSocket (linuxserver/chromium)، أو **وضع الصور JPEG**: في نيكو فعّل الارتداد Screencast (`NEKO_CAPTURE_SCREENCAST_ENABLED=true` مع `NEKO_CAPTURE_SCREENCAST_RATE` و`..._QUALITY`) ليستلم العميل صور JPEG عبر HTTP. التوثيق الرسمي يصفه بوضوح: **ارتداد احتياطي** بتأخير أعلى وجودة أقل ونطاق أعلى، لا بديل دائم للبثّ |
| رسالة «لم يستجب هذا العنوان» والحاوية تعمل | العنوان أو المنفذ مختلفان، أو أن الجهاز يحجب `127.0.0.1` على ذلك المنفذ | راجع العنوان في التطبيق، وجرّب فتحه في متصفح عادي أولاً |
| «عنوان بعيد بلا تشفير» | عنوان http بعيد عن الجهاز | ضع https (وكيل عكسي بشهادة موثوقة) |

## المصادر (تحقّقت منها عند كتابة هذا الملف)

- تثبيت نيكو وأمر Docker الرسمي: <https://neko.m1k1o.net/docs/v3/installation>
- صور نيكو (GHCR مقابل Docker Hub، وشرط `--shm-size=2g`): <https://neko.m1k1o.net/docs/v3/installation/docker-images>
- إعداد WebRTC (نطاق المنافذ EPR، ومنافذ MUX، وNAT1TO1): <https://neko.m1k1o.net/docs/v3/configuration/webrtc>
- التقاط الصورة وارتداد JPEG (Screencast): <https://neko.m1k1o.net/docs/v3/configuration/capture>
- استكشاف أعطال نيكو (الشاشة السوداء، UDP، NAT1TO1): <https://neko.m1k1o.net/docs/v3/troubleshooting>
- صورة linuxserver/chromium والمنافذ 3000/3001 والمصادقة: <https://docs.linuxserver.io/images/docker-chromium/>
- أمان Selkies (لماذا يجب تأمين الواجهة): <https://docs.linuxserver.io/selkies/user-guide/security>

---

# Streamed Browser (English)

> Status: an honest description of what was built and what has not yet been verified.
> This file was written in an environment **without Docker**, so no container was run and no
> streamed picture was ever observed. What is actually verified here: the code builds, and
> `src/apps/stream/stream.test.ts` passes. The Docker commands below come from the current
> official documentation (sources at the end), not from a live run. The section
> "Verify it yourself" is what the owner must execute.

## What this feature is

One app inside Fai$al OS (`org.faisal.Stream`) whose window content is an **iframe** pointing
at a streaming client the owner runs. A **real Chromium** runs inside the container, and the
screen you see in the window is that browser's screen.

Why this solves Google and YouTube: `X-Frame-Options` and `frame-ancestors` stop **this page**
from framing those sites. Nothing here frames Google or YouTube — the container's browser opens
them as ordinary top-level pages, and the only thing we frame is the streaming client. No
bypass, no proxy, no violation of anyone's policy.

**Nothing changes in the window manager or the kernel.** This is an ordinary window whose
content is a frame, like any other web app in the system.

## Run it (neko — WebRTC)

```bash
docker run -d --rm --name faisal-neko \
  --shm-size=2g \
  -p 127.0.0.1:8080:8080 \
  -p 127.0.0.1:56000-56100:56000-56100/udp \
  -e NEKO_WEBRTC_EPR=56000-56100 \
  -e NEKO_WEBRTC_NAT1TO1=127.0.0.1 \
  -e NEKO_MEMBER_MULTIUSER_USER_PASSWORD=<password> \
  -e NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=<adminpassword> \
  ghcr.io/m1k1o/neko/chromium:latest
```

Then open the **Streamed Browser** app in Fai$al OS on its default endpoint `http://127.0.0.1:8080`.

| Part | Meaning |
| --- | --- |
| `ghcr.io/m1k1o/neko/chromium:latest` | The current official Chromium image from GHCR (multi-arch). `m1k1o/neko:chromium` on Docker Hub is a development build from `master`, AMD64 only; the official docs prefer GHCR. |
| `-p 127.0.0.1:8080:8080` | The default port `8080` (TCP): the client page plus the WebSocket used for negotiation. Binding to `127.0.0.1` means the container is **not reachable from the network**, only from this machine. |
| `-p 127.0.0.1:56000-56100:56000-56100/udp` + `NEKO_WEBRTC_EPR=56000-56100` | The actual WebRTC (UDP) port range. It must be **identical on both sides with no remapping**, and opened exactly like that in the firewall. There is no single blessed range: the official examples use `56000-56100` and `52000-52100`; the only rule is `NEKO_WEBRTC_EPR` = the published ports. Single-port alternative: `NEKO_WEBRTC_UDPMUX=56000` with one published `56000/udp`. |
| `--shm-size=2g` | **Required** for Chromium images: Docker's default `/dev/shm` is too small for Chromium, and without this you get a black screen or crashes. |
| `-e NEKO_WEBRTC_NAT1TO1=127.0.0.1` | Tells the client to connect to `127.0.0.1` — correct **only** when the client and the container are on the same machine. On a remote server, remove it (the public address is auto-detected) or set the correct public/LAN address. Official warning: never use `127.0.0.1` there, because every client would then try its own localhost and nothing would connect. |
| `NEKO_MEMBER_MULTIUSER_USER_PASSWORD` / `..._ADMIN_PASSWORD` | Passwords the owner chooses (user/admin). These are the version-3 setting names; version 2 used `NEKO_PASSWORD` and `NEKO_PASSWORD_ADMIN`. **Never run the container without a password.** |

### On Windows (PowerShell): one line per command

The trailing `\` in the block above is **bash syntax** and means nothing in PowerShell. Pasting
the multi-line command into a PowerShell window runs the first line and then fails on the rest
with errors like `-p : The term '-p' is not recognized`. On Windows use the single line below
instead, replacing `<password>` and `<adminpassword>` with passwords you choose — **in ASCII**:
Arabic text inside a shell command is a second way to fail before Docker even starts.

```powershell
docker run -d --rm --name faisal-neko --shm-size=2g -p 127.0.0.1:8080:8080 -p 127.0.0.1:56000-56100:56000-56100/udp -e NEKO_WEBRTC_EPR=56000-56100 -e NEKO_WEBRTC_NAT1TO1=127.0.0.1 -e NEKO_MEMBER_MULTIUSER_USER_PASSWORD=<password> -e NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=<adminpassword> ghcr.io/m1k1o/neko/chromium:latest
```

And the lighter option on Windows:

```powershell
docker run -d --name faisal-chromium --shm-size=1gb -p 127.0.0.1:3001:3001 -e PUID=1000 -e PGID=1000 -e TZ=UTC -e CUSTOM_USER=<user> -e PASSWORD=<password> -v faisal-chromium-config:/config lscr.io/linuxserver/chromium:latest
```

If you see `docker : The term 'docker' is not recognized`, Docker is not installed at all. On
Windows that means Docker Desktop, which itself needs WSL2 (`wsl --install` from an administrator
window, then a reboot). Check `docker --version` first. And if you would rather not run Docker:
the desktop build in this repository loads sites in a real webview with no framing restrictions,
and the local proxy (`docs/LOCAL_PROXY.md`) needs nothing but Node.

### The lighter alternative for weak machines (WebSocket instead of WebRTC)

```bash
docker run -d --name faisal-chromium \
  --shm-size=1gb \
  -p 127.0.0.1:3001:3001 \
  -e PUID=1000 -e PGID=1000 -e TZ=UTC \
  -e CUSTOM_USER=<user> -e PASSWORD=<password> \
  -v faisal-chromium-config:/config \
  lscr.io/linuxserver/chromium:latest
```

Then use `https://127.0.0.1:3001` in the app (note **https**, not http).

- This image streams over WebSocket, not WebRTC: no UDP range, no ICE negotiation — lighter on
  a weak CPU and on networks that block UDP.
- Port `3001` serves **HTTPS with a self-signed certificate** by default; `3000` is the HTTP
  port meant to sit behind a reverse proxy. Modern browser media features (WebCodecs) need a
  secure context, which is why we use `3001` directly.
- The current image is built on the **Selkies** platform (the older KasmVNC branch is
  deprecated per the image's release history) and still streams over WebSocket — so it is not
  described here as WebRTC.
- **The self-signed certificate is a real obstacle**: the frame is a different context, and a
  rejected certificate shows an error instead of a picture. Two fixes: (1) open
  `https://127.0.0.1:3001` once in the same browser profile and accept the exception (it is
  remembered for that profile and the frame will then load), or (2) better, put a reverse proxy
  with a trusted certificate (mkcert or Let's Encrypt) in front of the container.
- No authentication by default. `CUSTOM_USER` + `PASSWORD` enable HTTP basic auth (fine for a
  trusted LAN). The image's own warning: its interface includes a terminal with passwordless
  sudo — **anyone who reaches the GUI can become root inside the container**.

## On a VPS: reverse proxy with TLS + authentication

1. **TLS first**: Caddy or nginx in front of the container, a trusted certificate, public
   `https://…` endpoint.
2. **Authentication is mandatory**, by either route:
   - **the client's own login**: neko's user/admin password (or `CUSTOM_USER`/`PASSWORD` for the
     linuxserver image). This is the best fit for a framed client, because logging in is an
     ordinary page inside the client.
   - **HTTP basic auth** on the reverse proxy (`auth_basic` in nginx, `basicauth` in Caddy), if
     you want a barrier before the request even reaches the container.
3. **WebRTC ports do not go through the reverse proxy**: WebRTC is not HTTP, and no proxy can
   forward it. Either expose the UDP range publicly, use a TURN server, or choose the WebSocket
   image (linuxserver/chromium), which travels entirely over one port.

Why authentication is not a detail: **an unauthenticated browser container is an open proxy.**
Anyone who finds the address gets a full browser running from your server: they browse, they use
your saved sessions, they burn your bandwidth and CPU, and they act under your address. With
neko specifically, a user can share files, use the clipboard, and watch the whole desktop. This
is not a theoretical risk; it is the literal definition of an open proxy.

## The isolation win

- **The container's browser cannot see your real browser**: your session cookies, saved
  passwords, history, extensions and files simply do not exist inside the container, which has
  its own separate profile.
- **Nothing from Fai$al OS reaches the container**: no VFS files, no settings, no kernel
  capability, no API key, no secret. The app reads one URL from `localStorage` and hands it to
  the frame. No `postMessage` in either direction, no `contentWindow`, no reading the frame's DOM.
- **The frame is cross-origin** and sandboxed to the least it needs:
  `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"`,
  `allow="fullscreen; encrypted-media; picture-in-picture"`, `referrerpolicy="no-referrer"`.
  `allow-same-origin` is safe here only because the frame is never on the OS origin, so there is
  no same-origin escape back into the OS page.
- **No clipboard permission in this first version** — not in `sandbox`, not in `allow`, not in
  the system policy. Moving text from your machine into the streamed browser is a real feature,
  but it needs an explicit decision; it is a follow-up in `docs/SECURITY_REVIEW.md`, not a
  silent default.

## Profile: ephemeral by default

- **Ephemeral by default**: the command above mounts no volume, so everything you do in the
  container's browser — including logins — is lost when the container is removed. That is the
  safe choice.
- **To persist logins**, mount a directory (Chromium example):

  ```bash
  -v faisal-neko-profile:/home/neko/.config/chromium
  ```

  ⚠️ Explicit warning: the persistent directory stores **your session cookies and login tokens**
  on disk. Whoever reads that file reads your account. Do not do this on a shared machine, on a
  server you do not exclusively own, or for a sensitive account. For the linuxserver/chromium
  image the directory is `/config` (as in the command above). The official docs also warn that a
  corrupted or wrongly-owned profile prevents the browser from starting (black screen).

## Honest limits

1. **Needs Docker running** on a machine or server you own. **It cannot work on GitHub Pages
   alone**: a static page cannot run a container, and a streaming feature with no container
   behind it does not exist.
2. **Resources**: roughly one CPU core and 1–2 GB of RAM while it runs, on top of the disk the
   image itself occupies (~1 GB).
3. **Higher latency than a local browser**: every frame is encoded in the container and travels
   to your machine. Typing and scrolling are visibly delayed, and fast interactive work (editing
   long text) is annoying.
4. **The keyboard does not work until you click once inside the window**: the graphical stack in
   the container does not know who holds focus until it receives a click. Before that, what you
   type goes to the OS, not to the streamed browser. This is the nature of streaming, not a bug
   in the system.
5. **4K video and games will not be smooth**: encoding happens on the container's CPU (no GPU),
   and audio/video lag. Properly configured 1080p is acceptable; 4K at 60 fps is not a realistic
   target.
6. **The probe proves "it answered" only**: the app sends one request, and any answer — an empty
   page, an unreadable body, an opaque response — counts as reachable. "Answered" does not mean
   "the picture will work", which is why the badge always says "Streamed browser" and never
   "connected".
7. **No Docker exists in the environment where this feature was built**, so no container and no
   streamed picture were ever tested here.

## The system policy this feature relies on

The Fai$al OS page carries a Content-Security-Policy in `index.html`. Two rules matter here:

- `frame-src` must allow the endpoint used: remote origins **must be https**, while loopback
  addresses (`127.0.0.1` / `localhost`) are allowed over http because the container is on the
  same machine.
- `connect-src` must allow the same endpoint, otherwise the reachability probe fails even while
  the container is running — a constraint already documented in this repository twice
  (`src/apps/web/search.ts`).

Therefore **a remote http endpoint is refused**. The app never shows a blank frame in that case:
it says plainly that remote endpoints must start with https, because of the system's own policy.
The fix is not to weaken the policy but to put a reverse proxy with a trusted certificate in
front of the container.

## Verify it yourself (on a machine with Docker)

1. **Start the container** with the command above (replace `<password>` with a password you choose).
2. **Confirm the client works outside the OS**: open `http://127.0.0.1:8080` in a normal browser,
   log in with the password, and you should see the container's Chromium screen.
3. **Open the app**: from the launcher (Activities) or the bottom dock — "Streamed Browser".
4. **What the window must show**:
   - a permanent badge in the toolbar: **"متصفح مُبثّ / Streamed browser"**, with the probed
     endpoint next to it;
   - a **fullscreen** button (corner icon) and a **"تغيير العنوان / Change address"** button;
   - the frame showing the same client interface you saw in step 2.
5. **Verify the keyboard-focus caveat**: before clicking inside the frame, type something — it
   will not appear in the streamed browser. Click once inside the frame and type again — it will.
   That is the documented expected behaviour, not a failure.
6. **Verify honest failure**: stop the container (`docker stop faisal-neko`), then use
   "Change address" → "Check". You must see the setup screen with "This endpoint did not answer",
   the run commands and the limits — **never a blank frame and never a fabricated success**.

## Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| The frame is black, or the container screen is black with a cursor | `--shm-size` too small (the most common cause on Chromium images) | Add `--shm-size=2g` and recreate the container |
| The client loads, then "connection timeout" / "disconnected" | UDP ports not published or blocked, or `NEKO_WEBRTC_EPR` does not match the published ports | Check the range is published as `/udp` with identical numbers (`docker ps`), open it in the firewall, test with `nc -ul`, or move to `NEKO_WEBRTC_UDPMUX` on one port, or to the WebSocket image |
| "Failed to ping without candidate pairs" | `NEKO_WEBRTC_NAT1TO1` points at an address the client cannot reach | Same machine: `127.0.0.1`. Remote server: the real public/LAN address, or remove it for auto-detection |
| Works externally, not locally | The router lacks NAT loopback | Use TURN, or follow the official troubleshooting page |
| A certificate error inside the frame (linuxserver/chromium or a reverse proxy) | Self-signed certificate | Accept it once in the same browser profile, or put a reverse proxy with a trusted certificate in front |
| It connects but the picture is torn/laggy, or the machine is weak | WebRTC plus CPU encoding | On weak machines use the WebSocket alternative (linuxserver/chromium), or **JPEG mode**: in neko enable the Screencast fallback (`NEKO_CAPTURE_SCREENCAST_ENABLED=true` with `NEKO_CAPTURE_SCREENCAST_RATE` and `..._QUALITY`) so the client receives JPEG images over HTTP. The official docs describe it plainly as a **fallback**: higher latency, lower quality, more bandwidth — not a permanent replacement for the stream |
| "This endpoint did not answer" while the container runs | Wrong address or port, or the machine blocks `127.0.0.1` on that port | Re-check the address in the app, and try opening it in a normal browser first |
| "A remote address without encryption" | An http endpoint that is not on this machine | Use https (a reverse proxy with a trusted certificate) |

## Sources (checked while writing this file)

- Neko installation and the official Docker command: <https://neko.m1k1o.net/docs/v3/installation>
- Neko images (GHCR vs Docker Hub, `--shm-size=2g`): <https://neko.m1k1o.net/docs/v3/installation/docker-images>
- WebRTC configuration (EPR range, MUX ports, NAT1TO1): <https://neko.m1k1o.net/docs/v3/configuration/webrtc>
- Capture and the JPEG fallback (Screencast): <https://neko.m1k1o.net/docs/v3/configuration/capture>
- Neko troubleshooting (black screen, UDP, NAT1TO1): <https://neko.m1k1o.net/docs/v3/troubleshooting>
- linuxserver/chromium image, ports 3000/3001, authentication: <https://docs.linuxserver.io/images/docker-chromium/>
- Selkies security (why the interface must be secured): <https://docs.linuxserver.io/selkies/user-guide/security>
