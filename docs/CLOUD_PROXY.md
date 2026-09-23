# الوسيط السحابي الخاص — Cloud proxy

## بالعربي

وسيط خاص بك على Cloudflare Pages Functions (`functions/proxy`)، يعرض المواقع التي ترفض العرض داخل إطار (مثل جوجل) **بوضع القراءة** داخل النظام، على الجوال أو أي متصفح، بدون تشغيل شيء على جهازك.

**التفعيل (مرة واحدة):**
1. Cloudflare → Workers & Pages → مشروع `faisal-os` → **Settings → Variables and Secrets**.
2. **Add** → النوع **Secret** → الاسم `FAISAL_PROXY_TOKEN` → القيمة: رمز سري طويل تختاره أنت (مثلاً 32 حرفاً عشوائياً).
3. احفظ، ثم **Deployments → Retry deployment** (أو ادمج أي تحديث) ليُطبَّق.
4. في النظام: افتح موقعاً يرفض الإطار ← «القراءة عبر وسيطك السحابي» ← الصق الرمز مرة واحدة (يُحفظ في متصفحك فقط).

**الحدود الأمنية:** قراءة فقط (لا تضمين خام، لأن الصفحة كانت ستعمل من نطاق النظام نفسه)، لا يعمل بدون رمزك، يرفض العناوين المحلية والخاصة ويعيد الفحص عند كل تحويل، لا كوكيز، لا تخزين، حد 2MB و10 ثوانٍ. بدون الرمز السري يكون الوسيط مطفأً تماماً.

## English

An owner-only proxy on Cloudflare Pages Functions that shows frame-refusing sites **in reader mode** inside the OS, from any browser. Turn it on by adding a **Secret** named `FAISAL_PROXY_TOKEN` to the `faisal-os` Pages project (Settings → Variables and Secrets) and redeploying; paste the same value in the OS once. Reader-only, token-gated, SSRF-guarded on every hop, no cookies, no storage, 2 MB / 10 s caps. Off entirely until the secret exists. Logic and security notes: `tools/cloud-proxy.mjs`.
