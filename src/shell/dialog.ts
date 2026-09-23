/** Small in-shell modal dialog (never window.confirm/alert). Used by context-menu actions. */

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

    const finish = (value: boolean) => {
      overlay.remove();
      document.removeEventListener('keydown', onKeyDown);
      resolve(value);
    };

    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') finish(false);
    }

    cancelBtn.addEventListener('click', () => finish(false));
    okBtn.addEventListener('click', () => finish(true));
    overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) finish(false); });
    document.addEventListener('keydown', onKeyDown);

    queueMicrotask(() => okBtn.focus());
  });
}
