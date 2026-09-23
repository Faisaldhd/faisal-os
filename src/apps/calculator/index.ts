import type { AppContext, AppModule } from '../../kernel/types';
import { defineStrings, t } from '../../kernel/i18n';
import { calc, formatNumber, CalcError, type AngleMode } from './engine';
import { ICON_CALCULATOR } from './icon';
import './calculator.css';

defineStrings('calculator', {
  ar: {
    title: 'الآلة الحاسبة',
    basic: 'أساسي',
    advanced: 'متقدم',
    deg: 'درجة',
    rad: 'راديان',
    arabicDigits: '٠١٢',
    history: 'السجل',
    historyEmpty: 'لا توجد عمليات بعد',
    clearHistory: 'مسح',
    errDiv0: 'لا يمكن القسمة على صفر',
    errDomain: 'خطأ في النطاق',
    errSyntax: 'تعبير غير صالح',
    errOverflow: 'الناتج كبير جداً',
    errGeneric: 'خطأ',
  },
  en: {
    title: 'Calculator',
    basic: 'Basic',
    advanced: 'Advanced',
    deg: 'Deg',
    rad: 'Rad',
    arabicDigits: '0-9',
    history: 'History',
    historyEmpty: 'No calculations yet',
    clearHistory: 'Clear',
    errDiv0: 'Cannot divide by zero',
    errDomain: 'Domain error',
    errSyntax: 'Invalid expression',
    errOverflow: 'Result is too large',
    errGeneric: 'Error',
  },
});

type Mode = 'basic' | 'advanced';

interface HistoryEntry {
  expr: string;
  result: string;
}

interface KeyDef {
  label: string;
  insert?: string;
  action?: 'clear' | 'back' | 'equals' | 'sign' | 'percentSuffix';
  cls?: string;
}

function launch(ctx: AppContext): void {
  const { window: win } = ctx;

  let expr = '';
  let mode: Mode = 'basic';
  let angleMode: AngleMode = 'deg';
  let arabicDigits = false;
  let lastResult: number | null = null;
  let history: HistoryEntry[] = [];

  const root = document.createElement('div');
  root.className = 'faisal-calc';

  const main = document.createElement('div');
  main.className = 'faisal-calc-main';

  // ── toolbar ──
  const toolbar = document.createElement('div');
  toolbar.className = 'faisal-calc-toolbar';

  const modeSeg = document.createElement('div');
  modeSeg.className = 'faisal-calc-seg';
  const basicBtn = document.createElement('button');
  basicBtn.textContent = t('calculator.basic');
  const advBtn = document.createElement('button');
  advBtn.textContent = t('calculator.advanced');
  modeSeg.append(basicBtn, advBtn);

  const angleSeg = document.createElement('div');
  angleSeg.className = 'faisal-calc-seg';
  const degBtn = document.createElement('button');
  degBtn.textContent = t('calculator.deg');
  const radBtn = document.createElement('button');
  radBtn.textContent = t('calculator.rad');
  angleSeg.append(degBtn, radBtn);

  const spacer = document.createElement('div');
  spacer.className = 'faisal-calc-spacer';

  const digitsToggle = document.createElement('button');
  digitsToggle.className = 'faisal-calc-toggle';
  digitsToggle.textContent = t('calculator.arabicDigits');

  toolbar.append(modeSeg, angleSeg, spacer, digitsToggle);

  // ── display ──
  const display = document.createElement('div');
  display.className = 'faisal-calc-display';
  const exprEl = document.createElement('div');
  exprEl.className = 'faisal-calc-expr';
  exprEl.dir = 'ltr';
  const resultEl = document.createElement('div');
  resultEl.className = 'faisal-calc-result';
  resultEl.dir = 'ltr';
  resultEl.textContent = '0';
  display.append(exprEl, resultEl);

  // ── advanced function strip ──
  const fnRow = document.createElement('div');
  fnRow.className = 'faisal-calc-fnrow';

  // ── pad ──
  const pad = document.createElement('div');
  pad.className = 'faisal-calc-pad';

  main.append(toolbar, fnRow, display, pad);

  // ── history sidebar ──
  const historyPane = document.createElement('div');
  historyPane.className = 'faisal-calc-history';
  const historyHead = document.createElement('div');
  historyHead.className = 'faisal-calc-history-head';
  const historyTitle = document.createElement('span');
  historyTitle.textContent = t('calculator.history');
  const historyClear = document.createElement('button');
  historyClear.className = 'faisal-calc-history-clear';
  historyClear.textContent = t('calculator.clearHistory');
  historyHead.append(historyTitle, historyClear);
  const historyList = document.createElement('div');
  historyList.className = 'faisal-calc-history-list';
  historyPane.append(historyHead, historyList);

  root.append(main, historyPane);
  win.content.append(root);

  function renderHistory() {
    historyList.replaceChildren();
    if (history.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'faisal-calc-history-empty';
      empty.textContent = t('calculator.historyEmpty');
      historyList.append(empty);
      return;
    }
    // Newest first.
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      const item = document.createElement('button');
      item.className = 'faisal-calc-history-item';
      const e = document.createElement('div');
      e.className = 'faisal-calc-history-expr';
      e.textContent = entry.expr;
      const r = document.createElement('div');
      r.className = 'faisal-calc-history-result';
      r.textContent = entry.result;
      item.append(e, r);
      item.addEventListener('click', () => {
        expr = entry.expr;
        render();
      });
      historyList.append(item);
    }
  }

  function errorMessage(err: unknown): string {
    if (err instanceof CalcError) {
      switch (err.code) {
        case 'div0': return t('calculator.errDiv0');
        case 'domain': return t('calculator.errDomain');
        case 'overflow': return t('calculator.errOverflow');
        default: return t('calculator.errSyntax');
      }
    }
    return t('calculator.errGeneric');
  }

  function render() {
    exprEl.textContent = expr;
    if (!expr) {
      resultEl.textContent = formatNumber(0, { arabicDigits });
      resultEl.classList.remove('is-error');
      return;
    }
    try {
      const value = calc(expr, angleMode);
      resultEl.textContent = formatNumber(value, { arabicDigits });
      resultEl.classList.remove('is-error');
    } catch {
      // Live preview: while the user is still typing, just show the last valid value blank.
      resultEl.textContent = '';
      resultEl.classList.remove('is-error');
    }
  }

  function commit() {
    if (!expr) return;
    try {
      const value = calc(expr, angleMode);
      const formatted = formatNumber(value, { arabicDigits });
      history.push({ expr, result: formatted });
      if (history.length > 50) history.shift();
      renderHistory();
      lastResult = value;
      resultEl.textContent = formatted;
      resultEl.classList.remove('is-error');
      exprEl.textContent = expr;
      expr = formatted.replace(/,/g, '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
    } catch (err) {
      resultEl.textContent = errorMessage(err);
      resultEl.classList.add('is-error');
    }
  }

  function clearAll() {
    expr = '';
    lastResult = null;
    render();
  }

  function backspace() {
    expr = expr.slice(0, -1);
    render();
  }

  function insert(s: string) {
    // Starting fresh after an error: clear the error display first.
    if (resultEl.classList.contains('is-error')) resultEl.classList.remove('is-error');
    expr += s;
    render();
  }

  function toggleSign() {
    if (!expr) return;
    if (expr.startsWith('-(') && expr.endsWith(')')) {
      expr = expr.slice(2, -1);
    } else {
      expr = `-(${expr})`;
    }
    render();
  }

  const BASIC_ROWS: KeyDef[][] = [
    [
      { label: 'C', action: 'clear', cls: 'is-op' },
      { label: '(', insert: '(' },
      { label: ')', insert: ')' },
      { label: '⌫', action: 'back', cls: 'is-op' },
    ],
    [
      { label: '7', insert: '7' }, { label: '8', insert: '8' }, { label: '9', insert: '9' },
      { label: '÷', insert: '÷', cls: 'is-op' },
    ],
    [
      { label: '4', insert: '4' }, { label: '5', insert: '5' }, { label: '6', insert: '6' },
      { label: '×', insert: '×', cls: 'is-op' },
    ],
    [
      { label: '1', insert: '1' }, { label: '2', insert: '2' }, { label: '3', insert: '3' },
      { label: '−', insert: '-', cls: 'is-op' },
    ],
    [
      { label: '±', action: 'sign' }, { label: '0', insert: '0' }, { label: '.', insert: '.' },
      { label: '+', insert: '+', cls: 'is-op' },
    ],
    [
      { label: '=', action: 'equals', cls: 'is-equals is-wide' },
      { label: '%', insert: '%', cls: 'is-op' },
    ],
  ];

  const ADVANCED_FN_KEYS: KeyDef[] = [
    { label: 'sin', insert: 'sin(' },
    { label: 'cos', insert: 'cos(' },
    { label: 'tan', insert: 'tan(' },
    { label: 'ln', insert: 'ln(' },
    { label: 'log', insert: 'log(' },
    { label: '√', insert: '√(' },
    { label: 'x²', insert: '²' },
    { label: 'xʸ', insert: '^' },
    { label: 'π', insert: 'π' },
    { label: 'e', insert: 'e' },
    { label: 'n!', insert: '!' },
  ];

  function keyButton(def: KeyDef): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'faisal-calc-key' + (def.cls ? ' ' + def.cls : '');
    b.textContent = def.label;
    b.type = 'button';
    b.addEventListener('click', () => {
      if (def.action === 'clear') clearAll();
      else if (def.action === 'back') backspace();
      else if (def.action === 'equals') commit();
      else if (def.action === 'sign') toggleSign();
      else if (def.insert !== undefined) insert(def.insert);
    });
    return b;
  }

  function renderPad() {
    pad.replaceChildren();
    for (const row of BASIC_ROWS) {
      const rowEl = document.createElement('div');
      rowEl.className = 'faisal-calc-row';
      for (const key of row) rowEl.append(keyButton(key));
      pad.append(rowEl);
    }
  }

  function renderFnRow() {
    fnRow.replaceChildren();
    for (const key of ADVANCED_FN_KEYS) {
      const b = document.createElement('button');
      b.className = 'faisal-calc-fnkey';
      b.type = 'button';
      b.textContent = key.label;
      b.addEventListener('click', () => insert(key.insert ?? ''));
      fnRow.append(b);
    }
  }

  function setMode(m: Mode) {
    mode = m;
    basicBtn.classList.toggle('is-active', m === 'basic');
    advBtn.classList.toggle('is-active', m === 'advanced');
    angleSeg.style.display = m === 'advanced' ? 'inline-flex' : 'none';
    fnRow.classList.toggle('is-visible', m === 'advanced');
  }

  function setAngleMode(a: AngleMode) {
    angleMode = a;
    degBtn.classList.toggle('is-active', a === 'deg');
    radBtn.classList.toggle('is-active', a === 'rad');
    render();
  }

  basicBtn.addEventListener('click', () => setMode('basic'));
  advBtn.addEventListener('click', () => setMode('advanced'));
  degBtn.addEventListener('click', () => setAngleMode('deg'));
  radBtn.addEventListener('click', () => setAngleMode('rad'));
  digitsToggle.addEventListener('click', () => {
    arabicDigits = !arabicDigits;
    digitsToggle.classList.toggle('is-active', arabicDigits);
    render();
  });
  historyClear.addEventListener('click', () => {
    history = [];
    renderHistory();
  });

  // ── keyboard ──
  root.tabIndex = 0;
  root.addEventListener('keydown', (e) => {
    const k = e.key;
    if (/^[0-9]$/.test(k)) { insert(k); e.preventDefault(); return; }
    if (k === '.') { insert('.'); e.preventDefault(); return; }
    if (k === '+' || k === '-' || k === '*' || k === '/' || k === '^' || k === '%' || k === '!' || k === '(' || k === ')') {
      insert(k === '*' ? '×' : k === '/' ? '÷' : k);
      e.preventDefault();
      return;
    }
    if (k === 'Enter' || k === '=') { commit(); e.preventDefault(); return; }
    if (k === 'Backspace') { backspace(); e.preventDefault(); return; }
    if (k === 'Escape') { clearAll(); e.preventDefault(); return; }
  });

  void lastResult;
  renderPad();
  renderFnRow();
  setMode('basic');
  setAngleMode('deg');
  renderHistory();
  render();
  root.focus();
}

const app: AppModule = {
  manifest: {
    id: 'org.faisal.Calculator',
    name: { ar: 'الآلة الحاسبة', en: 'Calculator' },
    description: { ar: 'آلة حاسبة أساسية ومتقدمة', en: 'Basic and advanced calculator' },
    icon: ICON_CALCULATOR,
    permissions: [],
    category: 'utilities',
    core: false,
  },
  launch,
};

export default app;
