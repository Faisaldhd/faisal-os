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

/**
 * عنوان النافذة التالية في تدوير النوافذ، أو null إذا لا يوجد ما يُبدَّل إليه.
 *
 * `ids` مرتَّبة من الأسفل إلى الأعلى (مثل `WindowManager.list()`). التركيز على نافذة
 * يرفعها إلى القمة، لذا «التقدّم» يعني النزول درجة واحدة في المكدّس، و`back` يعني العكس.
 * نافذة واحدة فقط ⇒ لا تدوير (كي لا يستهلك الاختصار نفسه بلا أثر مرئي).
 */
export function cycleTarget(ids: readonly string[], focusedId: string | null, back = false): string | null {
  if (ids.length < 2) return null;
  const current = focusedId ? ids.indexOf(focusedId) : -1;
  const from = current === -1 ? ids.length - 1 : current;
  const step = back ? 1 : -1;
  return ids[(from + step + ids.length) % ids.length] ?? null;
}
