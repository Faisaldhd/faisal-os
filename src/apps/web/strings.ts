import { defineStrings } from '../../kernel/i18n';

/** Every user-visible string of the Web App window, in both languages. */
defineStrings('web', {
  ar: {
    // toolbar
    back: 'رجوع',
    forward: 'تقدّم',
    reload: 'إعادة التحميل',
    go: 'انتقال',
    addressPlaceholder: 'اكتب عنواناً أو كلمة بحث…',
    openExternal: 'فتح في المتصفح',
    openExternalHint: 'افتح هذا الموقع في تبويب حقيقي',

    // states
    loading: 'جارٍ التحميل…',
    loadingSite: 'جارٍ تحميل {site}…',
    embedWarningBody: 'قد لا يظهر هذا الموقع هنا: السجلات تقول إنه يمنع العرض داخل إطار. إن ظهرت المساحة فارغة، افتحه في المتصفح.',
    blockedTitle: 'لا يمكن عرض هذا الموقع داخل نافذة',
    blockedBody: 'هذا الموقع يطلب من المتصفح عدم عرضه داخل إطار (X-Frame-Options أو سياسة CSP)، وهذا حقّه. لا يحاول Fai$al OS تجاوز ذلك ولا تمرير المحتوى عبر وسيط — تبقى طريقة العرض الوحيدة فتح الموقع نفسه.',
    tryAnyway: 'المحاولة على أي حال',
    timedOutTitle: 'لم يظهر الموقع',
    timedOutBody: 'مرّ وقت طويل دون أن يكتمل تحميل الصفحة. إما أنها بطيئة، أو أنها ترفض العرض داخل إطار. يمكنك إعادة المحاولة أو فتح الموقع في تبويب حقيقي.',
    retry: 'إعادة المحاولة',
    searchNotice: 'بحث في ويكيبيديا عن «{query}» — وهي المحرّك الوحيد الذي يسمح بالعرض داخل إطار.',
    rewrittenNotice: 'تم تحويل الرابط إلى صيغة /embed/ لأن الأصلية ترفض العرض المضمّن.',

    // refusals
    'refused.not-embeddable': 'لا يمكن عرض هذا العنوان: يجب أن يبدأ بـ https:// وأن يكون موقعاً خارجياً، وليس نسخة أخرى من النظام نفسه.',
    'refused.blocked-domain': 'هذا الموقع معروف برفض العرض داخل إطار، فلا نحاول فتحه هنا. استخدم زر «فتح في المتصفح».',
    'refused.unsafe-scheme': 'هذا ليس عنوان ويب. البروتوكولات مثل javascript: و data: و file: لا تُفتح ولا تُعرض هنا إطلاقاً.',
    'refused.empty': 'اكتب عنواناً أو كلمة بحث أولاً.',

    // window titles
    windowTitle: 'تطبيق ويب',
  },
  en: {
    // toolbar
    back: 'Back',
    forward: 'Forward',
    reload: 'Reload',
    go: 'Go',
    addressPlaceholder: 'Type an address or a search…',
    openExternal: 'Open externally',
    openExternalHint: 'Open this site in a real tab',

    // states
    loading: 'Loading…',
    loadingSite: 'Loading {site}…',
    embedWarningBody: 'This site may not appear here: it is recorded as refusing embedded viewing. If the area stays blank, open it in the browser.',
    blockedTitle: 'This site cannot be shown in a window',
    blockedBody: 'This site asks browsers not to display it inside a frame (X-Frame-Options or a CSP frame-ancestors rule), and that is its right. Fai$al OS does not try to bypass that and never proxies the content — the only way to view it is to open the site itself.',
    tryAnyway: 'Try embedding anyway',
    timedOutTitle: 'The site did not appear',
    timedOutBody: 'The page did not finish loading within the time allowed. It may be slow, or it may refuse embedded viewing. You can retry or open the site in a real tab.',
    retry: 'Retry',
    searchNotice: 'Searching Wikipedia for “{query}” — the only engine that permits embedded viewing.',
    rewrittenNotice: 'The link was rewritten to its /embed/ form because the original refuses embedded viewing.',

    // refusals
    'refused.not-embeddable': 'This address cannot be shown: it must be https:// and an external site, not another copy of the OS itself.',
    'refused.blocked-domain': 'This site is known to refuse embedded viewing, so we do not try to open it here. Use “Open externally”.',
    'refused.unsafe-scheme': 'That is not a web address. Schemes such as javascript:, data: and file: are never opened or displayed here.',
    'refused.empty': 'Type an address or a search first.',

    // window titles
    windowTitle: 'Web App',
  },
});
