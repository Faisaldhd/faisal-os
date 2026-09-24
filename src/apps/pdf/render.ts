/**
 * PDF app — loading pdf.js (محرّك عرض الصفحات), lazily and from our own bundle.
 *
 * Why pdf.js: pdf-lib edits documents but cannot draw a page. pdf.js is the one dependency that
 * paints real page content (fonts, images, vector art), extracts the text layer for selection
 * and search, and reads the outline and links. It is imported with `import()` only when a
 * document is opened in this app, so the shell bundle does not grow. The worker, the standard
 * fonts and the image-decoder wasm are emitted by Vite as our own assets — nothing comes from a
 * CDN, and the CSP (`worker-src 'self' blob:`, `script-src 'self' 'wasm-unsafe-eval'`) allows
 * all of it.
 *
 * The built-in CJK CMaps (1.7 MB) are deliberately not bundled: they only matter for documents
 * with non-embedded Chinese/Japanese/Korean fonts, and this system is Arabic/English first.
 */
import type * as PdfJs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

export type PdfJsLib = typeof PdfJs;
export type PdfJsDocument = PdfJs.PDFDocumentProxy;
export type PdfJsPage = PdfJs.PDFPageProxy;

const fontUrls = import.meta.glob('../../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}', {
  query: '?url', import: 'default', eager: true,
}) as Record<string, string>;
const wasmUrls = import.meta.glob('../../../node_modules/pdfjs-dist/wasm/*.wasm', {
  query: '?url', import: 'default', eager: true,
}) as Record<string, string>;

const byName = (map: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(map).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]));
const FONTS = byName(fontUrls);
const WASM = byName(wasmUrls);

/**
 * pdf.js asks its data factory for `<base><file name>`. The base is only a tag here: the file
 * name is looked up in the map of hashed asset URLs Vite produced, so no directory has to be
 * copied into `public/`.
 */
class AssetDataFactory {
  constructor(private readonly opts: { standardFontDataUrl?: string | null; wasmUrl?: string | null }) {}

  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const url = kind === 'standardFontDataUrl' ? FONTS.get(filename) : kind === 'wasmUrl' ? WASM.get(filename) : undefined;
    if (!url) throw new Error(`pdf asset not bundled: ${kind} ${filename}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`pdf asset ${filename}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

/** pdf.js needs a real canvas stack; jsdom (the tests) has none, and then the viewer says so. */
export function engineSupported(): boolean {
  const w = globalThis as unknown as Record<string, unknown>;
  return typeof w.DOMMatrix === 'function' && typeof w.Path2D === 'function' && typeof w.Worker === 'function';
}

let loading: Promise<PdfJsLib | null> | null = null;

export function loadEngine(): Promise<PdfJsLib | null> {
  if (!engineSupported()) return Promise.resolve(null);
  loading ??= import('pdfjs-dist/legacy/build/pdf.mjs')
    .then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = workerUrl;
      return lib as PdfJsLib;
    })
    .catch((error: unknown) => {
      console.warn('[pdf] could not load the page renderer', error);
      loading = null;
      return null;
    });
  return loading;
}

export interface OpenOptions {
  password?: string;
  /** Called when the document needs a password; resolve with it, or null to give up. */
  onPassword?: (retry: boolean) => Promise<string | null>;
}

/** Opens bytes for rendering. The bytes are copied: pdf.js transfers (detaches) its buffer. */
export async function openForRender(lib: PdfJsLib, bytes: Uint8Array, opts: OpenOptions = {}): Promise<PdfJsDocument> {
  const task = lib.getDocument({
    data: bytes.slice(),
    password: opts.password,
    standardFontDataUrl: 'fonts:',
    wasmUrl: 'wasm:',
    useWorkerFetch: false,
    BinaryDataFactory: AssetDataFactory,
    isEvalSupported: false,
    enableXfa: false,
    verbosity: 0,
  } as Parameters<PdfJsLib['getDocument']>[0]);
  if (opts.onPassword) {
    const ask = opts.onPassword;
    task.onPassword = (update: (password: string) => void, reason: number) => {
      void ask(reason === lib.PasswordResponses.INCORRECT_PASSWORD).then((password) => {
        if (password === null) void task.destroy();
        else update(password);
      });
    };
  }
  return task.promise;
}
