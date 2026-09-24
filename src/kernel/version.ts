/**
 * مصدر واحد لإصدار النظام — One source of truth for the version the OS shows.
 *
 * يُستعمل في: تطبيق الإعدادات (حول)، و`/etc/os-release` داخل نظام الملفات،
 * وقائمة الحزم في الطرفية. هذه القيم كانت متعارضة قبل التوحيد (0.1.0 و0.1 و1.0.0-1.nr1).
 * ملاحظة: `package.json` يحمل رقم إصدار الحزمة (packaging) وليس رقم إصدار النظام المعروض.
 */
export const OS_VERSION = '0.3.0';

/** صيغة على نمط RPM تُعرض في `faisal pkg list` — مشتقة حتى لا تنحرف عن OS_VERSION. */
export const OS_RELEASE = `${OS_VERSION}-1.nr1`;
