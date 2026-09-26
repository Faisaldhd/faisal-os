import { defineStrings } from '../../../kernel/i18n';

/**
 * The sheet's own sentences (Phase C: the one-editor grid, the WPS ribbon, the filter arrows,
 * the phone bar), in Arabic and English. Registered under `office.` like the rest of the window,
 * so `t('office.…')` reads them; the two key sets are identical.
 */
defineStrings('office', {
  ar: {
    sheetGrid: 'خلايا الورقة',
  },
  en: {
    sheetGrid: 'Sheet cells',
  },
});
