import { manifest } from './manifest';
import type Anthropic from '@anthropic-ai/sdk';
import type { AppContext, AppModule } from '../../kernel/types';
import { defineStrings, t } from '../../kernel/i18n';
import { renderIcon } from '../../shell/icon';
import { createClient, renderMarkdown, runTurn, type ChatMessage, type Source } from './chat';
import { GeminiError, runGeminiTurn, type GeminiContent } from './gemini';
import { ICON_CLAUDE } from './icon';
import './claude.css';

defineStrings('claude', {
  ar: {
    title: 'Faisal AI',
    setupTitle: 'مرحباً بك في Faisal AI',
    setupBody: 'اختر المزوّد وأدخل مفتاحك. Faisal AI يقدر يبحث في الإنترنت ويقرأ الروابط.',
    providerGemini: 'Gemini (مجاني)',
    providerClaude: 'Claude',
    setupGet: 'احصل على مفتاح من',
    keyPlaceholder: 'sk-ant-…',
    save: 'حفظ والبدء',
    keyNote: 'يُحفظ المفتاح في هذا المتصفح فقط ولا يُرسل إلا إلى api.anthropic.com. الاستخدام يُحاسب على حسابك في Anthropic.',
    keyNoteGemini: 'يُحفظ المفتاح في هذا المتصفح فقط ولا يُرسل إلا إلى Google. الاستخدام المجاني له حد يومي، وقد تستخدم Google المحادثات المجانية لتحسين خدماتها.',
    newChat: 'محادثة جديدة',
    removeKey: 'تغيير المزوّد / المفتاح',
    placeholder: 'اكتب رسالتك… (Enter للإرسال، Shift+Enter لسطر جديد)',
    send: 'إرسال',
    stop: 'إيقاف',
    empty: 'اسألني أي شيء — أقدر أبحث في الإنترنت وأقرأ الروابط.',
    thinking: 'يفكر…',
    searching: 'يبحث في الويب: {q}',
    fetching: 'يقرأ الصفحة: {q}',
    sources: 'المصادر',
    refused: 'لم يتمكن Faisal AI من الرد على هذا الطلب. جرّب صياغة مختلفة.',
    truncated: '(توقف الرد قبل اكتماله)',
    stopped: '(أوقفت الرد)',
    errAuth: 'المفتاح غير صحيح أو منتهي. احذفه وأدخل مفتاحاً جديداً.',
    errRate: 'تجاوزت حد الطلبات أو الرصيد. انتظر قليلاً أو راجع حسابك.',
    errNetwork: 'تعذّر الاتصال بـ Anthropic. تأكد من اتصالك بالإنترنت.',
    errGeneric: 'حدث خطأ: {msg}',
  },
  en: {
    title: 'Faisal AI',
    setupTitle: 'Welcome to Faisal AI',
    setupBody: 'Pick a provider and enter your key. Faisal AI can search the web and read links.',
    providerGemini: 'Gemini (free)',
    providerClaude: 'Claude',
    setupGet: 'Get a key from',
    keyPlaceholder: 'sk-ant-…',
    save: 'Save and start',
    keyNote: 'The key is stored in this browser only and is sent only to api.anthropic.com. Usage is billed to your Anthropic account.',
    keyNoteGemini: 'The key is stored in this browser only and is sent only to Google. The free tier has a daily limit, and Google may use free-tier chats to improve its products.',
    newChat: 'New chat',
    removeKey: 'Change provider / key',
    placeholder: 'Type a message… (Enter to send, Shift+Enter for a new line)',
    send: 'Send',
    stop: 'Stop',
    empty: 'Ask me anything — I can search the web and read links.',
    thinking: 'Thinking…',
    searching: 'Searching the web: {q}',
    fetching: 'Reading page: {q}',
    sources: 'Sources',
    refused: 'Faisal AI could not respond to this request. Try rephrasing it.',
    truncated: '(The reply was cut off)',
    stopped: '(You stopped the reply)',
    errAuth: 'The key is invalid or expired. Remove it and enter a new one.',
    errRate: 'Rate or credit limit reached. Wait a moment or check your account.',
    errNetwork: 'Could not reach Anthropic. Check your internet connection.',
    errGeneric: 'Something went wrong: {msg}',
  },
});

type Provider = 'gemini' | 'claude';
const PROVIDER_STORAGE = 'faisal.ai.provider';
const KEY_STORAGE: Record<Provider, string> = { claude: 'faisal.claude.apiKey', gemini: 'faisal.gemini.apiKey' };
const read = (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode: lives for this window only */ } };
const remove = (k: string) => { try { localStorage.removeItem(k); } catch { /* nothing stored */ } };
const loadProvider = (): Provider => {
  const p = read(PROVIDER_STORAGE);
  if (p === 'gemini' || p === 'claude') return p;
  return read(KEY_STORAGE.claude) ? 'claude' : 'gemini'; // keep earlier Claude users on Claude
};
const KEY_LINKS: Record<Provider, { href: string; label: string; placeholder: string }> = {
  gemini: { href: 'https://aistudio.google.com/apikey', label: 'aistudio.google.com', placeholder: 'Gemini API key' },
  claude: { href: 'https://console.anthropic.com/settings/keys', label: 'console.anthropic.com', placeholder: 'sk-ant-…' },
};

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

  let provider = loadProvider();
  let apiKey = read(KEY_STORAGE[provider]);
  let client: Anthropic | null = null;
  let history: ChatMessage[] = [];
  let gemHistory: GeminiContent[] = [];
  const resetChat = () => { history = []; gemHistory = []; };
  let abort: AbortController | null = null;
  win.onClose(() => abort?.abort());

  const show = () => { root.replaceChildren(apiKey ? chatView() : setupView()); };

  function setupView(): HTMLElement {
    const box = el('div', 'faisal-claude-setup');
    const icon = el('div');
    icon.append(renderIcon(ICON_CLAUDE));
    icon.querySelector('svg')?.setAttribute('width', '56');

    const picker = el('div', 'faisal-claude-picker');
    const get = el('div', 'note');
    const note = el('div', 'note');
    const input = el('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.dir = 'ltr';
    let choice: Provider = provider;
    const render = () => {
      for (const b of picker.children) b.classList.toggle('is-active', (b as HTMLElement).dataset.p === choice);
      const l = KEY_LINKS[choice];
      const link = el('a', undefined, l.label);
      link.href = l.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      get.replaceChildren(`${t('claude.setupGet')} `, link);
      input.placeholder = l.placeholder;
      input.value = read(KEY_STORAGE[choice]);
      note.textContent = t(choice === 'gemini' ? 'claude.keyNoteGemini' : 'claude.keyNote');
    };
    for (const p of ['gemini', 'claude'] as const) {
      const b = el('button', undefined, t(p === 'gemini' ? 'claude.providerGemini' : 'claude.providerClaude'));
      b.type = 'button';
      b.dataset.p = p;
      b.addEventListener('click', () => { choice = p; render(); input.focus(); });
      picker.append(b);
    }

    const btn = el('button', 'primary', t('claude.save'));
    const submit = () => {
      const k = input.value.trim();
      if (!k) return;
      if (choice !== provider) resetChat();
      provider = choice;
      apiKey = k;
      client = null;
      write(PROVIDER_STORAGE, provider);
      write(KEY_STORAGE[provider], k);
      show();
    };
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    box.append(icon, el('h2', undefined, t('claude.setupTitle')), el('div', undefined, t('claude.setupBody')), picker, get, input, btn, note);
    render();
    queueMicrotask(() => input.focus());
    return box;
  }

  function chatView(): HTMLElement {
    const wrap = el('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;block-size:100%;min-block-size:0';

    const bar = el('div', 'faisal-claude-bar');
    const newBtn = el('button', undefined, t('claude.newChat'));
    const keyBtn = el('button', undefined, t('claude.removeKey'));
    bar.append(el('span', undefined, provider === 'gemini' ? 'Faisal AI · Gemini' : 'Faisal AI · Claude Opus 5'), el('span', 'grow'), newBtn, keyBtn);

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
    if (history.length === 0 && gemHistory.length === 0) emptyState();
    else renderHistory();

    function renderHistory() {
      log.replaceChildren();
      if (provider === 'gemini') {
        for (const c of gemHistory) {
          const text = c.parts.map((p) => p.text).join('');
          if (c.role === 'user') addUser(text);
          else if (text) addAssistant().body.innerHTML = renderMarkdown(text);
        }
        return;
      }
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
    newBtn.addEventListener('click', () => { abort?.abort(); resetChat(); emptyState(); ta.focus(); });
    keyBtn.addEventListener('click', () => { abort?.abort(); remove(KEY_STORAGE[provider]); apiKey = ''; client = null; show(); });

    async function send() {
      const text = ta.value.trim();
      if (!text || abort) return;
      ta.value = '';
      autosize();
      addUser(text);
      if (provider === 'gemini') gemHistory.push({ role: 'user', parts: [{ text }] });
      else history.push({ role: 'user', content: text });
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
        const handlers = {
          onText(d: string) { raw += d; if (!frame) frame = requestAnimationFrame(paint); },
          onTool(name: 'web_search' | 'web_fetch', detail: string) {
            const line = el('div', 'faisal-claude-tool', t(name === 'web_search' ? 'claude.searching' : 'claude.fetching', { q: detail }));
            line.dir = 'auto';
            tools.append(line);
            scroll();
          },
        };
        let res;
        if (provider === 'gemini') res = await runGeminiTurn(apiKey, gemHistory, handlers, abort.signal);
        else {
          client ??= await createClient(apiKey);
          res = await runTurn(client, history, handlers, abort.signal);
        }
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
        while (gemHistory.length && gemHistory[gemHistory.length - 1].role === 'user') gemHistory.pop();
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
  if (err instanceof GeminiError) {
    if (err.status === 400 && /api key/i.test(err.message)) return t('claude.errAuth');
    if (err.status === 401 || err.status === 403) return t('claude.errAuth');
    if (err.status === 429) return t('claude.errRate');
    return t('claude.errGeneric', { msg: err.message });
  }
  if (err instanceof TypeError) return t('claude.errNetwork');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return t('claude.errAuth');
  if (err instanceof Anthropic.RateLimitError) return t('claude.errRate');
  if (err instanceof Anthropic.APIConnectionError) return t('claude.errNetwork');
  const msg = err instanceof Error ? err.message : String(err);
  return t('claude.errGeneric', { msg });
}

const app: AppModule = {
  manifest,
  launch,
};

export default app;
