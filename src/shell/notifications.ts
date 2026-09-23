import type { EventBus } from '../kernel/types';

const AUTO_DISMISS_MS = 5000;

export function mountNotifications(root: HTMLElement, bus: EventBus): void {
  const stack = document.createElement('div');
  stack.className = 'faisal-notif-stack';
  root.append(stack);

  bus.on('notify', ({ title, body }) => {
    const card = document.createElement('div');
    card.className = 'faisal-notif';
    card.setAttribute('role', 'status');

    const icon = document.createElement('div');
    icon.className = 'faisal-notif-icon';
    icon.textContent = (title[0] ?? '!').toUpperCase();

    const text = document.createElement('div');
    const titleEl = document.createElement('div');
    titleEl.className = 'faisal-notif-title';
    titleEl.textContent = title;
    text.append(titleEl);
    if (body) {
      const bodyEl = document.createElement('div');
      bodyEl.className = 'faisal-notif-body';
      bodyEl.textContent = body;
      text.append(bodyEl);
    }

    card.append(icon, text);
    stack.append(card);

    const remove = () => card.remove();
    const timer = window.setTimeout(remove, AUTO_DISMISS_MS);
    card.addEventListener('click', () => { window.clearTimeout(timer); remove(); });
  });
}
