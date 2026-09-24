import { beforeEach, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import type { AppContext, SystemAPI, WindowHandle } from '../../kernel/types';
import app from './index';

/**
 * The window itself, built in jsdom: this is the layer the other tests cannot reach. It
 * proves the wiring (a real PDF open → the panel, the page rows, the operations and their
 * bilingual descriptions, the save target), that one operation really runs through the
 * window and is verified, and that a non-PDF is refused with its own honest message.
 */
const bytesOf = (text: string): Uint8Array => Uint8Array.from(new TextEncoder().encode(text));

async function makePdf(pages: { w: number; h: number; rotation?: number; label?: string }[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const spec of pages) {
    const page = doc.addPage([spec.w, spec.h]);
    if (spec.rotation) page.setRotation(degrees(spec.rotation));
    if (spec.label) page.drawText(spec.label, { x: 8, y: 8, size: 10, font });
  }
  return Uint8Array.from(await doc.save({ useObjectStreams: false }));
}

/** Lets every pending microtask and timer inside `launch` run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeApp(path: string, bytes: Uint8Array | null) {
  const files = new Map<string, Uint8Array>();
  if (bytes) files.set(path, bytes);
  const content = document.createElement('div');
  const titles: string[] = [];
  const window = {
    id: 'win-1',
    appId: 'org.faisal.Pdf',
    content,
    setTitle: (title: string) => { titles.push(title); },
    focus: () => {},
    close: () => {},
    onClose: () => () => {},
    requestClose: async () => {},
    setCloseGuard: () => {},
    onResize: () => () => {},
  };
  const vfs = {
    stat: async (p: string) => ({ path: p, name: p.slice(p.lastIndexOf('/') + 1), type: 'file' as const, size: files.get(p)?.length ?? 0, mode: 0o644, mtime: 0, ctime: 0 }),
    exists: async (p: string) => files.has(p),
    readFile: async (p: string) => {
      const data = files.get(p);
      if (!data) throw new Error(`ENOENT: ${p}`);
      return data;
    },
    readText: async (p: string) => new TextDecoder().decode(await vfs.readFile(p)),
    writeFile: async (p: string, data: string | Uint8Array) => {
      files.set(p, typeof data === 'string' ? bytesOf(data) : Uint8Array.from(data));
    },
    mkdir: async () => {},
    remove: async () => {},
    rename: async () => {},
    chmod: async () => {},
    readdir: async () => [],
  };
  const sys = { vfs, locale: () => 'ar' as const, notify: () => {} } as unknown as SystemAPI;
  const ctx = { sys, window: window as unknown as WindowHandle, args: [path] } as AppContext;
  const button = (label: string): HTMLButtonElement => {
    const found = [...content.querySelectorAll('button')].find((node) => node.textContent === label);
    if (!found) throw new Error(`no button labelled "${label}"`);
    return found;
  };
  return { ctx, content, titles, files, button };
}

beforeEach(() => {
  // jsdom has no object URLs at all; the app only needs one to hand to the preview iframe.
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:pdf-test', configurable: true, writable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true, writable: true });
});

describe('PDF window', () => {
  it('opens a real PDF and builds the panel, the page rows and the save target', async () => {
    const pdf = await makePdf([{ w: 200, h: 300, label: 'a' }, { w: 210, h: 310 }, { w: 220, h: 320 }]);
    const { ctx, content, titles } = makeApp('/home/user/report.pdf', pdf);

    app.launch(ctx);
    await settle();

    // The window is renamed as soon as the file is known.
    expect(titles[titles.length - 1]).toContain('report.pdf');
    expect(content.querySelector('.faisal-pdf-frame')).not.toBeNull();
    expect(content.querySelector('.faisal-pdf-meta')?.textContent).toContain('3');
    expect(content.querySelectorAll('.faisal-pdf-pagerow')).toHaveLength(3);
    expect(content.querySelectorAll('.faisal-pdf-pagerow')[0].textContent).toContain('نقطة');

    // The save target is computed from the VFS and is a NEW file, not the opened one.
    expect(content.querySelector('.faisal-pdf-savetarget')?.textContent).toContain('/home/user/report-copy.pdf');

    // Every operation is described in Arabic, and the honest limits are on screen.
    const text = content.textContent ?? '';
    for (const label of [
      'معلومات المستند', 'الصفحات', 'حذف الصفحات', 'تدوير الصفحات', 'القص (صندوق القص)', 'علامة مائية نصية',
      'البيانات الوصفية', 'تقسيم / استخراج', 'دمج ملفات PDF', 'صور ← PDF', 'الحفظ', 'حدود صريحة',
    ]) {
      expect(text, label).toContain(label);
    }
    for (const limit of ['لا OCR', 'لا توقيع رقمي', 'لا تعبئة نماذج']) {
      expect(text, limit).toContain(limit);
    }
  });

  it('rotates the selected pages through the window and reports the verified result', async () => {
    const pdf = await makePdf([{ w: 200, h: 300 }, { w: 210, h: 310 }]);
    const { ctx, content, button } = makeApp('/home/user/spin.pdf', pdf);

    app.launch(ctx);
    await settle();

    button('تحديد الكل').click();
    await settle();
    expect(content.querySelector('.faisal-pdf-selection')?.textContent).toContain('المحدد: 2');

    button('90°').click();
    await settle();

    const rows = content.querySelectorAll('.faisal-pdf-pagerow');
    expect(rows[0].textContent).toContain('دوران 90');
    expect(rows[1].textContent).toContain('دوران 90');
    expect(content.querySelector('.faisal-pdf-status')?.textContent).toContain('تُحقّق من الناتج');
  });

  it('refuses a non-PDF file with its own message and never shows a frame', async () => {
    const { ctx, content } = makeApp('/home/user/notes.txt', bytesOf('hello, not a pdf at all'));

    app.launch(ctx);
    await settle();

    const failure = content.querySelector('.faisal-pdf-fail');
    expect(failure).not.toBeNull();
    expect(failure?.textContent).toContain('تعذّر فتح هذا الملف');
    expect(failure?.textContent).toContain('%PDF-');
    expect(failure?.textContent).toContain('لم يُكتب أي ملف');
    expect(content.querySelector('.faisal-pdf-frame')).toBeNull();
    expect(content.querySelector('.faisal-pdf')?.getAttribute('data-mode')).toBe('fail');
  });

  it('says what it cannot do when an Arabic watermark is typed, before any operation runs', async () => {
    const pdf = await makePdf([{ w: 200, h: 300 }]);
    const { ctx, content, button } = makeApp('/home/user/mark.pdf', pdf);

    app.launch(ctx);
    await settle();

    button('تحديد الكل').click();
    await settle();
    const textField = content.querySelector('#faisal-pdf-mark-text') as HTMLInputElement;
    textField.value = 'مسودة';
    button('إضافة العلامة المائية').click();
    await settle();

    const status = content.querySelector('.faisal-pdf-status')?.textContent ?? '';
    expect(status).toContain('خطوط PDF المدمجة لاتينية فقط');
    // The document is untouched: the page list still shows no rotation and no failure card.
    expect(content.querySelector('.faisal-pdf-pagerow')?.textContent).toContain('دوران 0');
  });
});
