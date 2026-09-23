import { manifest } from './manifest';
import type { AppContext, AppModule } from '../../kernel/types';
import { defineStrings, t } from '../../kernel/i18n';
import { renderIcon } from '../../shell/icon';
import { renderMarkdown } from './markdown';
import { FALLBACK_MODELS, GroqError, listModels, runGroqTurn, type ChatTurn, type Source } from './groq';
import { ICON_AI } from './icon';
import './ai.css';

defineStrings('ai', {
  ar: {
    title: 'Faisal AI',
    setupTitle: 'مرحباً بك في Faisal AI',
    setupBody: 'Faisal AI يعمل عبر GroqCloud: سريع جداً ومجاني ضمن حدود يومية. أدخل مفتاحك للبدء.',
    setupGet: 'احصل على مفتاح مجاني من',
    keyPlaceholder: 'gsk_…',
    save: 'حفظ والبدء',
    checking: 'جارٍ التحقق من المفتاح…',
    keyNote: 'يُحفظ المفتاح في هذا المتصفح فقط ولا يُرسل إلا إلى api.groq.com.',
    model: 'النموذج',
    modelSearch: '{id} (يبحث في الويب)',
    newChat: 'محادثة جديدة',
    removeKey: 'تغيير المفتاح',
    placeholder: 'اكتب رسالتك… (Enter للإرسال، Shift+Enter لسطر جديد)',
    send: 'إرسال',
    stop: 'إيقاف',
    empty: 'اسألني أي شيء. مع نماذج Compound أقدر أبحث في الإنترنت وأقرأ الروابط.',
    thinking: 'يفكر…',
    searching: 'يبحث في الويب: {q}',
    fetching: 'يقرأ الصفحة: {q}',
    sources: 'المصادر',
    truncated: '(توقف الرد قبل اكتماله)',
    stopped: '(أوقفت الرد)',
    errAuth: 'المفتاح غير صحيح أو ملغى. غيّر المفتاح وأدخل مفتاحاً جديداً.',
    errRate: 'تجاوزت حد الاستخدام المجاني مؤقتاً. انتظر قليلاً ثم أعد المحاولة.',
    errNetwork: 'تعذّر الاتصال بـ GroqCloud. تأكد من اتصالك بالإنترنت.',
    errModel: 'هذا النموذج غير متاح الآن. اختر نموذجاً آخر من القائمة.',
    errGeneric: 'حدث خطأ: {msg}',
  },
  en: {
    title: 'Faisal AI',
    setupTitle: 'Welcome to Faisal AI',
    setupBody: 'Faisal AI runs on GroqCloud: very fast, and free within daily limits. Enter your key to start.',
    setupGet: 'Get a free key from',
    keyPlaceholder: 'gsk_…',
    save: 'Save and start',
    checking: 'Checking the key…',
    keyNote: 'The key is stored in this browser only and is sent only to api.groq.com.',
    model: 'Model',
    modelSearch: '{id} (searches the web)',
    newChat: 'New chat',
    removeKey: 'Change key',
    placeholder: 'Type a message… (Enter to send, Shift+Enter for a new line)',
    send: 'Send',
    stop: 'Stop',
    empty: 'Ask me anything. With the Compound models I can search the web and read links.',
    thinking: 'Thinking…',
    searching: 'Searching the web: {q}',
    fetching: 'Reading page: {q}',
    sources: 'Sources',
    truncated: '(The reply was cut off)',
    stopped: '(You stopped the reply)',
    errAuth: 'The key is invalid or revoked. Use "Change key" to enter a new one.',
    errRate: 'Free usage limit reached for now. Wait a moment and try again.',
    errNetwork: 'Could not reach GroqCloud. Check your internet connection.',
    errModel: 'This model is not available right now. Pick another one from the list.',
    errGeneric: 'Something went wrong: {msg}',
  },
});

const KEY_STORAGE = 'faisal.groq.apiKey';
const MODEL_STORAGE = 'faisal.groq.model';
/** Earlier versions of this app used Claude and Gemini; their saved keys are removed. */
const LEGACY_KEYS = ['faisal.claude.apiKey', 'faisal.gemini.apiKey', 'faisal.ai.provider'];

const read = (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode: lives for this window only */ } };
const remove = (k: string) => { try { localStorage.removeItem(k); } catch { /* nothing stored */ } };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

const searches = (model: string) => model.startsWith('groq/compound');

function launch(ctx: AppContext): void {
  const { window: win } = ctx;
  win.setTitle(t('ai.title'));
  const root = el('div', 'faisal-ai');
  win.content.append(root);
  LEGACY_KEYS.forEach(remove);

  let apiKey = read(KEY_STORAGE);
  let models: string[] = [];
  let model = read(MODEL_STORAGE) || FALLBACK_MODELS[0];
  let history: ChatTurn[] = [];
  let abort: AbortController | null = null;
  win.onClose(() => abort?.abort());

  const show = () => { root.replaceChildren(apiKey ? chatView() : setupView()); };

  function setupView(): HTMLElement {
    const box = el('div', 'faisal-ai-setup');
    const icon = el('div');
    icon.append(renderIcon(ICON_AI));
    icon.querySelector('svg')?.setAttribute('width', '56');
    const get = el('div', 'note');
    const link = el('a', undefined, 'console.groq.com');
    link.href = 'https://console.groq.com/keys';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    get.append(`${t('ai.setupGet')} `, link);
    const input = el('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.dir = 'ltr';
    input.placeholder = t('ai.keyPlaceholder');
    const status = el('div', 'note');
    status.setAttribute('role', 'status');
    const btn = el('button', 'primary', t('ai.save'));
    const submit = async () => {
      const k = input.value.trim();
      if (!k || btn.disabled) return;
      btn.disabled = true;
      status.classList.remove('is-error');
      status.textContent = t('ai.checking');
      try {
        models = await listModels(k); // proves the key works before saving it
        apiKey = k;
        write(KEY_STORAGE, k);
        show();
      } catch (err) {
        status.classList.add('is-error');
        status.textContent = errorText(err);
        btn.disabled = false;
      }
    };
    btn.addEventListener('click', () => void submit());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void submit(); });
    box.append(icon, el('h2', undefined, t('ai.setupTitle')), el('div', undefined, t('ai.setupBody')), get, input, btn, status,
      el('div', 'note', t('ai.keyNote')));
    queueMicrotask(() => input.focus());
    return box;
  }

  function chatView(): HTMLElement {
    const wrap = el('div', 'faisal-ai-chat');

    const bar = el('div', 'faisal-ai-bar');
    const picker = el('select', 'faisal-ai-model');
    picker.setAttribute('aria-label', t('ai.model'));
    picker.dir = 'ltr';
    const fillModels = (ids: string[]) => {
      if (!ids.includes(model)) model = ids[0] ?? model;
      picker.replaceChildren(...ids.map((id) => {
        const o = el('option', undefined, searches(id) ? t('ai.modelSearch', { id }) : id);
        o.value = id;
        o.selected = id === model;
        return o;
      }));
    };
    fillModels(models.length ? models : FALLBACK_MODELS);
    if (!models.length) {
      // Refresh the list from the account (it changes as Groq adds and retires models).
      listModels(apiKey).then((ids) => { if (ids.length) { models = ids; fillModels(ids); } }).catch(() => {});
    }
    picker.addEventListener('change', () => { model = picker.value; write(MODEL_STORAGE, model); });
    const newBtn = el('button', undefined, t('ai.newChat'));
    const keyBtn = el('button', undefined, t('ai.removeKey'));
    bar.append(picker, el('span', 'grow'), newBtn, keyBtn);

    const log = el('div', 'faisal-ai-log');
    log.setAttribute('aria-live', 'polite');
    const input = el('div', 'faisal-ai-input');
    const ta = el('textarea');
    ta.rows = 1;
    ta.dir = 'auto';
    ta.placeholder = t('ai.placeholder');
    ta.setAttribute('aria-label', t('ai.placeholder'));
    const sendBtn = el('button', 'primary', t('ai.send'));
    input.append(ta, sendBtn);
    wrap.append(bar, log, input);

    const emptyState = () => {
      const e = el('div', 'faisal-ai-empty');
      e.append(renderIcon(ICON_AI), document.createTextNode(t('ai.empty')));
      log.replaceChildren(e);
    };
    if (!history.length) emptyState();
    else for (const m of history) {
      if (m.role === 'user') addUser(m.content);
      else if (m.content) addAssistant().body.innerHTML = renderMarkdown(m.content);
    }

    function addUser(text: string) {
      log.querySelector('.faisal-ai-empty')?.remove();
      const m = el('div', 'faisal-ai-msg user', text);
      m.dir = 'auto';
      log.append(m);
    }
    function addAssistant() {
      const m = el('div', 'faisal-ai-msg assistant');
      m.dir = 'auto';
      const tools = el('div', 'faisal-ai-tools');
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
    keyBtn.addEventListener('click', () => { abort?.abort(); remove(KEY_STORAGE); apiKey = ''; models = []; show(); });

    async function send() {
      const text = ta.value.trim();
      if (!text || abort) return;
      ta.value = '';
      autosize();
      addUser(text);
      history.push({ role: 'user', content: text });
      const { m, tools, body } = addAssistant();
      body.append(el('span', 'faisal-ai-typing', t('ai.thinking')));
      scroll();

      abort = new AbortController();
      sendBtn.textContent = t('ai.stop');
      newBtn.disabled = true;
      picker.disabled = true;
      let raw = '';
      let frame = 0;
      const paint = () => { frame = 0; body.innerHTML = renderMarkdown(raw); scroll(); };
      try {
        const res = await runGroqTurn(apiKey, model, history, {
          onText(d) { raw += d; if (!frame) frame = requestAnimationFrame(paint); },
          onTool(name, detail) {
            const line = el('div', 'faisal-ai-tool', t(name === 'web_search' ? 'ai.searching' : 'ai.fetching', { q: detail }));
            line.dir = 'auto';
            tools.append(line);
            scroll();
          },
        }, abort.signal);
        if (frame) cancelAnimationFrame(frame);
        paint();
        if (res.truncated) body.append(el('p', 'faisal-ai-typing', t('ai.truncated')));
        if (res.sources.length) body.append(sourcesEl(res.sources));
      } catch (err) {
        if (frame) cancelAnimationFrame(frame);
        // Roll the unanswered message back so the next turn starts clean.
        if (history.at(-1)?.role === 'user') history.pop();
        if (abort?.signal.aborted) {
          if (raw) paint(); else body.replaceChildren();
          body.append(el('p', 'faisal-ai-typing', t('ai.stopped')));
        } else {
          m.classList.add('error');
          body.textContent = errorText(err);
        }
      } finally {
        abort = null;
        sendBtn.textContent = t('ai.send');
        newBtn.disabled = false;
        picker.disabled = false;
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
  const box = el('div', 'faisal-ai-sources');
  box.append(el('span', undefined, `${t('ai.sources')}:`));
  for (const s of sources.slice(0, 8)) {
    let label = s.title;
    try { label ||= new URL(s.url).hostname; } catch { label ||= s.url; }
    const a = el('a', undefined, label);
    a.href = s.url;
    a.title = s.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    box.append(a);
  }
  return box;
}

function errorText(err: unknown): string {
  if (err instanceof GroqError) {
    if (err.status === 401 || err.status === 403) return t('ai.errAuth');
    if (err.status === 429) return t('ai.errRate');
    if (err.status === 404 || /model/i.test(err.message) && err.status === 400) return t('ai.errModel');
    return t('ai.errGeneric', { msg: err.message });
  }
  if (err instanceof TypeError) return t('ai.errNetwork');
  return t('ai.errGeneric', { msg: err instanceof Error ? err.message : String(err) });
}

const app: AppModule = {
  manifest,
  launch,
};

export default app;
