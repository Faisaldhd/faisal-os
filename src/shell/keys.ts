/**
 * مساعدات لوحة المفاتيح للـshell.
 *
 * لا تعتمد على `KeyboardEvent.code` وحده: بعض المسارات (أدوات الأتمتة، لوحات مفاتيح
 * افتراضية، إعادة ترميز المتصفح) ترسل `key` بلا `code` قياسي، فيتعطّل الاختصار صامتًا.
 * المطابقة هنا تقبل أيًّا من الاثنين.
 */
export function isKey(ev: KeyboardEvent, letter: string): boolean {
  if (ev.code === `Key${letter.toUpperCase()}`) return true;
  return ev.key.toLowerCase() === letter.toLowerCase();
}
