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
  },
});
