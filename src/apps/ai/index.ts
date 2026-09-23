import { manifest } from './manifest';
import type { AppContext, AppModule } from '../../kernel/types';
import { defineStrings, getLocale, t } from '../../kernel/i18n';
import { renderIcon } from '../../shell/icon';
import { renderMarkdown } from './markdown';
import { ChatError, listModels, modelsOrFallback, runTurn, type ChatTurn, type Source } from './chat';
import {
  LEGACY_STORAGE_KEYS, PROVIDERS, PROVIDER_STORAGE, providerById, savedKey, savedModel, savedProvider,
  searchesWeb, supportsTools, type Provider,
} from './providers';
import { createToolBox } from './tools';
import type { ConfirmFn, ToolCall } from './agent';
import { ICON_AI } from './icon';
import './ai.css';

defineStrings('ai', {
  ar: {
    title: 'Faisal AI',
    setupTitle: 'مرحباً بك في Faisal AI',
    setupBody: 'Faisal AI يعمل عبر GroqCloud: سريع جداً ومجاني ضمن حدود يومية. أدخل مفتاحك للبدء.',
    setupBodyDeepseek: 'Faisal AI يعمل عبر DeepSeek: نماذج قوية، والاستخدام مدفوع حسب الاستهلاك. أدخل مفتاحك للبدء.',
    setupGet: 'احصل على مفتاح API من',
    provider: 'المزوّد',
    save: 'حفظ والبدء',
    checking: 'جارٍ التحقق من المفتاح…',
    keyNote: 'يُحفظ المفتاح في هذا المتصفح فقط ولا يُرسل إلا إلى {host}.',
    model: 'النموذج',
    modelSearch: '{id} (يبحث في الويب)',
    modelAgent: '{id} (وكيل)',
    allow: 'سماح',
    deny: 'رفض',
    allowed: 'تم السماح',
    denied: 'تم الرفض',
    agentHint: 'وضع الوكيل: أقدر أقرأ ملفاتك وأفتح التطبيقات، وأسألك قبل أي تغيير.',
    agentHintNoSearch: 'وضع الوكيل: أقدر أقرأ ملفاتك وأفتح التطبيقات، وأسألك قبل أي تغيير. هذا المزوّد لا يبحث في الويب، فلن أعرض مصادر.',
    searchHint: 'هذا النموذج يبحث في الويب لكنه لا يتحكم في النظام. اختر نموذجاً عليه (وكيل) لإدارة الملفات والتطبيقات.',
    newChat: 'محادثة جديدة',
    removeKey: 'تغيير المفتاح',
    placeholder: 'اكتب رسالتك… (Enter للإرسال، Shift+Enter لسطر جديد)',
    send: 'إرسال',
    stop: 'إيقاف',
    empty: 'اطلب مني أي شيء: أرتّب ملفاتك، أكتب ملفاً، أفتح تطبيقاً، أشغّل أمراً في الطرفية، أو أغيّر المظهر. أسألك قبل أي تغيير.',
    thinking: 'يفكر…',
    searching: 'يبحث في الويب: {q}',
    fetching: 'يقرأ الصفحة: {q}',
    sources: 'المصادر',
    truncated: '(توقف الرد قبل اكتماله)',
    stopped: '(أوقفت الرد)',
    errAuth: 'المفتاح غير صحيح أو ملغى. غيّر المفتاح وأدخل مفتاحاً جديداً.',
    errRate: 'تجاوزت حد الاستخدام المجاني مؤقتاً. انتظر قليلاً ثم أعد المحاولة.',
    errNetwork: 'تعذّر الاتصال بـ {provider}. تأكد من اتصالك بالإنترنت.',
    errModel: 'هذا النموذج غير متاح الآن. اختر نموذجاً آخر من القائمة.',
    errGeneric: 'حدث خطأ: {msg}',
  },
  en: {
    title: 'Faisal AI',
    setupTitle: 'Welcome to Faisal AI',
    setupBody: 'Faisal AI runs on GroqCloud: very fast, and free within daily limits. Enter your key to start.',
    setupBodyDeepseek: 'Faisal AI runs on DeepSeek: strong models, paid per use. Enter your key to start.',
    setupGet: 'Get an API key from',
    provider: 'Provider',
    save: 'Save and start',
    checking: 'Checking the key…',
    keyNote: 'The key is stored in this browser only and is sent only to {host}.',
    model: 'Model',
    modelSearch: '{id} (searches the web)',
    modelAgent: '{id} (agent)',
    allow: 'Allow',
    deny: 'Deny',
    allowed: 'Allowed',
    denied: 'Denied',
    agentHint: 'Agent mode: I can read your files and open apps, and I ask before changing anything.',
    agentHintNoSearch: 'Agent mode: I can read your files and open apps, and I ask before changing anything. This provider has no web search, so I will not show sources.',
    searchHint: 'This model searches the web but cannot control the system. Pick an (agent) model to manage files and apps.',
    newChat: 'New chat',
    removeKey: 'Change key',
    placeholder: 'Type a message… (Enter to send, Shift+Enter for a new line)',
    send: 'Send',
    stop: 'Stop',
    empty: 'Ask me for anything: tidy your files, write a file, open an app, run a terminal command, or change the look. I ask before changing anything.',
    thinking: 'Thinking…',
    searching: 'Searching the web: {q}',
    fetching: 'Reading page: {q}',
    sources: 'Sources',
    truncated: '(The reply was cut off)',
    stopped: '(You stopped the reply)',
    errAuth: 'The key is invalid or revoked. Use "Change key" to enter a new one.',
    errRate: 'Free usage limit reached for now. Wait a moment and try again.',
    errNetwork: 'Could not reach {provider}. Check your internet connection.',
    errModel: 'This model is not available right now. Pick another one from the list.',
    errGeneric: 'Something went wrong: {msg}',
  },
});

/** localStorage, or null when the browser blocks it (e.g. private mode). */
const store = (): Storage | null => { try { return localStorage; } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode: lives for this window only */ } };
const remove = (k: string) => { try { localStorage.removeItem(k); } catch { /* nothing stored */ } };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function launch(ctx: AppContext): void {
  const { window: win } = ctx;
  win.setTitle(t('ai.title'));
  const root = el('div', 'faisal-ai');
  win.content.append(root);
  LEGACY_STORAGE_KEYS.forEach(remove);

  // Each provider keeps its own key and model, so switching never loses the other's.
  let provider = savedProvider(store());
  let apiKey = savedKey(store(), provider);
  let model = savedModel(store(), provider);
  let models: string[] = [];
  const toolbox = createToolBox(ctx.sys);
  let history: ChatTurn[] = [];
  let abort: AbortController | null = null;
  win.onClose(() => abort?.abort());

  const show = () => { root.replaceChildren(apiKey ? chatView() : setupView()); };

  /** Switches provider: re-reads its own saved key and model, then re-renders. */
  const useProvider = (id: string) => {
    abort?.abort();
    provider = providerById(id);
    write(PROVIDER_STORAGE, provider.id);
    apiKey = savedKey(store(), provider);
    model = savedModel(store(), provider);
    models = [];
    show();
  };

  /** Keyboard-accessible provider picker; used on the key screen and in the chat bar. */
  function providerSelect(): HTMLSelectElement {
    const sel = el('select', 'faisal-ai-provider');
    sel.setAttribute('aria-label', t('ai.provider'));
    sel.dir = 'ltr';
    sel.replaceChildren(...PROVIDERS.map((p) => {
      const o = el('option', undefined, p.label[getLocale()]);
      o.value = p.id;
      o.selected = p.id === provider.id;
      return o;
    }));
    sel.addEventListener('change', () => useProvider(sel.value));
    return sel;
  }

  function setupView(): HTMLElement {
    const box = el('div', 'faisal-ai-setup');
    const icon = el('div');
    icon.append(renderIcon(ICON_AI));
    icon.querySelector('svg')?.setAttribute('width', '56');
    const field = el('label', 'faisal-ai-field');
    field.append(el('span', undefined, t('ai.provider')), providerSelect());
    const get = el('div', 'note');
    const link = el('a', undefined, provider.host);
    link.href = provider.keyUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    get.append(`${t('ai.setupGet')} `, link);
    const input = el('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.dir = 'ltr';
    input.placeholder = provider.keyPlaceholder;
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
        models = await listModels(provider, k); // proves the key works before saving it
        apiKey = k;
        write(provider.keyStorage, k);
        show();
      } catch (err) {
        status.classList.add('is-error');
        status.textContent = errorText(err, provider);
        btn.disabled = false;
      }
    };
    btn.addEventListener('click', () => void submit());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void submit(); });
    box.append(icon, el('h2', undefined, t('ai.setupTitle')), el('div', undefined, t(provider.setupBodyKey)), field, get,
      input, btn, status, el('div', 'note', t('ai.keyNote', { host: provider.host })));
    queueMicrotask(() => input.focus());
    return box;
  }

  function chatView(): HTMLElement {
    const wrap = el('div', 'faisal-ai-chat');

    const bar = el('div', 'faisal-ai-bar');
    const picker = el('select', 'faisal-ai-model');
    picker.setAttribute('aria-label', t('ai.model'));
    picker.dir = 'ltr';
    const hint = el('div', 'faisal-ai-hint');
    // Groq's compound models search the web server-side but reject custom tools; DeepSeek
    // takes custom tools but has no web search at all — the hint says whichever is true.
    const syncHint = () => {
      const key = !supportsTools(provider, model) ? 'ai.searchHint'
        : provider.serverSideSearch ? 'ai.agentHint' : 'ai.agentHintNoSearch';
      hint.textContent = t(key);
    };
    const fillModels = (ids: string[]) => {
      // No saved choice (or it was retired): start in agent mode.
      if (!ids.includes(model)) model = ids.find((id) => supportsTools(provider, id)) ?? ids[0] ?? model;
      syncHint();
      picker.replaceChildren(...ids.map((id) => {
        const o = el('option', undefined, searchesWeb(provider, id) ? t('ai.modelSearch', { id }) : supportsTools(provider, id) ? t('ai.modelAgent', { id }) : id);
        o.value = id;
        o.selected = id === model;
        return o;
      }));
    };
    fillModels(modelsOrFallback(provider, models));
    if (!models.length) {
      // Refresh the list from the account (it changes as the provider adds and retires models).
      listModels(provider, apiKey).then((ids) => { if (ids.length) { models = ids; fillModels(ids); } }).catch(() => {});
    }
    picker.addEventListener('change', () => { model = picker.value; write(provider.modelStorage, model); syncHint(); });
    const newBtn = el('button', undefined, t('ai.newChat'));
    const keyBtn = el('button', undefined, t('ai.removeKey'));
    bar.append(providerSelect(), picker, el('span', 'grow'), newBtn, keyBtn);

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
    wrap.append(bar, hint, log, input);

    const emptyState = () => {
      const e = el('div', 'faisal-ai-empty');
      e.append(renderIcon(ICON_AI), document.createTextNode(t('ai.empty')));
      log.replaceChildren(e);
    };
    if (!history.length) emptyState();
    else for (const m of history) {
      if (m.role === 'user') addUser(m.content);
      else if (m.role === 'assistant' && m.content) addAssistant().body.innerHTML = renderMarkdown(m.content);
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
    keyBtn.addEventListener('click', () => { abort?.abort(); remove(provider.keyStorage); apiKey = ''; models = []; show(); });

    async function send() {
      const text = ta.value.trim();
      if (!text || abort) return;
      ta.value = '';
      autosize();
      addUser(text);
      const turnStart = history.length;
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
      const steps = new Map<string, HTMLElement>();
      /** Inline card in the reply: the change, and Allow / Deny. */
      const confirm: ConfirmFn = (req) => new Promise((resolve) => {
        const card = el('div', 'faisal-ai-confirm' + (req.danger ? ' is-danger' : ''));
        card.setAttribute('role', 'group');
        card.setAttribute('aria-label', req.title);
        const detail = el('div', 'faisal-ai-confirm-detail', req.detail);
        detail.dir = 'auto';
        const actions = el('div', 'faisal-ai-confirm-actions');
        const yes = el('button', 'primary', t('ai.allow'));
        const no = el('button', undefined, t('ai.deny'));
        const decide = (ok: boolean) => {
          actions.replaceChildren(el('span', 'faisal-ai-typing', t(ok ? 'ai.allowed' : 'ai.denied')));
          card.classList.add(ok ? 'is-allowed' : 'is-denied');
          resolve(ok);
        };
        yes.addEventListener('click', () => decide(true));
        no.addEventListener('click', () => decide(false));
        // Stopping the reply also answers a pending question with "no".
        abort?.signal.addEventListener('abort', () => { if (!card.classList.contains('is-allowed')) decide(false); }, { once: true });
        actions.append(yes, no);
        card.append(el('div', 'faisal-ai-confirm-title', req.title), detail, actions);
        tools.append(card);
        scroll();
        yes.focus();
      });
      const onCall = (call: ToolCall, preview: { label: string }) => {
        const step = el('details', 'faisal-ai-step');
        const summary = el('summary', undefined, preview.label);
        summary.dir = 'auto';
        step.append(summary);
        tools.append(step);
        steps.set(call.id, step);
        scroll();
      };
      const onResult = (call: ToolCall, result: string) => {
        const step = steps.get(call.id);
        if (!step) return;
        const pre = el('pre', undefined, result.length > 4000 ? `${result.slice(0, 4000)}…` : result);
        pre.dir = 'ltr';
        step.append(pre);
        step.classList.add('is-done');
      };
      try {
        const res = await runTurn(provider, apiKey, model, history, {
          onText(d) { raw += d; if (!frame) frame = requestAnimationFrame(paint); },
          onTool(name, detail) {
            const line = el('div', 'faisal-ai-tool', t(name === 'web_search' ? 'ai.searching' : 'ai.fetching', { q: detail }));
            line.dir = 'auto';
            tools.append(line);
            scroll();
          },
        }, abort.signal, supportsTools(provider, model) ? { tools: toolbox, confirm, onCall, onResult } : undefined);
        if (frame) cancelAnimationFrame(frame);
        paint();
        if (res.truncated) body.append(el('p', 'faisal-ai-typing', t('ai.truncated')));
        if (res.sources.length) body.append(sourcesEl(res.sources));
      } catch (err) {
        if (frame) cancelAnimationFrame(frame);
        // Drop the whole unfinished turn (it may end mid tool call) so the next one starts clean.
        history.length = turnStart;
        if (abort?.signal.aborted) {
          if (raw) paint(); else body.replaceChildren();
          body.append(el('p', 'faisal-ai-typing', t('ai.stopped')));
        } else {
          m.classList.add('error');
          body.textContent = errorText(err, provider);
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

function errorText(err: unknown, provider: Provider): string {
  if (err instanceof ChatError) {
    if (err.status === 401 || err.status === 403) return t('ai.errAuth');
    if (err.status === 429) return t('ai.errRate');
    if (err.status === 404 || /model/i.test(err.message) && err.status === 400) return t('ai.errModel');
    return t('ai.errGeneric', { msg: err.message });
  }
  if (err instanceof TypeError) return t('ai.errNetwork', { provider: provider.label[getLocale()] });
  return t('ai.errGeneric', { msg: err instanceof Error ? err.message : String(err) });
}

const app: AppModule = {
  manifest,
  launch,
};

export default app;
