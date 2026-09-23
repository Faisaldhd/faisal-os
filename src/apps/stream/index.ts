/**
 * Fai$al OS — Streamed browser window (نافذة المتصفح المُبثّ).
 *
 * WHAT THIS IS: one more app whose window content is an <iframe> pointing at a
 * streaming client the owner runs themselves (neko over WebRTC, or a
 * WebSocket/Selkies client). The window manager and the kernel know nothing
 * about it: this file only decides which URL the frame gets and what the user
 * sees around it.
 *
 * WHAT THIS IS NOT:
 *  • Not a proxy, and not a bypass of anyone's framing policy. Google and
 *    YouTube work here because the *container's* browser loads them as
 *    top-level pages — this page never frames them.
 *  • Not a place where OS data travels. Nothing from the VFS, the settings,
 *    the kernel, or any key is ever sent to the frame: no postMessage in
 *    either direction, no contentWindow access, no reading its DOM. The only
 *    thing that crosses is the URL the owner typed.
 *  • Not a claim of connectivity. A probe result is a probe result; the badge
 *    always says what the app is, never "connected" (see the notice bar for
 *    the case where the frame was opened without a successful probe).
 *
 * Honest failure policy: if the endpoint does not answer, or if it is a remote
 * endpoint that this system's own CSP will refuse (remote origins must be
 * https — see streamEndpointPolicy), the window shows a setup screen that says
 * exactly that. Never a blank frame, never an invented success state.
 */
import { manifest } from './manifest';
import type { AppContext, AppModule } from '../../kernel/types';
import { defineStrings, t } from '../../kernel/i18n';
import { renderIcon } from '../../shell/icon';
import {
  DOCKER_NEKO_COMMAND,
  DOCKER_NEKO_COMMAND_WINDOWS,
  DOCKER_SELKIES_COMMAND,
  DOCKER_SELKIES_COMMAND_WINDOWS,
  IFRAME_ALLOW,
  IFRAME_SANDBOX,
  NO_STORAGE,
  PROBE_TIMEOUT_MS,
  STREAM_DOC_PATH,
  STREAM_DOC_URL,
  localStorageOrNull,
  normalizeStreamUrl,
  probeStream,
  saveStreamUrl,
  savedStreamUrl,
  streamEndpointPolicy,
  type StreamEndpointPolicy,
  type StreamStorage,
} from './config';
import './stream.css';

/** Every user-visible string of this window, in both languages. */
defineStrings('stream', {
  ar: {
    title: 'المتصفح المُبثّ',
    badge: 'متصفح مُبثّ',
    frameTitle: 'شاشة المتصفح داخل الحاوية',
    endpointLabel: 'عنوان خدمة البث',
    endpointPlaceholder: 'http://127.0.0.1:8080',
    check: 'تحقّق',
    checking: 'جارٍ فحص العنوان…',
    changeUrl: 'تغيير العنوان',
    backToStream: 'رجوع إلى البث',
    fullscreen: 'ملء الشاشة',
    fullscreenExit: 'الخروج من ملء الشاشة',
    fullscreenFailed: 'رفض المتصفح تكبير الإطار. جرّب زر ملء الشاشة في شريط النافذة.',
    fullscreenUnsupported: 'هذا المتصفح لا يدعم ملء الشاشة.',

    setupTitle: 'تشغيل المتصفح المُبثّ',
    setupLead:
      'المتصفح المُبثّ يشغّل Chromium حقيقياً داخل حاوية Docker تملكها أنت، ويعرض Fai$al OS شاشته داخل نافذة عادية. المواقع التي ترفض العرض داخل إطار — مثل جوجل ويوتيوب — تعمل هنا بالكامل، لأن الحاوية هي التي تفتحها، لا هذه الصفحة.',
    isolationNote:
      'الحاوية معزولة: متصفحك الحقيقي وملفاتك وكلمات مرورك لا تُرى من داخلها، ولا يُرسل إليها أي شيء من Fai$al OS — لا ملفات ولا أسرار ولا صلاحيات ولا مفاتيح. تبقى المواقع داخل الحاوية تتصفّح الويب مباشرة، تماماً كما تفعل في أي متصفح آخر.',
    notReachableTitle: 'لم يستجب هذا العنوان',
    notReachableBody:
      'الفحص أرسل طلباً واحداً إلى العنوان ولم يصله جواب. تحقّق أن Docker يعمل وأن الحاوية شغّالة، وأن المنفذ مكتوب كما هو في أمر التشغيل، ثم اضغط «تحقّق» مرة أخرى.',
    probeNote:
      'الفحص لا يثبت أن الصورة ستصل، ولا يفهم محتوى الرد: أي جواب — حتى صفحة فارغة — يُعدّ «استجاب». وإن ظهرت هذه الرسالة والحاوية تعمل فعلاً، فغالباً العنوان مختلف (منفذ آخر؟) أو أن جهازك يحجب 127.0.0.1 على هذا المنفذ.',
    openAnyway: 'افتح الإطار على أي حال',
    openAnywayNote: 'زر «افتح الإطار على أي حال» يعرض الإطار دون تأكيد الاتصال، وقد تبقى المساحة فارغة.',
    unconfirmedNotice:
      'لم يتأكّد الاتصال: فُتح الإطار بناءً على طلبك والفحص لم ينجح. إن بقيت المساحة فارغة، فالحاوية لا تعمل أو أن العنوان غير صحيح.',

    badUrl: 'هذا ليس عنواناً صالحاً. المسموح http:// أو https:// فقط — لا javascript: ولا data: ولا file:.',
    insecureRemoteTitle: 'عنوان بعيد بلا تشفير',
    insecureRemoteBody:
      'العناوين البعيدة يجب أن تبدأ بـ https://. يسمح هذا النظام بـ http:// للعناوين المحلية فقط (127.0.0.1 أو localhost)، لذلك سيرفض المتصفح عرض هذا الإطار. استخدم https:// (وكيل عكسي بشهادة موثوقة أمام الحاوية) ثم أعد المحاولة. التفاصيل في التوثيق.',

    dockerTitle: 'أمر التشغيل (Docker)',
    dockerNekoLabel: 'نيكو: WebRTC — الكروم الرسمي الحالي',
    dockerLiteLabel: 'بديل أخف للأجهزة الضعيفة: WebSocket',
    dockerWindowsTitle: 'ويندوز / PowerShell — سطر واحد',
    dockerWindowsNote:
      'علامة \\ في نهاية السطر أعلاه خاصة بـbash ولا تعمل في PowerShell: لصق الأمر متعدد الأسطر هناك ينفّذ السطر الأول ثم يفشل في الباقي. الأمران التاليان سطر واحد لكلٍّ منهما، وانسخهما كما هما (استبدل <password> بكلمة مرور تختارها، بالإنجليزية لا بالعربية).',
    dockerNekoWindowsLabel: 'نيكو (PowerShell، سطر واحد)',
    dockerLiteWindowsLabel: 'البديل الأخف (PowerShell، سطر واحد)',
    dockerNote:
      'لا يوجد Docker على هذا الجهاز؟ الأمران أدناه يُشغَّلان على الجهاز أو الخادم الذي ستحتضن الحاوية فيه، لا داخل النظام.',
    passwordNote:
      'استبدل <password> و<adminpassword> (و<user>) بكلمات مرور من اختيارك — لا تترك قيمة افتراضية، ولا تُشغّل الحاوية بلا كلمة مرور.',
    copy: 'نسخ',
    copied: 'تم النسخ إلى الحافظة.',
    copyFailed: 'تعذّر النسخ تلقائياً — حُدّد النص، انسخه بلوحة المفاتيح.',
    saveFailed: 'تعذّر حفظ العنوان في هذا المتصفح (الوضع الخاص؟) — سيُستخدم لهذه الجلسة فقط.',

    limitsTitle: 'حدود صريحة',
    limitDocker: 'يحتاج Docker يعمل على جهاز أو خادم تملكه؛ لا يعمل على GitHub Pages وحده.',
    limitResources: 'يستهلك نحو معالج واحد (CPU) و١–٢ جيجابايت من الذاكرة أثناء التشغيل.',
    limitLatency: 'زمن الاستجابة أعلى من متصفح محلي: كل صورة تسافر من الحاوية إلى نافذتك.',
    limitFocus: 'لوحة المفاتيح لا تصل إلى المتصفح المُبثّ حتى تنقر داخل النافذة مرة واحدة.',
    limitVideo: 'فيديو 4K والألعاب لن تكون سلسة: الترميز يجري على معالج الحاوية.',

    docTitle: 'التوثيق الكامل',
    docLink: 'دليل المتصفح المُبثّ في المستودع',
    docNote: 'الرابط يفتح الملف في المستودع على GitHub، لأن ملفات docs غير منشورة في نسخة الويب. والمسار داخل الشجرة هو: ' + STREAM_DOC_PATH + '.',
  },
  en: {
    title: 'Streamed Browser',
    badge: 'Streamed browser',
    frameTitle: 'The container browser’s screen',
    endpointLabel: 'Stream endpoint',
    endpointPlaceholder: 'http://127.0.0.1:8080',
    check: 'Check',
    checking: 'Checking the endpoint…',
    changeUrl: 'Change address',
    backToStream: 'Back to the stream',
    fullscreen: 'Fullscreen',
    fullscreenExit: 'Leave fullscreen',
    fullscreenFailed: 'The browser refused to make the frame fullscreen. Try the window’s own fullscreen button.',
    fullscreenUnsupported: 'This browser has no fullscreen support.',

    setupTitle: 'Run the streamed browser',
    setupLead:
      'The streamed browser runs a real Chromium inside a Docker container you own, and Fai$al OS shows its screen inside an ordinary window. Sites that refuse to be framed — Google and YouTube — work fully here, because the container’s browser opens them, not this page.',
    isolationNote:
      'The container is isolated: your real browser, your files and your passwords cannot be seen from inside it, and nothing from Fai$al OS is ever sent to it — no files, no secrets, no capabilities, no keys. The sites inside the container still browse the web directly, exactly as they would in any other browser.',
    notReachableTitle: 'This endpoint did not answer',
    notReachableBody:
      'The probe sent one request to the address and nothing answered. Check that Docker is running, that the container is up, and that the port is exactly the one in the run command, then press “Check” again.',
    probeNote:
      'The probe proves nothing about the picture, and it never reads the reply: any answer — even an empty page — counts as “answered”. If this message appears while the container is definitely running, the address is probably not the one it listens on (a different port?), or this machine blocks 127.0.0.1 on that port.',
    openAnyway: 'Open the frame anyway',
    openAnywayNote: '“Open the frame anyway” shows the frame without a confirmed connection, and the area may stay blank.',
    unconfirmedNotice:
      'The connection is not confirmed: the frame was opened at your request and the probe did not succeed. If the area stays blank, the container is not running or the address is wrong.',

    badUrl: 'That is not a usable address. Only http:// or https:// — never javascript:, data: or file:.',
    insecureRemoteTitle: 'A remote address without encryption',
    insecureRemoteBody:
      'Remote endpoints must start with https://. This system allows http:// for loopback addresses only (127.0.0.1 or localhost), so the browser will refuse to show this frame. Use https:// (a reverse proxy with a trusted certificate in front of the container) and try again. Details are in the documentation.',

    dockerTitle: 'Run it (Docker)',
    dockerNekoLabel: 'neko: WebRTC — the current official Chromium image',
    dockerLiteLabel: 'Lighter option for weak machines: WebSocket',
    dockerWindowsTitle: 'Windows / PowerShell — one line each',
    dockerWindowsNote:
      'The trailing \\ in the commands above is bash syntax and does NOT work in PowerShell: pasting the block there runs the first line and then fails on every remaining line. The two commands below are one line each; copy them as they are and replace <password> with a password you choose (ASCII, not Arabic).',
    dockerNekoWindowsLabel: 'neko (PowerShell, one line)',
    dockerLiteWindowsLabel: 'The lighter option (PowerShell, one line)',
    dockerNote:
      'No Docker on this machine? Both commands below run on the machine or server that hosts the container, not inside this system.',
    passwordNote:
      'Replace <password> and <adminpassword> (and <user>) with passwords you choose — never leave a default, and never run the container without a password.',
    copy: 'Copy',
    copied: 'Copied to the clipboard.',
    copyFailed: 'Could not copy automatically — the text is selected; copy it from the keyboard.',
    saveFailed: 'This browser refused to save the address (private mode?) — it is used for this session only.',

    limitsTitle: 'Honest limits',
    limitDocker: 'Needs Docker running on a machine or server you own; it cannot work on GitHub Pages alone.',
    limitResources: 'Uses roughly one CPU core and 1–2 GB of RAM while it runs.',
    limitLatency: 'Higher latency than a local browser: every frame travels from the container to your window.',
    limitFocus: 'The keyboard does not reach the streamed browser until you click once inside the window.',
    limitVideo: '4K video and games will not be smooth: encoding happens on the container’s CPU.',

    docTitle: 'Full documentation',
    docLink: 'The streamed-browser guide in the repository',
    docNote: 'The link opens the file in the repository on GitHub, because `docs` files are not published in the web build. Its path inside the tree is: ' + STREAM_DOC_PATH + '.',
  },
});

/* ────────────────────────────── small helpers ────────────────────────────── */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function button(label: string, cls: string): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  return b;
}

function iconButton(svg: string, label: string, extraClass?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'faisal-stream-btn' + (extraClass ? ` ${extraClass}` : '');
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(renderIcon(svg));
  return b;
}

const ICON_FULLSCREEN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
  '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_FULLSCREEN_EXIT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
  '<path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* ─────────────────────────────── the window ─────────────────────────────── */

type View = 'checking' | 'ready' | 'setup';
type SetupReason = 'unreachable' | 'change' | 'insecure-remote';

function launch(ctx: AppContext): void {
  const { window: win } = ctx;
  // localStorage, never sys.settings: this app has no `settings` permission and
  // must not ask for one just to remember its own endpoint.
  const storage: StreamStorage = localStorageOrNull() ?? NO_STORAGE;

  win.setTitle(t('stream.title'));
  win.content.textContent = '';

  const root = el('div', 'faisal-stream');
  const bar = el('div', 'faisal-stream-bar');
  // The badge is permanent: it stays in the toolbar in every view, whether or
  // not the endpoint answered, and it names the feature — not a connection.
  const badge = el('span', 'faisal-stream-badge', t('stream.badge'));
  const endpointEl = el('span', 'faisal-stream-endpoint');
  endpointEl.dir = 'ltr';
  const status = el('span', 'faisal-stream-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const spacer = el('span', 'faisal-stream-spacer');
  const fullscreenBtn = iconButton(ICON_FULLSCREEN, t('stream.fullscreen'));
  const changeBtn = button(t('stream.changeUrl'), 'faisal-stream-action');
  const backBtn = button(t('stream.backToStream'), 'faisal-stream-action');
  bar.append(badge, endpointEl, status, spacer, fullscreenBtn, changeBtn, backBtn);

  const body = el('div', 'faisal-stream-body');
  // The frame lives in its own stage, which is only *hidden* by the setup view.
  // A live WebRTC session therefore survives "Change address" and "Back to the
  // stream" instead of being torn down and reconnected.
  const stage = el('div', 'faisal-stream-stage');
  const noticeHost = el('div', 'faisal-stream-notices');
  const frameHost = el('div', 'faisal-stream-framehost');
  stage.append(noticeHost, frameHost);
  stage.hidden = true;
  const panelHost = el('div', 'faisal-stream-panelhost');
  body.append(stage, panelHost);
  root.append(bar, body);
  win.content.append(root);

  let endpoint = savedStreamUrl(storage);
  /** `null` until a probe has finished; `false` also covers "never answered". */
  let reachable: boolean | null = null;
  let view: View = 'checking';
  let frame: HTMLIFrameElement | null = null;
  let frameUrl: string | null = null;
  /** Bumped on every probe so a late answer can never overwrite a newer view. */
  let seq = 0;
  let statusTimer: ReturnType<typeof setTimeout> | null = null;

  endpointEl.textContent = endpoint;
  endpointEl.title = endpoint;

  const policy = (): StreamEndpointPolicy | null => streamEndpointPolicy(endpoint);

  function setStatus(text: string): void {
    status.textContent = text;
    if (statusTimer !== null) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { status.textContent = ''; statusTimer = null; }, 8000);
  }

  /** Shows/hides the toolbar buttons that only make sense in one view. */
  function syncBar(): void {
    const hasFrame = frame !== null;
    fullscreenBtn.hidden = view !== 'ready';
    changeBtn.hidden = view !== 'ready';
    backBtn.hidden = view !== 'setup' || !hasFrame;
    endpointEl.textContent = endpoint;
    endpointEl.title = endpoint;
  }

  /* ── the framed client ── */
  function showFrame(confirmed: boolean): void {
    view = 'ready';
    if (!frame || frameUrl !== endpoint) {
      frameHost.textContent = '';
      frame = createFrame(endpoint);
      frameUrl = endpoint;
      frameHost.append(frame);
    }
    noticeHost.textContent = '';
    if (!confirmed) noticeHost.append(noticeBar(t('stream.unconfirmedNotice')));
    stage.hidden = false;
    panelHost.textContent = '';
    syncBar();
  }

  function createFrame(url: string): HTMLIFrameElement {
    const f = document.createElement('iframe');
    f.className = 'faisal-stream-frame';
    // Every restriction is set before `src`, so the frame never loads for even
    // one tick without them:
    //  • the least sandbox a cross-origin client needs (see config.ts),
    //  • no clipboard permission in this version,
    //  • no referrer is ever sent to the container.
    f.setAttribute('sandbox', IFRAME_SANDBOX);
    f.setAttribute('allow', IFRAME_ALLOW);
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.setAttribute('title', t('stream.frameTitle'));
    f.loading = 'eager';
    f.src = url;
    return f;
  }

  function noticeBar(text: string): HTMLElement {
    return el('div', 'faisal-stream-notice', text);
  }

  function showChecking(): void {
    view = 'checking';
    stage.hidden = true;
    const card = el('div', 'faisal-stream-card');
    const spinner = el('div', 'faisal-stream-progress');
    const ring = el('span', 'faisal-stream-spinner');
    const label = el('span', undefined, t('stream.checking'));
    spinner.append(ring, label);
    const where = el('div', 'faisal-stream-url', endpoint);
    where.dir = 'ltr';
    card.append(spinner, where);
    panelHost.replaceChildren(card);
    syncBar();
  }

  /* ── the setup screen: the honest path when there is no stream ── */
  function showSetup(reason: SetupReason): void {
    view = 'setup';
    stage.hidden = true;
    panelHost.replaceChildren(buildSetup(reason));
    syncBar();
  }

  function buildSetup(reason: SetupReason): HTMLElement {
    const card = el('div', 'faisal-stream-card is-setup');
    card.append(el('h2', 'faisal-stream-h2', t('stream.setupTitle')));
    card.append(el('p', 'faisal-stream-p', t('stream.setupLead')));
    card.append(el('p', 'faisal-stream-p is-muted', t('stream.isolationNote')));

    if (reason === 'insecure-remote') {
      const warn = el('div', 'faisal-stream-block is-warning');
      warn.append(el('div', 'faisal-stream-blocktitle', t('stream.insecureRemoteTitle')));
      warn.append(el('p', 'faisal-stream-p', t('stream.insecureRemoteBody')));
      card.append(warn);
    }
    if (reason === 'unreachable') {
      const block = el('div', 'faisal-stream-block');
      block.append(el('div', 'faisal-stream-blocktitle', t('stream.notReachableTitle')));
      block.append(el('p', 'faisal-stream-p', t('stream.notReachableBody')));
      block.append(el('p', 'faisal-stream-p is-muted', t('stream.probeNote')));
      const actions = el('div', 'faisal-stream-actions');
      // An explicit, labelled override — never a silent "pretend it worked".
      const anyway = button(t('stream.openAnyway'), 'faisal-stream-action is-primary');
      anyway.addEventListener('click', () => showFrame(false));
      actions.append(anyway);
      block.append(actions, el('p', 'faisal-stream-p is-muted', t('stream.openAnywayNote')));
      card.append(block);
    }

    card.append(buildEndpointForm());
    card.append(buildCommands());
    card.append(buildLimits());
    card.append(buildDocs());
    return card;
  }

  function buildEndpointForm(): HTMLElement {
    const wrap = el('div', 'faisal-stream-block');
    const form = el('form', 'faisal-stream-form');
    const label = el('label', 'faisal-stream-label', t('stream.endpointLabel'));
    const field = el('input', 'faisal-stream-input');
    field.type = 'text';
    field.dir = 'ltr';
    field.autocomplete = 'off';
    field.spellcheck = false;
    field.value = endpoint;
    field.placeholder = t('stream.endpointPlaceholder');
    const id = 'faisal-stream-endpoint-field';
    field.id = id;
    label.htmlFor = id;
    const submit = el('button', 'faisal-stream-action is-primary', t('stream.check'));
    submit.type = 'submit';
    const error = el('p', 'faisal-stream-p is-error');
    form.append(label, field, submit);
    // Without this, arrow keys/backspace in the field reach the shell and move
    // window focus instead of editing the address.
    field.addEventListener('keydown', (ev) => ev.stopPropagation());
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      error.textContent = '';
      const next = normalizeStreamUrl(field.value);
      if (!next) {
        // Nothing invalid is ever stored, framed or probed.
        error.textContent = t('stream.badUrl');
        return;
      }
      const saved = saveStreamUrl(next, storage);
      if (!saved) setStatus(t('stream.saveFailed'));
      void check(next);
    });
    wrap.append(form, error);
    return wrap;
  }

  function buildCommands(): HTMLElement {
    const wrap = el('div', 'faisal-stream-block');
    wrap.append(el('div', 'faisal-stream-blocktitle', t('stream.dockerTitle')));
    wrap.append(el('p', 'faisal-stream-p is-muted', t('stream.dockerNote')));
    wrap.append(commandBlock(t('stream.dockerNekoLabel'), DOCKER_NEKO_COMMAND));
    wrap.append(commandBlock(t('stream.dockerLiteLabel'), DOCKER_SELKIES_COMMAND));
    wrap.append(el('p', 'faisal-stream-p is-muted', t('stream.passwordNote')));
    // Windows last: a bash line continuation is not a PowerShell line
    // continuation, and pasting the block above into PowerShell fails on every
    // line after the first ("-p is not recognized").
    wrap.append(el('div', 'faisal-stream-blocktitle', t('stream.dockerWindowsTitle')));
    wrap.append(el('p', 'faisal-stream-p is-muted', t('stream.dockerWindowsNote')));
    wrap.append(commandBlock(t('stream.dockerNekoWindowsLabel'), DOCKER_NEKO_COMMAND_WINDOWS));
    wrap.append(commandBlock(t('stream.dockerLiteWindowsLabel'), DOCKER_SELKIES_COMMAND_WINDOWS));
    return wrap;
  }

  /** One copy-ready command: literal text in a <pre>, never HTML. */
  function commandBlock(label: string, command: string): HTMLElement {
    const block = el('div', 'faisal-stream-command');
    const head = el('div', 'faisal-stream-commandhead');
    const copy = button(t('stream.copy'), 'faisal-stream-copy');
    const pre = el('pre', 'faisal-stream-pre');
    pre.dir = 'ltr';
    const code = el('code', undefined, command);
    pre.append(code);
    head.append(el('span', 'faisal-stream-commandlabel', label), copy);
    copy.addEventListener('click', () => { void copyCommand(pre, command); });
    block.append(head, pre);
    return block;
  }

  async function copyCommand(pre: HTMLElement, command: string): Promise<void> {
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) {
      selectContents(pre);
      setStatus(t('stream.copyFailed'));
      return;
    }
    try {
      await clipboard.writeText(command);
      setStatus(t('stream.copied'));
    } catch {
      // Selecting the text is the honest fallback: the user can still copy it.
      selectContents(pre);
      setStatus(t('stream.copyFailed'));
    }
  }

  function selectContents(node: HTMLElement): void {
    try {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    } catch { /* selection is a convenience, never a requirement */ }
  }

  function buildLimits(): HTMLElement {
    const wrap = el('div', 'faisal-stream-block');
    wrap.append(el('div', 'faisal-stream-blocktitle', t('stream.limitsTitle')));
    const list = el('ul', 'faisal-stream-limits');
    for (const key of ['limitDocker', 'limitResources', 'limitLatency', 'limitFocus', 'limitVideo']) {
      list.append(el('li', undefined, t(`stream.${key}`)));
    }
    wrap.append(list);
    return wrap;
  }

  function buildDocs(): HTMLElement {
    const wrap = el('div', 'faisal-stream-block');
    wrap.append(el('div', 'faisal-stream-blocktitle', t('stream.docTitle')));
    const link = document.createElement('a');
    link.className = 'faisal-stream-doc';
    link.href = STREAM_DOC_URL;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = `${t('stream.docLink')} — ${STREAM_DOC_PATH}`;
    wrap.append(link, el('p', 'faisal-stream-p is-muted', t('stream.docNote')));
    return wrap;
  }

  /* ── the probe ── */
  async function check(url: string): Promise<void> {
    endpoint = url;
    const mySeq = ++seq;

    // A remote http endpoint is refused by this system's own CSP before it ever
    // loads: say so specifically instead of showing a frame that cannot work.
    if (policy() === 'http-remote') {
      reachable = false;
      showSetup('insecure-remote');
      return;
    }

    showChecking();
    const answered = await probeStream(endpoint, PROBE_TIMEOUT_MS);
    if (mySeq !== seq) return; // a newer check already owns the window
    reachable = answered;
    if (answered) showFrame(true);
    else showSetup('unreachable');
  }

  /* ── fullscreen (the frame is what should fill the screen) ── */
  function toggleFullscreen(): void {
    try {
      if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => { /* already out */ });
        return;
      }
      const target: HTMLElement = frame ?? stage;
      const request = target.requestFullscreen?.bind(target);
      if (!request) {
        setStatus(t('stream.fullscreenUnsupported'));
        return;
      }
      void Promise.resolve(request()).catch(() => setStatus(t('stream.fullscreenFailed')));
    } catch {
      setStatus(t('stream.fullscreenFailed'));
    }
  }

  function syncFullscreenButton(): void {
    const isFull = Boolean(document.fullscreenElement);
    const label = isFull ? t('stream.fullscreenExit') : t('stream.fullscreen');
    fullscreenBtn.title = label;
    fullscreenBtn.setAttribute('aria-label', label);
    fullscreenBtn.replaceChildren(renderIcon(isFull ? ICON_FULLSCREEN_EXIT : ICON_FULLSCREEN));
  }

  /* ── wiring ── */
  fullscreenBtn.addEventListener('click', toggleFullscreen);
  changeBtn.addEventListener('click', () => showSetup('change'));
  backBtn.addEventListener('click', () => {
    // Back to the live frame: no new probe, no reconnection. The notice bar
    // still appears when the frame was opened without a confirmed connection.
    if (frame) showFrame(reachable === true);
  });
  document.addEventListener('fullscreenchange', syncFullscreenButton);
  win.onClose(() => {
    seq++;
    if (statusTimer !== null) { clearTimeout(statusTimer); statusTimer = null; }
    document.removeEventListener('fullscreenchange', syncFullscreenButton);
  });

  syncBar();
  void check(endpoint);
}

export default { manifest, launch } as AppModule;
