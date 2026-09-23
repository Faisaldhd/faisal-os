/** Small in-app modal dialogs (never window.confirm/prompt). */

export interface PromptOptions {
  title: string;
  message?: string;
  initialValue?: string;
  okLabel: string;
  cancelLabel: string;
  validate?: (value: string) => string | null; // returns error message or null
}

export interface ConfirmOptions {
  title: string;
  message: string;
  okLabel: string;
  cancelLabel: string;
  danger?: boolean;
}

function buildOverlay(container: HTMLElement): { overlay: HTMLElement; dialog: HTMLElement } {
  const overlay = document.createElement('div');
  overlay.className = 'faisal-files-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'faisal-files-dialog';
  overlay.appendChild(dialog);
  container.appendChild(overlay);
  return { overlay, dialog };
}

export function promptDialog(container: HTMLElement, opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const { overlay, dialog } = buildOverlay(container);

    const h3 = document.createElement('h3');
    h3.textContent = opts.title;
    dialog.appendChild(h3);

    if (opts.message) {
      const p = document.createElement('p');
      p.textContent = opts.message;
      dialog.appendChild(p);
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.dir = 'auto';
    input.value = opts.initialValue ?? '';
    dialog.appendChild(input);

    const err = document.createElement('div');
    err.className = 'faisal-files-dialog-error';
    dialog.appendChild(err);

    const actions = document.createElement('div');
    actions.className = 'faisal-files-dialog-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'faisal-files-btn';
    cancelBtn.textContent = opts.cancelLabel;
    const okBtn = document.createElement('button');
    okBtn.className = 'faisal-files-btn is-primary';
    okBtn.textContent = opts.okLabel;
    actions.append(cancelBtn, okBtn);
    dialog.appendChild(actions);

    const finish = (value: string | null) => { overlay.remove(); resolve(value); };

    const submit = () => {
      const v = input.value.trim();
      const problem = opts.validate ? opts.validate(v) : (v ? null : '');
      if (problem) { err.textContent = problem; return; }
      finish(v);
    };

    cancelBtn.addEventListener('click', () => finish(null));
    okBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') submit();
      else if (e.key === 'Escape') finish(null);
    });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(null); });

    queueMicrotask(() => { input.focus(); input.select(); });
  });
}

export function confirmDialog(container: HTMLElement, opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const { overlay, dialog } = buildOverlay(container);

    const h3 = document.createElement('h3');
    h3.textContent = opts.title;
    dialog.appendChild(h3);

    const p = document.createElement('p');
    p.textContent = opts.message;
    dialog.appendChild(p);

    const actions = document.createElement('div');
    actions.className = 'faisal-files-dialog-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'faisal-files-btn';
    cancelBtn.textContent = opts.cancelLabel;
    const okBtn = document.createElement('button');
    okBtn.className = opts.danger ? 'faisal-files-btn is-danger' : 'faisal-files-btn is-primary';
    okBtn.textContent = opts.okLabel;
    actions.append(cancelBtn, okBtn);
    dialog.appendChild(actions);

    const finish = (value: boolean) => { overlay.remove(); resolve(value); };
    cancelBtn.addEventListener('click', () => finish(false));
    okBtn.addEventListener('click', () => finish(true));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(false); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', esc); finish(false); }
    });

    queueMicrotask(() => okBtn.focus());
  });
}
