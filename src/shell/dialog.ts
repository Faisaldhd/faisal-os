/** Small in-shell modal dialog (never window.confirm/alert). Used by context-menu actions. */

import { pushEscapeLayer } from './esc';

export interface ShellConfirmOptions {
  title: string;
  message: string;
  okLabel: string;
  cancelLabel: string;
  danger?: boolean;
}

export function shellConfirm(opts: ShellConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'faisal-shell-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'faisal-shell-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    overlay.append(dialog);

    const h3 = document.createElement('h3');
    h3.textContent = opts.title;
    const p = document.createElement('p');
    p.textContent = opts.message;
    dialog.append(h3, p);

    const actions = document.createElement('div');
    actions.className = 'faisal-shell-dialog-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'faisal-shell-dialog-btn';
    cancelBtn.textContent = opts.cancelLabel;
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'faisal-shell-dialog-btn' + (opts.danger ? ' is-danger' : ' is-primary');
    okBtn.textContent = opts.okLabel;
    actions.append(cancelBtn, okBtn);
    dialog.append(actions);

    document.body.append(overlay);

    let releaseEsc: (() => void) | null = null;
    const finish = (value: boolean) => {
      overlay.remove();
      releaseEsc?.();
      releaseEsc = null;
      resolve(value);
    };

    cancelBtn.addEventListener('click', () => finish(false));
    okBtn.addEventListener('click', () => finish(true));
    overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) finish(false); });
    // Escape is the shell's (esc.ts): this dialog closes first when it is on top.
    releaseEsc = pushEscapeLayer(() => finish(false));

    queueMicrotask(() => okBtn.focus());
  });
}

export interface ShellChoiceOption<T extends string> {
  value: T;
  label: string;
  /** Drawn as the primary action and focused when the dialog opens. */
  primary?: boolean;
}

export interface ShellChoiceOptions<T extends string> {
  title: string;
  message: string;
  options: ReadonlyArray<ShellChoiceOption<T>>;
  cancelLabel: string;
}

/**
 * A modal that offers any number of answers and resolves with the chosen value, or `null` when
 * the owner cancels (the cancel button, a click on the backdrop, or Escape). Used by the
 * file drag & drop question — copy or move — where a yes/no confirm is not enough.
 */
export function shellChoice<T extends string>(opts: ShellChoiceOptions<T>): Promise<T | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'faisal-shell-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'faisal-shell-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    overlay.append(dialog);

    const h3 = document.createElement('h3');
    h3.textContent = opts.title;
    const p = document.createElement('p');
    p.textContent = opts.message;
    dialog.append(h3, p);

    const actions = document.createElement('div');
    actions.className = 'faisal-shell-dialog-actions';

    let releaseEsc: (() => void) | null = null;
    const finish = (value: T | null) => {
      overlay.remove();
      releaseEsc?.();
      releaseEsc = null;
      resolve(value);
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'faisal-shell-dialog-btn';
    cancelBtn.textContent = opts.cancelLabel;
    cancelBtn.addEventListener('click', () => finish(null));
    actions.append(cancelBtn);

    const buttons = opts.options.map((option) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'faisal-shell-dialog-btn' + (option.primary ? ' is-primary' : '');
      btn.textContent = option.label;
      btn.addEventListener('click', () => finish(option.value));
      actions.append(btn);
      return btn;
    });

    dialog.append(actions);
    document.body.append(overlay);

    overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) finish(null); });
    // Escape is the shell's (esc.ts): this dialog closes first when it is on top.
    releaseEsc = pushEscapeLayer(() => finish(null));

    const first = opts.options.findIndex((o) => o.primary);
    queueMicrotask(() => (buttons[first] ?? buttons[0] ?? cancelBtn).focus());
  });
}
