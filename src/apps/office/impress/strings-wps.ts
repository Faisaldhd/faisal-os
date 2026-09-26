/**
 * Impress — the WPS-style editor's strings (الشريط والتصميم ولوحة التنسيق).
 *
 * Same `impress.…` namespace as `strings.ts` (which imports this file), kept apart so the ribbon,
 * the design themes, the format pane and the phone bar keep their words next to each other.
 * Arabic and English are registered together; `parafmt.test.ts` proves the key sets stay equal.
 */
import { defineStrings } from '../../../kernel/i18n';

defineStrings('impress', {
  ar: {
    'showEnd': 'انتهى عرض الشرائح — انقر للخروج.',
  },
  en: {
    'showEnd': 'End of slide show — click to exit.',
  },
});
