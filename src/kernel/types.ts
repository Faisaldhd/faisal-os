/**
 * Fai$al OS — System contracts (عقود النظام).
 *
 * هذا الملف هو المصدر الوحيد للحقيقة بين المكوّنات. لا يعدّله أي مسار إلا المالك (kernel).
 * كل مكوّن يعتمد على هذه الواجهات فقط، لا على تفاصيل تنفيذ المكوّنات الأخرى.
 */

export type Unsubscribe = () => void;

/* ───────────────────────────── Event bus ───────────────────────────── */

export interface SystemEvents {
  'fs:change': { path: string; kind: 'create' | 'modify' | 'delete' | 'rename'; oldPath?: string };
  'app:launched': { appId: string; windowId: string };
  'app:closed': { appId: string; windowId: string };
  /**
   * A single-instance app that is already open was launched again (for example a second
   * file opened from Files). Only that window reacts; the new args are handed to it
   * instead of being dropped.
   */
  'app:activate': { appId: string; windowId: string; args: string[] };
  'window:focus': { windowId: string };
  /** A window was minimized, restored, maximized, snapped or closed. */
  'window:change': { windowId: string };
  'settings:change': { key: string; value: unknown };
  'notify': { title: string; body?: string; appId?: string };
  'system:ready': Record<string, never>;
  /** Installed set changed (Store installed/removed an app). Shell re-renders launchers. */
  'apps:changed': Record<string, never>;
}

export interface EventBus {
  on<K extends keyof SystemEvents>(type: K, handler: (payload: SystemEvents[K]) => void): Unsubscribe;
  emit<K extends keyof SystemEvents>(type: K, payload: SystemEvents[K]): void;
}

/* ───────────────────────── Virtual file system ─────────────────────── */

export type VFSErrorCode =
  | 'ENOENT' | 'EEXIST' | 'ENOTDIR' | 'EISDIR' | 'ENOTEMPTY' | 'EACCES' | 'EINVAL';

export class VFSError extends Error {
  constructor(public code: VFSErrorCode, public path: string, message?: string) {
    super(message ?? `${code}: ${path}`);
    this.name = 'VFSError';
  }
}

export interface Stat {
  path: string;          // absolute, normalized ("/home/user/a.txt")
  name: string;          // basename ("a.txt"); "/" for root
  type: 'file' | 'dir';
  size: number;          // bytes (0 for dirs)
  mode: number;          // unix-like permission bits, e.g. 0o644 / 0o755
  mtime: number;         // ms epoch
  ctime: number;         // ms epoch
}

/** كل المسارات مطلقة وPOSIX. الدوال async دائماً. الأخطاء من نوع VFSError. */
export interface VFS {
  stat(path: string): Promise<Stat>;
  exists(path: string): Promise<boolean>;
  readdir(path: string): Promise<Stat[]>;
  readFile(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  /** ينشئ الملف أو يستبدله. الأب يجب أن يكون موجوداً وإلا ENOENT. */
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

/* ─────────────────────────── Windows / shell ───────────────────────── */

export interface WindowOptions {
  appId: string;
  title: string;
  icon?: string;            // SVG markup أو data: URL
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  resizable?: boolean;      // default true
}

export interface WindowHandle {
  readonly id: string;
  readonly appId: string;
  /** العنصر الذي يرسم فيه التطبيق محتواه. */
  readonly content: HTMLElement;
  setTitle(title: string): void;
  focus(): void;
  close(): void;
  onClose(cb: () => void): Unsubscribe;
  /**
   * Closes the window the way the user would: the app's close guard runs first, and the
   * window stays open when it says no. System-initiated closes (uninstall, System Monitor)
   * must use this rather than close(), which is unconditional.
   */
  requestClose(): Promise<void>;
  /**
   * Asked before the user closes the window (close button, menu, shortcut); return false
   * to keep it open, e.g. after "discard unsaved changes?". close() itself always closes.
   */
  setCloseGuard(guard: (() => boolean | Promise<boolean>) | null): void;
  onResize(cb: (size: { width: number; height: number }) => void): Unsubscribe;
}

export interface WindowManager {
  open(opts: WindowOptions): WindowHandle;
  /** Windows in stacking order, bottom to top. */
  list(): WindowHandle[];
  get(id: string): WindowHandle | undefined;
  /** The focused (topmost visible) window, if any. */
  focused(): WindowHandle | undefined;
  isMinimized(id: string): boolean;
  minimize(id: string): void;
  toggleMaximize(id: string): void;
}

/* ───────────────────────────── Apps ───────────────────────────────── */

export type Permission =
  | 'fs:home'        // قراءة/كتابة داخل /home/user و /tmp فقط
  | 'fs:read-all'    // قراءة كامل النظام (الكتابة تبقى حسب fs:home)
  | 'fs:system'      // قراءة وكتابة كامل نظام الملفات
  | 'notifications'
  | 'settings'       // تعديل إعدادات النظام
  | 'apps:manage'    // تثبيت وإزالة التطبيقات (المتجر)
  | 'system:monitor' // رؤية التطبيقات المفتوحة وإغلاقها (مراقب النظام)
  | 'network';

export type AppCategory = 'system' | 'utilities' | 'accessories' | 'media' | 'development';

export interface AppManifest {
  id: string;                      // "org.faisal.Files"
  name: { ar: string; en: string };
  description?: { ar: string; en: string };
  icon: string;                    // SVG markup
  permissions: Permission[];
  singleInstance?: boolean;
  /** امتدادات الملفات التي يفتحها التطبيق (".txt"). */
  opens?: string[];
  category?: AppCategory;
  version?: string;
  /** تطبيق أساسي لا يمكن إزالته (الملفات، الطرفية، الإعدادات، المتجر). */
  core?: boolean;
  /** يُثبَّت تلقائياً عند أول تشغيل (الافتراضي true). */
  defaultInstalled?: boolean;
}

export interface CatalogEntry extends AppManifest {
  installed: boolean;
}

export interface RunningApp {
  appId: string;
  windowId: string;
  startedAt: number;   // ms epoch
}

export interface AppContext {
  readonly sys: SystemAPI;          // الوصول مقيّد حسب permissions
  readonly window: WindowHandle;
  readonly args: string[];         // مثلاً مسار ملف للفتح
}

export interface AppModule {
  manifest: AppManifest;
  launch(ctx: AppContext): void | Promise<void>;
}

/** An app whose code is loaded on first launch; only the manifest is needed up front. */
export interface LazyAppModule {
  manifest: AppManifest;
  load(): Promise<AppModule>;
}

export interface AppRegistry {
  register(app: AppModule | LazyAppModule): void;
  /** التطبيقات المثبتة فقط (تظهر في المشغّل). */
  list(): AppManifest[];
  /** كل التطبيقات المتاحة مع حالة التثبيت. متاحة للجميع للقراءة. */
  catalog(): CatalogEntry[];
  /** يتطلب apps:manage. */
  install(appId: string): void;
  /** يتطلب apps:manage. يغلق نوافذ التطبيق. التطبيقات الأساسية ترمي خطأ. */
  uninstall(appId: string): void;
  /** يتطلب system:monitor. */
  running(): RunningApp[];
  /** يتطلب system:monitor. */
  closeWindow(windowId: string): void;
  launch(appId: string, args?: string[]): Promise<WindowHandle | undefined>;
  /** يجد التطبيق المناسب لملف حسب الامتداد. */
  appForFile(path: string): AppManifest | undefined;
}

/* ─────────────────────────── Settings / i18n ───────────────────────── */

export interface Settings {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

export type Locale = 'ar' | 'en';

/* ─────────────────────────── Terminal backend ──────────────────────── */

export interface TerminalBackend {
  readonly kind: 'sim' | 'v86';
  /** يبدأ الجلسة؛ كل ما يُكتب للشاشة يمر عبر output. */
  start(output: (data: string) => void): Promise<void>;
  /** إدخال المستخدم الخام من xterm (بما فيها \r وأسهم ANSI). */
  input(data: string): void;
  resize?(cols: number, rows: number): void;
  dispose(): void;
}

/* ───────────────────────────── System ─────────────────────────────── */

export interface SystemAPI {
  bus: EventBus;
  vfs: VFS;
  wm: WindowManager;
  apps: AppRegistry;
  settings: Settings;
  locale(): Locale;
  t(key: string, vars?: Record<string, string | number>): string;
  notify(title: string, body?: string): void;
}

export const HOME = '/home/user';
