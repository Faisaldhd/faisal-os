# الوسيط المحلي الاختياري (Local Proxy)

> الحالة: هذا الملف وصفٌ صادق لما بُني وما لم يُتحقَّق منه بعد.
> ما تحقّق فعلاً هنا: `npm run typecheck` و`npm run build` يمرّان، واختبارات
> `src/apps/web/local-proxy.test.ts` تمر — بما فيها اختبارات تشغّل وسيطاً حقيقياً
> على منفذ عشوائي في 127.0.0.1. ما **لم** يتحقّق: العرض الخام عبر إطار حقيقي في
> متصفح حقيقي، لأن البيئة التي كُتب فيها هذا الكود لا تحتوي متصفحاً. القسم الأخير
> يقول للمالك كيف يتحقّق بنفسه.

## ما هذا؟

مخرج طوارئ **اختياري بالكامل**: سكربت صغير يعمل بلا أي اعتماديات خارجية
(`tools/local-proxy.mjs`) يشغّله المالك بنفسه على جهازه. سببه الوحيد أن بعض المواقع
ترسل `X-Frame-Options` أو قاعدة `frame-ancestors` في CSP فتمنع عرضها داخل إطار، وقد
يريد المالك قراءة إحدى تلك الصفحات داخل نافذة Fai$al OS رغم ذلك.

**مُعطَّل افتراضياً، ولا يظهر منه شيء حتى يعمل.** نافذة الويب لا تعرض زر «العرض عبر
الوسيط المحلي» إلا إذا أجاب الوسيط على `GET /health` على `127.0.0.1`. لا يوجد أي
مسار احتياطي: إن لم يعمل السكربت، يبقى العرض مرفوضاً كما هو ويُعرض زر «فتح في المتصفح».

ولا يمرّ شيء عبر طرف ثالث: الطلب يذهب من متصفحك إلى واجهة الاسترجاع في جهازك
(`127.0.0.1`) ويخرج من جهازك إلى الموقع الذي طلبته أنت.

## أمر التشغيل

```bash
node tools/local-proxy.mjs --port 8787 --token <long-random-value>
```

على ويندوز/PowerShell يعمل الأمر نفسه **كما هو** — لا يوجد هنا أي `\` في نهاية سطر، فلا مشكلة
استمرار أسطر أصلاً — لكن يجب تشغيله من مجلد المستودع نفسه، والرمز بالحروف اللاتينية:

```powershell
cd D:\Faisal-OS
node tools/local-proxy.mjs --port 8787 --token faisal-7f3a91c2d4e5b6a7
```

أو احذف `--token` تماماً فيولّد السكربت رمزاً عشوائياً **ويطبعه على الشاشة** لتنسخه إلى نافذة
الويب عند طلبه. هذا الطرف لا يحتاج Docker ولا صلاحيات إدارية ولا أي تثبيت: Node وحده يكفي.

| الخيار | المعنى |
| --- | --- |
| `--port 8787` | المنفذ على `127.0.0.1` فقط. لا يوجد خيار للربط على واجهة عامة: `--host` مرفوض ما لم يكن `127.0.0.1`، و`assertLoopbackHost()` يرفض أي شيء آخر. |
| `--token <long-random-value>` | الرمز الذي يحمي `/fetch` و`/ticket`. استخدم قيمة عشوائية طويلة (32 خانة سادس عشرية على الأقل). إن حذفته، يولّد السكربت واحداً (16 بايت عشوائية = 32 خانة) **ويطبعه على الشاشة**؛ انسخه إلى نافذة الويب عند طلبه. لا يُكتب الرمز في أي ملف ولا يُسجَّل. |
| `--allow host1,host2` | تضييق إضافي: لا يُقبل إلا هذان المضيفان. أي مضيف آخر يُرفض بـ 403، حتى لو كان عنواناً عاماً مشروعاً. |
| `--verbose` | يطبع كل جلب (`[faisal-proxy] raw https://example.com/…`). **لا يطبع التذكرة أبداً** — التذكرة وثيقة اعتماد لجلب واحد، ومكانها ليس ملف سجل. بدون هذا الخيار لا يُسجَّل أي عنوان URL إطلاقاً. |
| `--help` | الاستخدام. |

يُطبع عند التشغيل ملخّص بالعناوين: `/health`، `/fetch`، `/ticket`، `/view`، والرمز.
وإيقافه بـ `Ctrl+C`. **لا يكتب السكربت أي شيء على القرص**: لا ملف، ولا ذاكرة تخزين،
ولا ملف ارتباط مؤقت.

## الوضعان، وما يعرضه كلٌّ منهما بصدق

| الوضع | ماذا يفعل | ما لا يفعله |
| --- | --- | --- |
| **قراءة (reader)** | `GET /fetch?url=…&mode=reader` عبر `fetch` مع الرمز في الترويسة. يُعيد **نص** الصفحة (UTF-8) كما هي، والعميل `src/apps/web/reader.ts` يستخرج الفقرات ويعرضها بعناصر نصّية داخل النظام. | لا تُشغَّل سكربتات الموقع: النص فقط، بلا تنسيق ولا صور ولا روابط تفاعلية. هذا ليس الموقع، بل نصّه. |
| **تضمين خام (raw)** | يحتاج تذكرة (انظر أدناه)، ثم يُحمَّل `GET /view?ticket=…` داخل إطار بنفس صندوق الرمل الأقل صلاحية المستخدم في بقية النظام. الصفحة تُعرض كما هي، والوسيط **يزيل ترويسة الرفض فقط**. | لا يصلح شيئاً آخر: لا يعيد كتابة الروابط النسبية، ولا يحقن سكربتاً، ولا يصلح JavaScript. المواقع الثقيلة غالباً ستبدو مكسورة أو فارغة. |

في الوضع الخام تبقى شارة دائمة («متصفح عبر الوسيط المحلي — وضع الصفحة كما هي») وتحذير
دائم على الشاشة: هذا أفضل ما يمكن، وليس ضماناً.

## مسار التذكرة (فقرة واحدة)

الإطار لا يستطيع إرسال ترويسة `x-faisal-proxy-token` — لا توجد طريقة في HTML لفعل ذلك —
لذلك لا يُعطى الإطار الرمز أبداً. بدلاً منه: النافذة تطلب تذكرة بـ
`GET /ticket?url=<encoded>&mode=raw` **مع الرمز في الترويسة** (نفس المقارنة الثابتة
الزمن ونفس حارس SSRF)، فيجيب الوسيط `{ ticket, expiresIn }` حيث التذكرة 32 بايت
عشوائية (64 خانة سداسية عشرية) ومربوطة بهدف واحد ووضع واحد وصلاحية افتراضية 60 ثانية
وبحد أقصى 32 تذكرة حيّة (الأقدم يُسقط). بعدها فقط تُنشأ النافذة الداخلية بـ
`/view?ticket=<hex>`، وهو مسار **بلا رمز عمداً** لأن الإطار لا يستطيع إرسال ترويسة.
التذكرة **أحادية الاستخدام**: يُحذفها الوسيط من الذاكرة **قبل** أن يطلب الصفحة من
الموقع، فإذا قرأت سكربتات الصفحة المؤطَّرة عنوان نفسها لاحقاً وجدت تذكرة ميتة.
وأي `url=` أو `mode=` مُضاف إلى `/view` يُتجاهل تماماً: التذكرة وحدها تحدّد الهدف والوضع.

## الخصائص الأمنية

- **الربط على 127.0.0.1 فقط.** لا خيار لواجهة عامة، و`assertLoopbackHost()` يرفض أي مضيف آخر.
- **حارس SSRF قبل كل طلب وعلى كل قفزة إعادة توجيه** (`validateTargetUrl` يُنادى في
  `fetchGuarded` قبل كل طلب، والإعادة تُتابع يدوياً بحد 3 قفزات، كل قفزة تُفحص من جديد):
  - البروتوكول: `http:` و`https:` فقط. `file:` و`data:` و`javascript:` و`blob:` و`ftp:` مرفوضة.
  - بيانات الاعتماد داخل العنوان (`https://user:pw@host/`) مرفوضة.
  - العناوين غير القابلة للتحليل تُرفض (فشل مغلق).
  - IPv4 المرفوضة: `0.0.0.0/8`، `10/8`، `100.64/10` (CGNAT)، `127/8` (استرجاع)،
    `169.254/16` (link-local)، `172.16/12`، `192.0.0/24`، `192.0.2/24`، `192.88.99/24`،
    `192.168/16`، `198.18/15`، `198.51.100/24`، `203.0.113/24`، `224/4` (multicast)،
    `240/4` (محجوز، ويشمل `255.255.255.255`)، وأي صيغة رقمية مفردة أخرى (`2130706433`، `0x7f000001`).
  - IPv6 المرفوضة: `::`، `::1`، `::ffff:a.b.c.d` و`::a.b.c.d` (يُعاد فحصها كـ IPv4)،
    `64:ff9b::/96`، `100::/64`، `2001:2::/48`، `2001:db8::/32`، `2001:10::/28`،
    `fc00::/7`، `fe80::/10`، `ff00::/8`، `3fff::/20`، مع معالجة لاحقة النطاق (`fe80::1%eth0`).
  - الأسماء: `localhost` و`*.localhost` و`*.local` و`*.internal` وأي اسم بلا نقطة.
  - **إعادة فحص كل إجابة DNS**، فلا يفيد ربط اسم عام بعنوان خاص (DNS rebinding).
- **`Set-Cookie` لا يُمرَّر أبداً**، ولا `content-security-policy-report-only`، ولا
  `access-control-allow-origin` القادم من الموقع؛ ولا يوجد أي ترويسة `*`.
- **الأصول المسموحة قائمة صريحة قصيرة** (`ALLOWED_APP_ORIGINS`): `https://faisaldhd.github.io`
  و`https://faisal-os.pages.dev`، مع نطاقات المعاينة التابعة للمشروع نفسه فقط
  (`https://<build>.faisal-os.pages.dev`)، وأي `http://localhost:<منفذ>` أو
  `http://127.0.0.1:<منفذ>`. إن نشرت النظام على نطاق آخر ولم يظهر زر الوسيط، فالسبب غالباً هذا:
  أضف الأصل إلى القائمة قبل أن تتوقع أن يعمل.
- **الطلب المسبق (preflight) يُجاب على كل المسارات** ومع ترويسة
  `Access-Control-Allow-Private-Network: true`: كروم يفرض «الوصول إلى الشبكة الخاصة» على أي
  صفحة عامة (`https://faisaldhd.github.io`) تطلب عنواناً محلياً، ويرسل طلباً مسبقاً حتى لطلب
  `GET` بسيط، ويرفض الطلب بلا تلك الترويسة. ولهذا يُجاب `OPTIONS /health` أيضاً: لولا ذلك
  لبدا الوسيط «غير مشغَّل» وهو يعمل. هذه الترويسة لا تمنح شيئاً بذاتها — تقول فقط «هذه خدمتي
  المحلية» — وقد يُظهر كروم مع ذلك طلب إذن «الوصول إلى الشبكة المحلية» فاسمح به. الحاجزان
  الحقيقيان يبقيان الرمز والتذكرة، وأصل غير مسموح لا يحصل على ترويسة أصل إطلاقاً.
- **`X-Frame-Options` و`frame-ancestors` داخل CSP يُحذفان — وهذا هو الغرض الوحيد
  الموثّق من الوسيط**، وباقي توجيهات CSP تبقى كما هي. لا حقن، ولا إعادة كتابة، ولا
  استخراج داخل الوسيط: العميل هو من يستخرج النص في وضع القراءة.
- **الرمز لا يدخل أي عنوان URL**: يُرسل في الترويسة `x-faisal-proxy-token` إلى قاعدة
  الوسيط فقط، ويُخزَّن في `localStorage` تحت `faisal.web.proxy.token`. لذلك لا يمكن أن
  يتسرّب عبر `src` إطار أو مرجع (referrer) أو سجل تصفّح.
- **تذكرة أحادية الاستخدام بعمر 60 ثانية، مربوطة بهدف ووضع واحد**، تُحذف قبل الجلب،
  وبحد أقصى 32 تذكرة حيّة. الإطار يحمل التذكرة فقط: لا رمز، ولا هدف، ولا وضع.
- **لا كتابة على القرص، ولا سجل بدون `--verbose`**، وحتى معه لا تُطبع التذكرة.
- **`/health` بلا رمز عمداً**: لا يحمل بيانات صفحة ولا عنوان هدف (فقط الإصدار وحالة المصادقة).

## حدود صريحة (بلا تجميل)

- **لماذا يعمل `http://127.0.0.1` من صفحة `https`؟** لأن المتصفحات تعتبر واجهة
  الاسترجاع (loopback) أصلاً موثوقاً، فلا تُطبَّق عليها قواعد «المحتوى المختلط».
  سياسة CSP الخاصة بصفحة النظام تسمح أيضاً بـ `frame-src http://127.0.0.1:*`.
- **الوسيط لا ينفع إلا مع المواقع التي ترفض التأطير فقط.** إن كان الموقع يعتمد على
  منع التأطير مع شيء آخر (تسجيل دخول، تحقق من المستخدم، SPA ثقيل) فالتضمين الخام سيفشل.
- **الروابط النسبية وJavaScript الثقيل ستبدو غالباً مكسورة** في الوضع الخام، لأن
  الوسيط لا يعيد كتابة أي شيء ولا يغيّر رؤوس الطلبات الفرعية.
- **القراءة ليست الموقع**: نص مستخرج بلا تنسيق ولا صور ولا نماذج، وهذا مقصود.
- **إعادة تحميل الإطار من داخله تفشل عمداً**: التذكرة أُحرقت بعد أول استعمال، فإعادة
  تحميل الصفحة المؤطَّرة تعرض جسم 410. استخدم زر إعادة التحميل في نافذة Fai$al OS نفسها:
  فهو يطلب تذكرة جديدة ويعرض الصفحة من جديد.
- **لم يُتحقَّق من العرض الخام عبر إطار حقيقي** في البيئة التي كُتب فيها الكود (لا يوجد
  متصفح فيها). المُتحقَّق منه: أن `src` الإطار يحتوي التذكرة فقط ولا يحتوي الرمز ولا
  الهدف ولا `mode=raw`، وأن التذكرة أحادية الاستخدام ولا تفيد بعد استعمالها.

## كيف تتحقّق بنفسك

```bash
npm run typecheck
npx vitest run src/apps/web/local-proxy.test.ts
node tools/local-proxy.mjs --port 8787 --token <long-random-value> --verbose
```

ثم في Fai$al OS: افتح موقعاً يرفض التأطير (مثل `https://www.google.com/`)، اضغط
«العرض عبر الوسيط المحلي»، الصق الرمز، اختر «قراءة» ثم «تضمين خام». في الطرفية يجب أن
ترى سطر `ticket minted for raw` وسطر الجلب `[faisal-proxy] raw https://…` — وبعد
الثانية الأولى يجب ألا تجد في السجل أي 64 خانة سداسية عشرية: التذكرة لا تُسجَّل أبداً.

---

# Local Proxy (English)

> Status: an honest description of what was built and what was **not** verified.
> Verified here: `npm run typecheck`, `npm run test` and `npm run build` pass, and
> `src/apps/web/local-proxy.test.ts` — including tests that start a real proxy on a
> random loopback port — passes. **Not** verified: rendering raw mode through a real
> iframe in a real browser, because the environment this was written in has no
> browser. The last section says how to check that yourself.

## What this is

A fully **opt-in** escape hatch: a small, dependency-free HTTP server
(`tools/local-proxy.mjs`) the owner runs by hand on his own machine. It exists for
exactly one reason — some sites send `X-Frame-Options` or a CSP `frame-ancestors`
rule that forbids being shown in a frame, and the owner may still want to read one of
those pages inside a Fai$al OS window.

**Off by default, and invisible until it runs.** A web window offers the "Use my local
proxy" action only after the proxy answers `GET /health` on `127.0.0.1`. There is no
silent fallback: if the tool is not running, the refusal stands and only "Open in the
browser" is offered.

Nothing goes through a third party: the request travels from your browser to your own
loopback interface and out from your own machine to the site you asked for.

## Run it

```bash
node tools/local-proxy.mjs --port 8787 --token <long-random-value>
```

On Windows this is already PowerShell-safe — there is no line continuation to get wrong — but run
it from the repository directory and keep the token ASCII:

```powershell
cd D:\Faisal-OS
node tools/local-proxy.mjs --port 8787 --token faisal-7f3a91c2d4e5b6a7
```

Or drop `--token` entirely: the script then generates one and prints it for you to paste into the
window when asked. This side needs no Docker, no administrator rights and no installation — Node
alone is enough.

| Option | Meaning |
| --- | --- |
| `--port 8787` | The port, bound to `127.0.0.1` only. There is no way to bind a public interface: `--host` is refused unless it is `127.0.0.1`, and `assertLoopbackHost()` refuses anything else. |
| `--token <long-random-value>` | The token that protects `/fetch` and `/ticket`. Use a long random value (at least 32 hex characters). Without it the tool generates one (16 random bytes = 32 hex characters) **and prints it**; paste it into the window when asked. The token is never written to a file and never logged. |
| `--allow host1,host2` | Extra narrowing: only these hostnames are accepted. Anything else is refused with 403, even a legitimate public address. |
| `--verbose` | Logs each fetch (`[faisal-proxy] raw https://example.com/…`). It **never logs a ticket** — a ticket is a one-fetch credential, and a log file is not where it belongs. Without this flag no URL is logged at all. |
| `--help` | Usage. |

Startup prints the endpoints (`/health`, `/fetch`, `/ticket`, `/view`) and the token;
`Ctrl+C` stops it. **Nothing is ever written to disk**: no file, no cache, no temp
state.

## The two modes, and what each honestly renders

| Mode | What it does | What it does not do |
| --- | --- | --- |
| **Reader** | `GET /fetch?url=…&mode=reader` with the token in a header, over `fetch`. It returns the page **text** (UTF-8) unchanged, and the client (`src/apps/web/reader.ts`) extracts paragraphs and renders them with native, text-only elements. | The site's scripts do not run: text only, no styling, no images, no interactive links. This is the page's text, not the site. |
| **Raw embed** | Needs a ticket (below), then loads `GET /view?ticket=…` into an iframe with the same least-privilege sandbox the rest of the OS uses. The page is shown as-is; the proxy **only removes the refusal header**. | It fixes nothing else: it does not rewrite relative URLs, inject scripts or repair JavaScript. Script-heavy sites will often look broken or empty. |

Raw mode keeps a permanent badge ("Browsing through the local proxy — the page as it
is") and a permanent warning on screen: this is best effort, not a guarantee.

## The ticket flow (one paragraph)

An iframe cannot send the `x-faisal-proxy-token` header — HTML has no way to do it — so
the frame is never given the token. Instead the window asks for a ticket with
`GET /ticket?url=<encoded>&mode=raw` **with the token in a header** (the same
constant-time comparison and the same SSRF guard), and the proxy answers
`{ ticket, expiresIn }`, where the ticket is 32 random bytes (64 hex characters) bound
to one target, one mode and a default 60-second lifetime, with at most 32 live tickets
(the oldest is evicted). Only then is the frame created, pointed at
`/view?ticket=<hex>` — deliberately **token-free**, because the frame cannot send a
header. The ticket is **single-use**: the proxy deletes it from memory **before** it
fetches the page, so a script in the framed page that later reads its own URL finds a
dead ticket. Any `url=` or `mode=` added to `/view` is ignored outright: the ticket
alone decides the target and the mode.

## Security properties

- **Loopback bind only.** No public-interface option; `assertLoopbackHost()` refuses anything else.
- **SSRF guard before every request and on every redirect hop** (`validateTargetUrl` runs
  inside `fetchGuarded` before each request; redirects are followed by hand, at most 3
  hops, each re-validated):
  - Scheme: `http:` and `https:` only. `file:`, `data:`, `javascript:`, `blob:` and `ftp:` are refused.
  - URL-embedded credentials (`https://user:pw@host/`) are refused.
  - Unparseable addresses are refused (fail closed).
  - Refused IPv4: `0.0.0.0/8`, `10/8`, `100.64/10` (CGNAT), `127/8` (loopback),
    `169.254/16` (link-local), `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`,
    `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4` (multicast),
    `240/4` (reserved, including `255.255.255.255`), plus bare decimal/hex spellings
    (`2130706433`, `0x7f000001`).
  - Refused IPv6: `::`, `::1`, `::ffff:a.b.c.d` and `::a.b.c.d` (re-checked as IPv4),
    `64:ff9b::/96`, `100::/64`, `2001:2::/48`, `2001:db8::/32`, `2001:10::/28`,
    `fc00::/7`, `fe80::/10`, `ff00::/8`, `3fff::/20`, with zone suffixes (`fe80::1%eth0`) stripped first.
  - Names: `localhost`, `*.localhost`, `*.local`, `*.internal`, and any name with no dot.
  - **Every DNS answer is re-checked**, so a public name pointing at a private address
    (DNS rebinding) is still refused.
- **`Set-Cookie` is never forwarded**, nor `content-security-policy-report-only`, nor any
  `access-control-allow-origin` from the site; no wildcard is ever sent.
- **The allowed origins are a short, explicit list** (`ALLOWED_APP_ORIGINS`):
  `https://faisaldhd.github.io`, `https://faisal-os.pages.dev`, this project's own preview
  subdomains (`https://<build>.faisal-os.pages.dev`), and any `http://localhost:<port>` or
  `http://127.0.0.1:<port>`. If you deploy the OS somewhere else and the proxy button never
  appears, this list is usually why: add the origin before expecting it to work.
- **A preflight is answered on every route**, with `Access-Control-Allow-Private-Network: true`:
  Chrome enforces Private Network Access on any public page (`https://faisaldhd.github.io`) that
  asks for a local address, preflights even a simple `GET`, and refuses the call without that
  header. That is why `OPTIONS /health` is answered too — otherwise the app would report "no proxy
  running" while the proxy was running fine. The header grants nothing by itself (it only says
  "this is my own loopback service"), Chrome may still show its own local-network permission
  prompt — allow it — and the real gates stay the token and the ticket. An origin that is not on
  the list still receives no allow-origin header at all.
- **`X-Frame-Options` and CSP `frame-ancestors` are removed — the documented and only
  purpose of the proxy**; every other CSP directive is kept. No injection, no rewriting,
  no extraction inside the proxy: the client extracts text in reader mode.
- **The token never enters a URL**: it is sent only in the `x-faisal-proxy-token` header
  to the proxy base, and stored in `localStorage` under `faisal.web.proxy.token`. It
  therefore cannot leak through an iframe `src`, a referrer or browser history.
- **A single-use, 60-second ticket bound to one target and one mode**, deleted before the
  fetch, with at most 32 live tickets. The frame carries the ticket and nothing else: no
  token, no target, no mode.
- **No disk writes, and no log at all without `--verbose`** — and even with it, no ticket
  is ever printed.
- **`/health` is deliberately token-free**: it carries no page data and no target URL
  (only the version and the auth mode).

## Honest limits

- **Why plain `http://127.0.0.1` works from an `https` page**: browsers treat loopback as
  a trustworthy origin, so mixed-content rules do not apply to it, and the OS page's own
  CSP allows `frame-src http://127.0.0.1:*`.
- **The proxy only helps against framing refusal.** If a site blocks framing *and* relies
  on logins, bot checks or a heavy SPA, the raw embed will still fail.
- **Relative URLs and heavy JavaScript will often look broken** in raw mode, because the
  proxy rewrites nothing and does not touch subresource requests.
- **The reader is text, not the site**: no styling, images or forms, on purpose.
- **Reloading the frame from inside it fails on purpose**: the ticket was burned on
  first use, so reloading the framed page shows the 410 body. Use the Fai$al OS window's
  own reload button — it mints a fresh ticket and renders the page again.
- **The end-to-end raw render through a real iframe was not verified** in the environment
  where this was written (it has no browser). What *was* verified: the iframe `src`
  contains only the ticket and never the token, the target URL or `mode=raw`, and the
  ticket is single-use and useless once spent.

## Verify it yourself

```bash
npm run typecheck
npx vitest run src/apps/web/local-proxy.test.ts
node tools/local-proxy.mjs --port 8787 --token <long-random-value> --verbose
```

Then in Fai$al OS: open a site that refuses framing (for example
`https://www.google.com/`), click "Use my local proxy", paste the token, pick "Reader"
and then "Raw embed". In the terminal you should see `ticket minted for raw` followed by
the fetch line `[faisal-proxy] raw https://…` — and you must never see a 64-hex string in
the log: the ticket is never logged.
