import type Anthropic from '@anthropic-ai/sdk';
import type { AppContext, AppModule } from '../../kernel/types';
import { defineStrings, t } from '../../kernel/i18n';
import { renderIcon } from '../../shell/icon';
import { createClient, renderMarkdown, runTurn, type ChatMessage, type Source } from './chat';
import { ICON_CLAUDE } from './icon';
import './claude.css';

defineStrings('claude', {
  ar: {
    title: 'Claude',
    setupTitle: 'مرحباً بك في Claude',
    setupBody: 'Claude يتصل مباشرة بـ Anthropic API باستخدام مفتاحك الخاص، ويقدر يبحث في الإنترنت ويقرأ الروابط.',
    setupGet: 'احصل على مفتاح من',
    keyPlaceholder: 'sk-ant-…',
    save: 'حفظ والبدء',
    keyNote: 'يُحفظ المفتاح في هذا المتصفح فقط ولا يُرسل إلا إلى api.anthropic.com. الاستخدام يُحاسب على حسابك في Anthropic.',
    newChat: 'محادثة جديدة',
    removeKey: 'حذف المفتاح',
    placeholder: 'اكتب رسالتك… (Enter للإرسال، Shift+Enter لسطر جديد)',
    send: 'إرسال',
    stop: 'إيقاف',
    empty: 'اسألني أي شيء — أقدر أبحث في الإنترنت وأقرأ الروابط.',
    thinking: 'يفكر…',
    searching: 'يبحث في الويب: {q}',
    fetching: 'يقرأ الصفحة: {q}',
    sources: 'المصادر',
    refused: 'لم يتمكن Claude من الرد على هذا الطلب. جرّب صياغة مختلفة.',
    truncated: '(توقف الرد قبل اكتماله)',
    stopped: '(أوقفت الرد)',
    errAuth: 'المفتاح غير صحيح أو منتهي. احذفه وأدخل مفتاحاً جديداً.',
    errRate: 'تجاوزت حد الطلبات أو الرصيد. انتظر قليلاً أو راجع حسابك.',
    errNetwork: 'تعذّر الاتصال بـ Anthropic. تأكد من اتصالك بالإنترنت.',
    errGeneric: 'حدث خطأ: {msg}',
  },
  en: {
    title: 'Claude',
    setupTitle: 'Welcome to Claude',
    setupBody: 'Claude talks to the Anthropic API directly with your own key, and can search the web and read links.',
    setupGet: 'Get a key from',
    keyPlaceholder: 'sk-ant-…',
    save: 'Save and start',
    keyNote: 'The key is stored in this browser only and is sent only to api.anthropic.com. Usage is billed to your Anthropic account.',
    newChat: 'New chat',
    removeKey: 'Remove key',
    placeholder: 'Type a message… (Enter to send, Shift+Enter for a new line)',
    send: 'Send',
    stop: 'Stop',
    empty: 'Ask me anything — I can search the web and read links.',
    thinking: 'Thinking…',
    searching: 'Searching the web: {q}',
    fetching: 'Reading page: {q}',
    sources: 'Sources',
    refused: 'Claude could not respond to this request. Try rephrasing it.',
    truncated: '(The reply was cut off)',
    stopped: '(You stopped the reply)',
    errAuth: 'The key is invalid or expired. Remove it and enter a new one.',
    errRate: 'Rate or credit limit reached. Wait a moment or check your account.',
    errNetwork: 'Could not reach Anthropic. Check your internet connection.',
    errGeneric: 'Something went wrong: {msg}',
  },
});

const KEY_STORAGE = 'faisal.claude.apiKey';
const loadKey = () => { try { return localStorage.getItem(KEY_STORAGE) ?? ''; } catch { return ''; } };
const saveKey = (k: string) => { try { localStorage.setItem(KEY_STORAGE, k); } catch { /* private mode: key lives for this window only */ } };
const clearKey = () => { try { localStorage.removeItem(KEY_STORAGE); } catch { /* nothing stored */ } };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function launch(ctx: AppContext): void {
  const { window: win } = ctx;
  win.setTitle(t('claude.title'));
  const root = el('div', 'faisal-claude');
  win.content.append(root);

  let apiKey = loadKey();
  let client: Anthropic | null = null;
  let history: ChatMessage[] = [];
  let abort: AbortController | null = null;
  win.onClose(() => abort?.abort());

  const show = () => { root.replaceChildren(apiKey ? chatView() : setupView()); };

  function setupView(): HTMLElement {
    const box = el('div', 'faisal-claude-setup');
    const icon = el('div');
    icon.append(renderIcon(ICON_CLAUDE));
    icon.querySelector('svg')?.setAttribute('width', '56');
    const get = el('div', 'note');
    const link = el('a', undefined, 'console.anthropic.com');
    link.href = 'https://console.anthropic.com/settings/keys';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    get.append(`${t('claude.setupGet')} `, link);
    const input = el('input');
    input.type = 'password';
    input.placeholder = t('claude.keyPlaceholder');
    input.autocomplete = 'off';
    input.dir = 'ltr';
    const btn = el('button', 'primary', t('claude.save'));
    const submit = () => {
      const k = input.value.trim();
      if (!k) return;
      apiKey = k;
      client = null;
      saveKey(k);
      show();
    };
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    box.append(icon, el('h2', undefined, t('claude.setupTitle')), el('div', undefined, t('claude.setupBody')), get, input, btn,
      el('div', 'note', t('claude.keyNote')));
    queueMicrotask(() => input.focus());
    return box;
  }

  function chatView(): HTMLElement {
    const wrap = el('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;block-size:100%;min-block-size:0';

    const bar = el('div', 'faisal-claude-bar');
    const newBtn = el('button', undefined, t('claude.newChat'));
    const keyBtn = el('button', undefined, t('claude.removeKey'));
    bar.append(el('span', undefined, 'Claude Opus 5'), el('span', 'grow'), newBtn, keyBtn);

    const log = el('div', 'faisal-claude-log');
    const input = el('div', 'faisal-claude-input');
    const ta = el('textarea');
    ta.rows = 1;
    ta.dir = 'auto';
    ta.placeholder = t('claude.placeholder');
    const sendBtn = el('button', 'primary', t('claude.send'));
    input.append(ta, sendBtn);
    wrap.append(bar, log, input);

    const emptyState = () => {
      const e = el('div', 'faisal-claude-empty');
      e.append(renderIcon(ICON_CLAUDE), document.createTextNode(t('claude.empty')));
      log.replaceChildren(e);
    };
    if (history.length === 0) emptyState();
    else renderHistory();

    function renderHistory() {
      log.replaceChildren();
      for (const m of history) {
        if (m.role === 'user' && typeof m.content === 'string') addUser(m.content);
        else if (m.role === 'assistant' && Array.isArray(m.content)) {
          const text = m.content.map((b: Anthropic.Beta.BetaContentBlockParam) => (b.type === 'text' ? b.text : '')).join('');
          if (text) addAssistant().body.innerHTML = renderMarkdown(text);
        }
      }
    }

    function addUser(text: string) {
      log.querySelector('.faisal-claude-empty')?.remove();
      const m = el('div', 'faisal-claude-msg user', text);
      m.dir = 'auto';
      log.append(m);
    }
    function addAssistant() {
      const m = el('div', 'faisal-claude-msg assistant');
      m.dir = 'auto';
      const tools = el('div', 'faisal-claude-tools');
      const body = el('div');
      m.append(tools, body);
      log.append(m);
      return { m, tools, body };
    }
    const scroll = () => { log.scrollTop = log.scrollHeight; };

    const autosize = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`; };
    ta.addEventListener('input', autosize);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); }
    });
    sendBtn.addEventListener('click', () => { if (abort) abort.abort(); else void send(); });
    newBtn.addEventListener('click', () => { abort?.abort(); history = []; emptyState(); ta.focus(); });
    keyBtn.addEventListener('click', () => { abort?.abort(); clearKey(); apiKey = ''; client = null; history = []; show(); });

    async function send() {
      const text = ta.value.trim();
      if (!text || abort) return;
      ta.value = '';
      autosize();
      addUser(text);
      history.push({ role: 'user', content: text });
      const { m, tools, body } = addAssistant();
      body.append(el('span', 'faisal-claude-typing', t('claude.thinking')));
      scroll();

      abort = new AbortController();
      sendBtn.textContent = t('claude.stop');
      newBtn.disabled = true;
      let raw = '';
      let frame = 0;
      const paint = () => { frame = 0; body.innerHTML = renderMarkdown(raw); scroll(); };
      try {
        client ??= await createClient(apiKey);
        const res = await runTurn(client, history, {
          onText(d) { raw += d; if (!frame) frame = requestAnimationFrame(paint); },
          onTool(name, detail) {
            const line = el('div', 'faisal-claude-tool', t(name === 'web_search' ? 'claude.searching' : 'claude.fetching', { q: detail }));
            line.dir = 'auto';
            tools.append(line);
            scroll();
          },
        }, abort.signal);
        if (frame) cancelAnimationFrame(frame);
        if (res.refused) {
          m.classList.add('error');
          body.textContent = t('claude.refused');
        } else {
          paint();
          if (res.truncated) body.append(el('p', 'faisal-claude-typing', t('claude.truncated')));
          if (res.sources.length) body.append(sourcesEl(res.sources));
        }
      } catch (err) {
        if (frame) cancelAnimationFrame(frame);
        const aborted = abort?.signal.aborted;
        // Roll the unanswered user message back so the next turn starts clean.
        while (history.length && history[history.length - 1].role === 'user') history.pop();
        if (aborted) {
          if (raw) paint(); else body.replaceChildren();
          body.append(el('p', 'faisal-claude-typing', t('claude.stopped')));
        } else {
          m.classList.add('error');
          body.textContent = await errorText(err);
        }
      } finally {
        abort = null;
        sendBtn.textContent = t('claude.send');
        newBtn.disabled = false;
        scroll();
        ta.focus();
      }
    }

    queueMicrotask(() => ta.focus());
    return wrap;
  }

  show();
}

function sourcesEl(sources: Source[]): HTMLElement {
  const box = el('div', 'faisal-claude-sources');
  box.append(el('span', undefined, `${t('claude.sources')}:`));
  for (const s of sources.slice(0, 8)) {
    const a = el('a', undefined, s.title || new URL(s.url).hostname);
    a.href = s.url;
    a.title = s.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    box.append(a);
  }
  return box;
}

async function errorText(err: unknown): Promise<string> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return t('claude.errAuth');
  if (err instanceof Anthropic.RateLimitError) return t('claude.errRate');
  if (err instanceof Anthropic.APIConnectionError) return t('claude.errNetwork');
  const msg = err instanceof Error ? err.message : String(err);
  return t('claude.errGeneric', { msg });
}

const app: AppModule = {
  manifest: {
    id: 'org.faisal.Claude',
    name: { ar: 'Claude', en: 'Claude' },
    description: { ar: 'مساعد ذكي يبحث في الإنترنت ويقرأ الروابط', en: 'An AI assistant that can search the web and read links' },
    icon: ICON_CLAUDE,
    permissions: ['network'],
    singleInstance: true,
    category: 'utilities',
    core: false,
  },
  launch,
};

export default app;
