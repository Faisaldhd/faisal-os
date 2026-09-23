/** Small in-app modal dialog for the editor (never window.confirm/prompt). */

export interface PromptOptions {
  title: string;
  message?: string;
  initialValue?: string;
  okLabel: string;
  cancelLabel: string;
  validate?: (value: string) => string | null;
}

export function promptDialog(container: HTMLElement, opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'faisal-editor-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'faisal-editor-dialog';
    overlay.appendChild(dialog);
    container.appendChild(overlay);

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
    err.className = 'faisal-editor-dialog-error';
    dialog.appendChild(err);

    const actions = document.createElement('div');
    actions.className = 'faisal-editor-dialog-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'faisal-editor-btn';
    cancelBtn.textContent = opts.cancelLabel;
    const okBtn = document.createElement('button');
    okBtn.className = 'faisal-editor-btn is-primary';
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
