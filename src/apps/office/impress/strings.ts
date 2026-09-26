/**
 * Impress — the slide editor's own strings (كتابة النص وتنسيقه).
 *
 * A namespace of its own (`impress.…`), so the text-formatting slice keeps its words with the
 * code that shows them instead of opening the shared `office/strings.ts` that other work in this
 * app is editing. Arabic and English are registered together; `parafmt.test.ts` proves the two
 * key sets stay equal.
 */
import { defineStrings } from '../../../kernel/i18n';

defineStrings('impress', {
  ar: {
    'textGroup': 'النص',
    'bold': 'عريض',
    'italic': 'مائل',
    'underline': 'تسطير',
    'fontSize': 'حجم الخط',
    'fontColor': 'لون النص',
    'colorAuto': 'تلقائي',
    'alignRight': 'محاذاة لليمين',
    'alignCenter': 'توسيط',
    'alignLeft': 'محاذاة لليسار',
    'editHint': 'انقر نقرًا مزدوجًا على أي مربع نص لتكتب فيه مباشرة.',
    'selectTextBox': 'اختر مربع نص أولًا لتنسيقه.',
    'textStyle': 'تنسيق النص',
    'connector': 'رابط',
    'connectFirst': 'اختر الشكل الذي يبدأ منه الرابط.',
    'connectSecond': 'اختر الشكل الذي ينتهي عنده الرابط.',
    'connectSame': 'اختر شكلًا آخر ليكتمل الرابط.',
    'connectNotShape': 'لا يمكن ربط خطّ بشكل آخر — اختر مربعًا أو شكلًا.',
    'connectDone': 'أُضيف الرابط وهو متصل بالشكلين، وسيبقى متصلًا عند تحريكهما.',
    'connectCancelled': 'أُلغي الربط.',
  },
  en: {
    'textGroup': 'Text',
    'bold': 'Bold',
    'italic': 'Italic',
    'underline': 'Underline',
    'fontSize': 'Font size',
    'fontColor': 'Text colour',
    'colorAuto': 'Automatic',
    'alignRight': 'Align right',
    'alignCenter': 'Centre',
    'alignLeft': 'Align left',
    'editHint': 'Double-click any text box to type in it.',
    'selectTextBox': 'Select a text box first to format it.',
    'textStyle': 'Text formatting',
    'connector': 'Connector',
    'connectFirst': 'Pick the shape the connector starts from.',
    'connectSecond': 'Pick the shape the connector ends at.',
    'connectSame': 'Pick a different shape to finish the connector.',
    'connectNotShape': 'A connector cannot be attached to another connector — pick a box or a shape.',
    'connectDone': 'Connector added and attached to both shapes; it will follow them when they move.',
    'connectCancelled': 'Connector cancelled.',
  },
});
