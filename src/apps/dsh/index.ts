/**
 * Fai$al OS — DeepSeek Harness window (نافذة ديب سيك هارنس).
 *
 * WHAT THIS IS: one more app whose window content is an <iframe> pointing at the
 * web interface of the DeepSeek Harness — the owner's own agent/chat harness,
 * a separate project (https://github.com/deepseek-ai/deepseek-harness) installed
 * outside Fai$al OS and started by the owner himself. The window manager and the
 * kernel know nothing about it: this file only decides which URL the frame gets
 * and what the user sees around it.
 *
 * WHAT THIS IS NOT:
 *  • Not a launcher. A browser page cannot start a program on the machine, so it
 *    cannot start DSH, Node or pnpm. It shows a server that is already running.
 *  • Not a proxy, and not a way around DSH's token. The server answers 401 on
 *    EVERY path without a credential — including `/` and `/index.html` — so the
 *    owner pastes the full URL the harness printed, token and all, and exactly
 *    that URL is framed.
 *  • Not a place where OS data travels. Nothing from the VFS, the settings, the
 *    kernel, or any key is ever sent to the frame: no postMessage in either
 *    direction, no contentWindow access, no reading its DOM. The only thing that
 *    crosses is the URL the owner typed.
 *  • Not a claim of connectivity. A probe result is a probe result; the badge
 *    always says what the app is, never "connected". The probe cannot even tell a
 *    401 from a rendered page — both resolve — so the window says "answered is not
 *    authorised" in as many words.
 *
 * Honest failure policy: if the endpoint does not answer, or if it is a remote
 * endpoint that this system's own CSP will refuse (remote origins must be https —
 * see dshEndpointPolicy), the window shows a setup screen that says exactly that.
 * Never a blank frame, never an invented success state.
 */
import { manifest } from './manifest';
import type { AppContext, AppModule } from '../../kernel/types';
import { defineStrings, t } from '../../kernel/i18n';
import { renderIcon } from '../../shell/icon';
import {
  DSH_DOC_PATH,
  DSH_DOC_URL,
  DSH_START_COMMANDS,
  IFRAME_ALLOW,
  IFRAME_SANDBOX,
  NO_STORAGE,
  PROBE_TIMEOUT_MS,
  dshEndpointPolicy,
  localStorageOrNull,
  normalizeDshUrl,
  probeDsh,
  saveDshUrl,
  savedDshUrl,
  type DshEndpointPolicy,
  type DshStorage,
} from './config';
import './dsh.css';

/** Every user-visible string of this window, in both languages. */
defineStrings('dsh', {
  ar: {
    title: 'ديب سيك هارنس',
    badge: 'هارنس محلي',
    frameTitle: 'واجهة ديب سيك هارنس المحلية',
    endpointLabel: 'عنوان واجهة DSH (مع الرمز)',
    endpointPlaceholder: 'http://127.0.0.1:3080/?token=…',
    check: 'تحقّق',
    checking: 'جارٍ فحص العنوان…',
    changeUrl: 'تغيير العنوان',
    backToHarness: 'رجوع إلى الواجهة',
    openExternal: 'افتح في تبويب جديد',
    fullscreen: 'ملء الشاشة',
    fullscreenExit: 'الخروج من ملء الشاشة',
    fullscreenFailed: 'رفض المتصفح تكبير الإطار. جرّب زر ملء الشاشة في شريط النافذة.',
    fullscreenUnsupported: 'هذا المتصفح لا يدعم ملء الشاشة.',

    setupTitle: 'تشغيل ديب سيك هارنس',
    setupLead:
      'ديب سيك هارنس (DSH) هو وكيل المحادثة والبرمجة الذي تشغّله أنت على جهازك: مشروع منفصل تماماً عن Fai$al OS، يُثبَّت ويُشغَّل خارج النظام. هذه النافذة تعرض واجهته على شاشة جهازك، ولا شيء أكثر.',
    outsideNote:
      'يجب تشغيله خارج النظام أولاً: صفحة في المتصفح لا تستطيع تشغيل برنامج على جهازك. Fai$al OS لا يثبّت DSH ولا يبدأه ولا يوقفه — إنه يعرض خادماً يعمل بالفعل على جهازك.',
    launcherNote:
      'على هذا الجهاز يوجد أيضاً مشغّل سطح المكتب «Deepseek.bat» يشغّل DSH بالنقر المزدوج، إن كنت لا تريد كتابة أوامر.',
    notReachableTitle: 'لا شيء يستجيب على هذا العنوان',
    notReachableBody:
      'أُرسل طلب واحد إلى العنوان ولم يصل جواب — لا من الصفحة ولا من الخادم. تأكّد أن DSH يعمل (انظر أوامر التشغيل أدناه)، وأن المنفذ هو نفسه المكتوب هنا (3080 افتراضياً)، ثم اضغط «تحقّق» مرة أخرى.',
    probeNote:
      'الفحص لا يقرأ الردّ ولا يفهمه: أي جواب — حتى صفحة 401 فارغة — يُعدّ «استجاب». أي أن «استجاب» لا تعني «مصرَّح لك»: واجهة DSH محميّة برمز، وبدونه يردّ الخادم 401 على كل المسارات، ومنها / و /index.html. لذلك لا تقول الشارة أبداً «متصل».',
    openAnyway: 'افتح الإطار على أي حال',
    openAnywayNote:
      'زر «افتح الإطار على أي حال» يعرض الإطار دون تأكيد الاتصال. إن كان العنوان ناقص الرمز فستراه يردّ 401 داخل الإطار، وإن كان الخادم متوقفاً فستبقى المساحة فارغة.',
    unconfirmedNotice:
      'الاتصال غير مؤكَّد: فُتح الإطار بناءً على طلبك، والفحص لم ينجح. إن ظهر 401 أو صفحة خطأ بدل الواجهة، فالعنوان الكامل (مع الرمز) هو ما ينقص، أو أن DSH لا يعمل.',

    badUrl:
      'هذا ليس عنواناً صالحاً. المسموح http:// أو https:// فقط — لا javascript: ولا data: ولا blob: ولا file:، ولا كلمة مرور داخل العنوان. والصقه كاملاً مع رمز الدخول.',
    insecureRemoteTitle: 'عنوان بعيد بلا تشفير',
    insecureRemoteBody:
      'العناوين البعيدة يجب أن تبدأ بـ https://. يسمح هذا النظام بـ http:// للعناوين المحلية فقط (127.0.0.1 أو localhost)، لذلك سيرفض المتصفح عرض هذا الإطار — وقد رُفض قبل أن يُرسَل أي طلب. شغّل DSH على هذا الجهاز، أو ضع وكيلاً عكسياً بشهادة موثوقة (https) ثم أعد المحاولة. لم يُنشأ إطار ولا أُرسل فحص.',

    startTitle: 'أوامر التشغيل (خارج النظام)',
    startNote:
      'افتح PowerShell على جهازك والصق الأمر كما هو. لا يوجد نص عربي داخل الأوامر عن قصد: أمر الطرفية نص برمجي لا نص أدبي، والحرف العربي داخله سبب فشل إضافي.',
    startWindowsLabel: 'ويندوز / PowerShell — سطر واحد (تغيير المجلد ثم التشغيل)',
    startCheckoutLabel: 'من داخل مجلد DSH: تشغيل خادم الويب وحده',
    startNpxLabel: 'بلا نسخة محلية من المستودع (يحتاج Node):',
    copy: 'نسخ',
    copied: 'تم النسخ إلى الحافظة.',
    copyFailed: 'تعذّر النسخ تلقائياً — حُدّد النص، انسخه بلوحة المفاتيح.',
    saveFailed: 'تعذّر حفظ العنوان في هذا المتصفح (الوضع الخاص؟) — سيُستخدم لهذه الجلسة فقط.',
    tokenNote:
      'الواجهة محميّة برمز دخول: الخادم يردّ 401 على كل مسار بلا رمز. لذلك انسخ العنوان الكامل الذي يطبعه DSH عند التشغيل (وفيه ?token=…) والصقه في الحقل أدناه. يُحفظ الرمز في مفاتيح هذا التطبيق المحلية (faisal.dsh.url) ولا يُرسل إلى أي مكان آخر.',

    limitsTitle: 'حدود صريحة',
    limitNode: 'يحتاج Node.js (الإصدار 22 أو أحدث) ونسخة من مستودع DSH — أو npx للبديل بلا نسخة محلية.',
    limitManual: 'يجب تشغيله بيدك خارج النظام: النظام لا يستطيع تشغيل برنامج على جهازك، ولا يبدأ DSH ولا يوقفه.',
    limitToken: 'الواجهة محميّة برمز، فالرابط وحده بلا رمز يعرض 401. انسخ العنوان كاملاً من مخرجات DSH.',
    limitFrameOnly:
      'النظام يعرض الإطار فقط: لا يقرأ محتواه ولا يتحكّم فيه ولا يرسل إليه أي بيانات — لا ملفات ولا إعدادات ولا مفاتيح.',
    limitOffline: 'بلا خادم DSH يعمل على جهازك لا توجد واجهة: هذه النافذة لا تحتوي نسخة من DSH ولا تشغّله.',

    docTitle: 'التوثيق الكامل',
    docLink: 'دليل نافذة ديب سيك هارنس في المستودع',
    docNote:
      'الرابط يفتح الملف في المستودع على GitHub، لأن ملفات docs غير منشورة في نسخة الويب. والمسار داخل الشجرة هو: ' + DSH_DOC_PATH + '.',
  },
  en: {
    title: 'DeepSeek Harness',
    badge: 'Local harness',
    frameTitle: 'The local DeepSeek Harness interface',
    endpointLabel: 'DSH interface address (token included)',
    endpointPlaceholder: 'http://127.0.0.1:3080/?token=…',
    check: 'Check',
    checking: 'Checking the endpoint…',
    changeUrl: 'Change address',
    backToHarness: 'Back to the harness',
    openExternal: 'Open in a new tab',
    fullscreen: 'Fullscreen',
    fullscreenExit: 'Leave fullscreen',
    fullscreenFailed: 'The browser refused to make the frame fullscreen. Try the window’s own fullscreen button.',
    fullscreenUnsupported: 'This browser has no fullscreen support.',

    setupTitle: 'Run the DeepSeek Harness',
    setupLead:
      'The DeepSeek Harness (DSH) is the agent/chat harness you run on your own machine: a project entirely separate from Fai$al OS, installed and started outside the OS. This window shows its interface on your screen, and nothing more.',
    outsideNote:
      'It has to be started outside the OS first: a page in a browser cannot start a program on your machine. Fai$al OS does not install DSH, does not start it and does not stop it — it shows a server that is already running on your machine.',
    launcherNote:
      'On this machine there is also a desktop launcher, “Deepseek.bat”, which starts DSH on a double click if you would rather not type commands.',
    notReachableTitle: 'Nothing answers on this address',
    notReachableBody:
      'One request was sent to the address and nothing answered — not the page, not the server. Check that DSH is running (the start commands are below), that the port is the one written here (3080 by default), and then press “Check” again.',
    probeNote:
      'The probe never reads the reply and never parses it: any answer — even an empty 401 page — counts as “answered”. So “answered” does not mean “authorised”: the DSH interface is token-protected, and without the token the server answers 401 on every path, `/` and `/index.html` included. That is why the badge never says “connected”.',
    openAnyway: 'Open the frame anyway',
    openAnywayNote:
      '“Open the frame anyway” shows the frame without a confirmed connection. If the address is missing its token you will see the 401 inside the frame; if the server is stopped, the area stays blank.',
    unconfirmedNotice:
      'The connection is not confirmed: the frame was opened at your request and the probe did not succeed. If a 401 or an error page appears instead of the interface, the full URL (with the token) is what is missing, or DSH is not running.',

    badUrl:
      'That is not a usable address. Only http:// or https:// — never javascript:, data:, blob: or file:, and no password inside the address. Paste it in full, including the token.',
    insecureRemoteTitle: 'A remote address without encryption',
    insecureRemoteBody:
      'Remote endpoints must start with https://. This system allows http:// for loopback addresses only (127.0.0.1 or localhost), so the browser will refuse to show this frame — and it was refused before any request was sent. Run DSH on this machine, or put a reverse proxy with a trusted certificate (https) in front of it and try again. No frame was created and no probe was sent.',

    startTitle: 'Start commands (outside the OS)',
    startNote:
      'Open PowerShell on your machine and paste the command as it is. No Arabic text appears inside the commands on purpose: a terminal command is program text, not prose, and an Arabic word inside it is one more way to fail.',
    startWindowsLabel: 'Windows / PowerShell — one line (change directory, then start)',
    startCheckoutLabel: 'From inside the DSH directory: start the web server alone',
    startNpxLabel: 'With no local copy of the repository (needs Node):',
    copy: 'Copy',
    copied: 'Copied to the clipboard.',
    copyFailed: 'Could not copy automatically — the text is selected; copy it from the keyboard.',
    saveFailed: 'This browser refused to save the address (private mode?) — it is used for this session only.',
    tokenNote:
      'The interface is token-protected: the server answers 401 on every path without a token. Copy the full URL DSH prints when it starts (the one carrying ?token=…) and paste it into the field below. The token is stored in this app’s own local key (faisal.dsh.url) and is sent nowhere else.',

    limitsTitle: 'Honest limits',
    limitNode: 'Needs Node.js (version 22 or newer) and a copy of the DSH repository — or npx for the no-checkout route.',
    limitManual: 'You must start it yourself, outside the OS: the OS cannot start a program on your machine, and it neither starts nor stops DSH.',
    limitToken: 'The interface is token-protected, so a bare link without the token shows a 401. Copy the whole address from the DSH output.',
    limitFrameOnly:
      'The OS only shows the frame: it does not read it, does not control it, and sends it no data — no files, no settings, no keys.',
    limitOffline: 'With no DSH server running on your machine there is no interface: this window holds no copy of DSH and does not start it.',

    docTitle: 'Full documentation',
    docLink: 'The DeepSeek Harness window guide in the repository',
    docNote:
      'The link opens the file in the repository on GitHub, because `docs` files are not published in the web build. Its path inside the tree is: ' + DSH_DOC_PATH + '.',
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
  b.className = 'faisal-dsh-btn' + (extraClass ? ` ${extraClass}` : '');
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
const ICON_EXTERNAL =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
  '<path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* ─────────────────────────────── the window ─────────────────────────────── */

type View = 'checking' | 'ready' | 'setup';
type SetupReason = 'unreachable' | 'change' | 'insecure-remote';

function launch(ctx: AppContext): void {
  const { window: win } = ctx;
  // localStorage, never sys.settings: this app has no `settings` permission and
  // must not ask for one just to remember its own endpoint.
  const storage: DshStorage = localStorageOrNull() ?? NO_STORAGE;

  win.setTitle(t('dsh.title'));
  win.content.textContent = '';

  const root = el('div', 'faisal-dsh');
  const bar = el('div', 'faisal-dsh-bar');
  // The badge is permanent: it stays in the toolbar in every view, whether or not
  // the endpoint answered, and it names the feature — not a connection.
  const badge = el('span', 'faisal-dsh-badge', t('dsh.badge'));
  const endpointEl = el('span', 'faisal-dsh-endpoint');
  endpointEl.dir = 'ltr';
  const status = el('span', 'faisal-dsh-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const spacer = el('span', 'faisal-dsh-spacer');
  const fullscreenBtn = iconButton(ICON_FULLSCREEN, t('dsh.fullscreen'));
  const externalBtn = iconButton(ICON_EXTERNAL, t('dsh.openExternal'));
  const changeBtn = button(t('dsh.changeUrl'), 'faisal-dsh-action');
  const backBtn = button(t('dsh.backToHarness'), 'faisal-dsh-action');
  bar.append(badge, endpointEl, status, spacer, fullscreenBtn, externalBtn, changeBtn, backBtn);

  const body = el('div', 'faisal-dsh-body');
  // The frame lives in its own stage, which is only *hidden* by the setup view. A
  // live chat therefore survives "Change address" and "Back to the harness"
  // instead of being torn down and reloaded.
  const stage = el('div', 'faisal-dsh-stage');
  const noticeHost = el('div', 'faisal-dsh-notices');
  const frameHost = el('div', 'faisal-dsh-framehost');
  stage.append(noticeHost, frameHost);
  stage.hidden = true;
  const panelHost = el('div', 'faisal-dsh-panelhost');
  body.append(stage, panelHost);
  root.append(bar, body);
  win.content.append(root);

  let endpoint = savedDshUrl(storage);
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

  const endpointPolicy = (): DshEndpointPolicy | null => dshEndpointPolicy(endpoint);

  function setStatus(text: string): void {
    status.textContent = text;
    if (statusTimer !== null) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { status.textContent = ''; statusTimer = null; }, 8000);
  }

  /** Shows/hides the toolbar buttons that only make sense in one view. */
  function syncBar(): void {
    const hasFrame = frame !== null;
    fullscreenBtn.hidden = view !== 'ready';
    externalBtn.hidden = view !== 'ready';
    changeBtn.hidden = view !== 'ready';
    backBtn.hidden = view !== 'setup' || !hasFrame;
    endpointEl.textContent = endpoint;
    endpointEl.title = endpoint;
  }

  /* ── the framed harness ── */
  function showFrame(confirmed: boolean): void {
    view = 'ready';
    if (!frame || frameUrl !== endpoint) {
      frameHost.textContent = '';
      frame = createFrame(endpoint);
      frameUrl = endpoint;
      frameHost.append(frame);
    }
    noticeHost.textContent = '';
    if (!confirmed) noticeHost.append(noticeBar(t('dsh.unconfirmedNotice')));
    stage.hidden = false;
    panelHost.textContent = '';
    syncBar();
  }

  function createFrame(url: string): HTMLIFrameElement {
    const f = document.createElement('iframe');
    f.className = 'faisal-dsh-frame';
    // Every restriction is set before `src`, so the frame never loads for even one
    // tick without them:
    //  • the least sandbox a cross-origin GUI needs (see config.ts),
    //  • clipboard + fullscreen delegation — granted here, unlike the Streamed
    //    Browser, because this is the owner's own local tool (see config.ts),
    //  • no referrer is ever sent to the harness.
    f.setAttribute('sandbox', IFRAME_SANDBOX);
    f.setAttribute('allow', IFRAME_ALLOW);
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.setAttribute('title', t('dsh.frameTitle'));
    f.loading = 'eager';
    f.src = url;
    return f;
  }

  function noticeBar(text: string): HTMLElement {
    return el('div', 'faisal-dsh-notice', text);
  }

  function showChecking(): void {
    view = 'checking';
    stage.hidden = true;
    const card = el('div', 'faisal-dsh-card');
    const spinner = el('div', 'faisal-dsh-progress');
    const ring = el('span', 'faisal-dsh-spinner');
    const label = el('span', undefined, t('dsh.checking'));
    spinner.append(ring, label);
    const where = el('div', 'faisal-dsh-url', endpoint);
    where.dir = 'ltr';
    card.append(spinner, where);
    panelHost.replaceChildren(card);
    syncBar();
  }

  /* ── the setup screen: the honest path when there is no harness ── */
  function showSetup(reason: SetupReason): void {
    view = 'setup';
    stage.hidden = true;
    panelHost.replaceChildren(buildSetup(reason));
    syncBar();
  }

  function buildSetup(reason: SetupReason): HTMLElement {
    const card = el('div', 'faisal-dsh-card is-setup');
    card.append(el('h2', 'faisal-dsh-h2', t('dsh.setupTitle')));
    card.append(el('p', 'faisal-dsh-p', t('dsh.setupLead')));
    card.append(el('p', 'faisal-dsh-p is-muted', t('dsh.outsideNote')));
    card.append(el('p', 'faisal-dsh-p is-muted', t('dsh.launcherNote')));

    if (reason === 'insecure-remote') {
      const warn = el('div', 'faisal-dsh-block is-warning');
      warn.append(el('div', 'faisal-dsh-blocktitle', t('dsh.insecureRemoteTitle')));
      warn.append(el('p', 'faisal-dsh-p', t('dsh.insecureRemoteBody')));
      card.append(warn);
    }
    if (reason === 'unreachable') {
      const block = el('div', 'faisal-dsh-block');
      block.append(el('div', 'faisal-dsh-blocktitle', t('dsh.notReachableTitle')));
      block.append(el('p', 'faisal-dsh-p', t('dsh.notReachableBody')));
      block.append(el('p', 'faisal-dsh-p is-muted', t('dsh.probeNote')));
      const actions = el('div', 'faisal-dsh-actions');
      // An explicit, labelled override — never a silent "pretend it worked".
      const anyway = button(t('dsh.openAnyway'), 'faisal-dsh-action is-primary');
      anyway.addEventListener('click', () => showFrame(false));
      actions.append(anyway);
      block.append(actions, el('p', 'faisal-dsh-p is-muted', t('dsh.openAnywayNote')));
      card.append(block);
    }

    card.append(buildEndpointForm());
    card.append(buildCommands());
    card.append(buildLimits());
    card.append(buildDocs());
    return card;
  }

  function buildEndpointForm(): HTMLElement {
    const wrap = el('div', 'faisal-dsh-block');
    const form = el('form', 'faisal-dsh-form');
    const label = el('label', 'faisal-dsh-label', t('dsh.endpointLabel'));
    const field = el('input', 'faisal-dsh-input');
    field.type = 'text';
    field.dir = 'ltr';
    field.autocomplete = 'off';
    field.spellcheck = false;
    field.value = endpoint;
    field.placeholder = t('dsh.endpointPlaceholder');
    const id = 'faisal-dsh-endpoint-field';
    field.id = id;
    label.htmlFor = id;
    const submit = el('button', 'faisal-dsh-action is-primary', t('dsh.check'));
    submit.type = 'submit';
    const error = el('p', 'faisal-dsh-p is-error');
    form.append(label, field, submit);
    // Without this, arrow keys/backspace in the field reach the shell and move
    // window focus instead of editing the address.
    field.addEventListener('keydown', (ev) => ev.stopPropagation());
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      error.textContent = '';
      const next = normalizeDshUrl(field.value);
      if (!next) {
        // Nothing invalid is ever stored, framed or probed.
        error.textContent = t('dsh.badUrl');
        return;
      }
      const saved = saveDshUrl(next, storage);
      if (!saved) setStatus(t('dsh.saveFailed'));
      void check(next);
    });
    wrap.append(form, error);
    wrap.append(el('p', 'faisal-dsh-p is-muted', t('dsh.tokenNote')));
    return wrap;
  }

  function buildCommands(): HTMLElement {
    const wrap = el('div', 'faisal-dsh-block');
    wrap.append(el('div', 'faisal-dsh-blocktitle', t('dsh.startTitle')));
    wrap.append(el('p', 'faisal-dsh-p is-muted', t('dsh.startNote')));
    for (const entry of DSH_START_COMMANDS) {
      wrap.append(commandBlock(t(entry.labelKey), entry.command));
    }
    return wrap;
  }

  /** One copy-ready command: literal text in a <pre>, never HTML. */
  function commandBlock(label: string, command: string): HTMLElement {
    const block = el('div', 'faisal-dsh-command');
    const head = el('div', 'faisal-dsh-commandhead');
    const copy = button(t('dsh.copy'), 'faisal-dsh-copy');
    const pre = el('pre', 'faisal-dsh-pre');
    pre.dir = 'ltr';
    const code = el('code', undefined, command);
    pre.append(code);
    head.append(el('span', 'faisal-dsh-commandlabel', label), copy);
    copy.addEventListener('click', () => { void copyCommand(pre, command); });
    block.append(head, pre);
    return block;
  }

  async function copyCommand(pre: HTMLElement, command: string): Promise<void> {
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) {
      selectContents(pre);
      setStatus(t('dsh.copyFailed'));
      return;
    }
    try {
      await clipboard.writeText(command);
      setStatus(t('dsh.copied'));
    } catch {
      // Selecting the text is the honest fallback: the user can still copy it.
      selectContents(pre);
      setStatus(t('dsh.copyFailed'));
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
    const wrap = el('div', 'faisal-dsh-block');
    wrap.append(el('div', 'faisal-dsh-blocktitle', t('dsh.limitsTitle')));
    const list = el('ul', 'faisal-dsh-limits');
    for (const key of ['limitNode', 'limitManual', 'limitToken', 'limitFrameOnly', 'limitOffline']) {
      list.append(el('li', undefined, t(`dsh.${key}`)));
    }
    wrap.append(list);
    return wrap;
  }

  function buildDocs(): HTMLElement {
    const wrap = el('div', 'faisal-dsh-block');
    wrap.append(el('div', 'faisal-dsh-blocktitle', t('dsh.docTitle')));
    const link = document.createElement('a');
    link.className = 'faisal-dsh-doc';
    link.href = DSH_DOC_URL;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = `${t('dsh.docLink')} — ${DSH_DOC_PATH}`;
    wrap.append(link, el('p', 'faisal-dsh-p is-muted', t('dsh.docNote')));
    return wrap;
  }

  /* ── the probe ── */
  async function check(url: string): Promise<void> {
    endpoint = url;
    const mySeq = ++seq;

    // A remote http endpoint is refused by this system's own CSP before it ever
    // loads: say so specifically instead of showing a frame that cannot work —
    // and send no probe at all.
    if (endpointPolicy() === 'http-remote') {
      reachable = false;
      showSetup('insecure-remote');
      return;
    }

    showChecking();
    // "Answered" is not "authorised": DSH answers 401 without a token, and that
    // 401 resolves here exactly like a rendered page. The window says so.
    const answered = await probeDsh(endpoint, PROBE_TIMEOUT_MS);
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
        setStatus(t('dsh.fullscreenUnsupported'));
        return;
      }
      void Promise.resolve(request()).catch(() => setStatus(t('dsh.fullscreenFailed')));
    } catch {
      setStatus(t('dsh.fullscreenFailed'));
    }
  }

  function syncFullscreenButton(): void {
    const isFull = Boolean(document.fullscreenElement);
    const label = isFull ? t('dsh.fullscreenExit') : t('dsh.fullscreen');
    fullscreenBtn.title = label;
    fullscreenBtn.setAttribute('aria-label', label);
    fullscreenBtn.replaceChildren(renderIcon(isFull ? ICON_FULLSCREEN_EXIT : ICON_FULLSCREEN));
  }

  /** Opens exactly the framed URL in a real tab — the frame stays where it is. */
  function openExternal(): void {
    try {
      const opened = window.open(endpoint, '_blank', 'noopener,noreferrer');
      if (!opened) setStatus(t('dsh.fullscreenUnsupported'));
    } catch {
      setStatus(t('dsh.fullscreenUnsupported'));
    }
  }

  /* ── wiring ── */
  fullscreenBtn.addEventListener('click', toggleFullscreen);
  externalBtn.addEventListener('click', openExternal);
  changeBtn.addEventListener('click', () => showSetup('change'));
  backBtn.addEventListener('click', () => {
    // Back to the live frame: no new probe, no reload. The notice bar still
    // appears when the frame was opened without a confirmed connection.
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
