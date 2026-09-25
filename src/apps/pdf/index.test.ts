import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFArray, PDFDocument, PDFRawStream, StandardFonts, decodePDFRawStream, degrees } from 'pdf-lib';
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

/** A real AcroForm: a nested text field and a checkbox, the same shape an office PDF carries. */
async function makeFormPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const form = doc.getForm();
  form.createTextField('owner.name').addToPage(page, { x: 20, y: 220, width: 200, height: 24 });
  form.createCheckBox('agree').addToPage(page, { x: 20, y: 180, width: 18, height: 18 });
  return Uint8Array.from(await doc.save({ useObjectStreams: false }));
}

/** A page's content stream decoded back to text (pdf-lib deflates what it draws). */
function contentOf(doc: PDFDocument, index: number): string {
  const contents = doc.getPage(index).node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  let out = '';
  for (const ref of refs) {
    const stream = doc.context.lookup(ref);
    if (stream instanceof PDFRawStream) out += new TextDecoder().decode(decodePDFRawStream(stream).decode());
  }
  return out;
}

const hexOf = (text: string): string =>
  [...new TextEncoder().encode(text)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

function makeApp(path: string, bytes: Uint8Array | null) {
  const files = new Map<string, Uint8Array>();
  if (bytes) files.set(path, bytes);
  const content = document.createElement('div');
  // The window's content really lives in the document: without that, a child iframe has no
  // contentWindow in jsdom, and the print path cannot be exercised at all.
  document.body.append(content);
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
      'معلومات المستند', 'الصفحات',
      'إضافة نص إلى صفحة', 'إضافة توقيع', 'تغطية منطقة (إخفاء)', 'صفحة فارغة وتكرار الصفحات', 'تعبئة النموذج',
      'حذف الصفحات', 'تدوير الصفحات', 'القص (صندوق القص)', 'علامة مائية نصية',
      'البيانات الوصفية', 'تقسيم / استخراج', 'دمج ملفات PDF', 'صور ← PDF', 'الحفظ', 'حدود صريحة',
    ]) {
      expect(text, label).toContain(label);
    }
    for (const limit of ['لا OCR', 'لا توقيع رقمي', 'لا إنشاء نماذج', 'لا تعديل لنص موجود', 'الحجب يحذف محتوى الصفحات داخل المناطق فقط','قفل PDF بكلمة مرور غير مدعوم محلياً']) {
      expect(text, limit).toContain(limit);
    }
    // Covering is labelled as hiding, never as redaction — in the UI itself, not only in code.
    expect(text).toContain('هذه تغطية/إخفاء وليست حجباً');
    // True redaction is its own, separate panel that says it removes the content.
    expect(text).toContain('هذا حجب حقيقي: المحتوى داخل المناطق يُحذف من الملف');
    // The document has no form, and the window says so plainly instead of drawing an empty panel.
    expect(text).toContain('لا يحتوي على نموذج تفاعلي');
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

  it('adds text through the window and the saved copy really carries the text operator', async () => {
    const pdf = await makePdf([{ w: 200, h: 300 }]);
    const { ctx, content, files, button } = makeApp('/home/user/note.pdf', pdf);

    app.launch(ctx);
    await settle();

    (content.querySelector('#faisal-pdf-text-value') as HTMLInputElement).value = 'APPROVED';
    (content.querySelector('#faisal-pdf-text-x') as HTMLInputElement).value = '20';
    (content.querySelector('#faisal-pdf-text-y') as HTMLInputElement).value = '40';
    (content.querySelector('#faisal-pdf-text-size') as HTMLInputElement).value = '18';
    button('إضافة النص').click();
    await settle();

    const status = content.querySelector('.faisal-pdf-status')?.textContent ?? '';
    expect(status).toContain('أُضيف النص إلى الصفحة 1');
    expect(status).toContain('تُحقّق من الناتج');

    // Saving goes through the existing policy: a NEW sibling file, never the opened one.
    button('حفظ كنسخة جديدة').click();
    await settle();
    const saved = files.get('/home/user/note-copy.pdf');
    expect(saved).toBeTruthy();
    expect(files.get('/home/user/note.pdf')).toEqual(pdf);
    const out = await PDFDocument.load(saved as Uint8Array, { updateMetadata: false });
    expect(out.getPageCount()).toBe(1);
    const stream = contentOf(out, 0);
    expect(stream).toContain('Tj');
    expect(stream.toLowerCase()).toContain(hexOf('APPROVED'));
  });

  it('fills a real form field and a checkbox through the window, and the copy carries the values', async () => {
    const { ctx, content, files, button } = makeApp('/home/user/form.pdf', await makeFormPdf());

    app.launch(ctx);
    await settle();

    // The panel lists the document's own fields, with the values the file carries.
    expect(content.textContent ?? '').toContain('حقول قابلة للتعبئة: 2');
    const nameInput = content.querySelector('#faisal-pdf-form-0') as HTMLInputElement;
    const checkInput = content.querySelector('#faisal-pdf-form-1') as HTMLInputElement;
    expect(nameInput).not.toBeNull();
    expect(checkInput.type).toBe('checkbox');
    nameInput.value = 'Faisal';
    checkInput.checked = true;

    button('كتابة القيم في الملف').click();
    await settle();
    expect(content.querySelector('.faisal-pdf-status')?.textContent).toContain('كُتبت 2 قيمة في النموذج');

    button('حفظ كنسخة جديدة').click();
    await settle();
    const saved = files.get('/home/user/form-copy.pdf');
    expect(saved).toBeTruthy();
    const form = (await PDFDocument.load(saved as Uint8Array, { updateMetadata: false })).getForm();
    expect(form.getTextField('owner.name').getText()).toBe('Faisal');
    expect(form.getCheckBox('agree').isChecked()).toBe(true);
  });

  it('inserts a blank page and duplicates the selection through the window', async () => {
    const pdf = await makePdf([{ w: 200, h: 300 }, { w: 210, h: 310 }]);
    const { ctx, content, button } = makeApp('/home/user/pages.pdf', pdf);

    app.launch(ctx);
    await settle();
    expect(content.querySelectorAll('.faisal-pdf-pagerow')).toHaveLength(2);

    (content.querySelector('#faisal-pdf-blank-at') as HTMLInputElement).value = '2';
    button('إدراج صفحة فارغة').click();
    await settle();
    expect(content.querySelectorAll('.faisal-pdf-pagerow')).toHaveLength(3);
    expect(content.querySelector('.faisal-pdf-status')?.textContent).toContain('أُدرجت صفحة فارغة');

    button('تحديد الكل').click();
    await settle();
    button('تكرار الصفحات المحددة').click();
    await settle();
    expect(content.querySelectorAll('.faisal-pdf-pagerow')).toHaveLength(6);
    expect(content.querySelector('.faisal-pdf-status')?.textContent).toContain('كُرّرت 3 صفحة');
  });

  it('adds a typed signature through the window and the saved copy carries it', async () => {
    const pdf = await makePdf([{ w: 200, h: 300 }]);
    const { ctx, content, files, button } = makeApp('/home/user/sign.pdf', pdf);

    app.launch(ctx);
    await settle();

    (content.querySelector('#faisal-pdf-sign-value') as HTMLInputElement).value = 'F. Al Shahrani';
    button('إضافة التوقيع بالكتابة').click();
    await settle();
    expect(content.querySelector('.faisal-pdf-status')?.textContent)
      .toContain('أُضيف التوقيع بالكتابة إلى الصفحة 1');

    button('حفظ كنسخة جديدة').click();
    await settle();
    const saved = files.get('/home/user/sign-copy.pdf');
    expect(saved).toBeTruthy();
    const out = await PDFDocument.load(saved as Uint8Array, { updateMetadata: false });
    expect(out.getPageCount()).toBe(1);
    const stream = contentOf(out, 0);
    expect(stream).toContain('Tj');
    expect(stream.toLowerCase()).toContain(hexOf('F. Al Shahrani'));
  });

  it('opens the print dialog through an off-screen frame, never window.print() on the system page', async () => {
    const pdf = await makePdf([{ w: 200, h: 300 }]);
    const { ctx, content, button } = makeApp('/home/user/print.pdf', pdf);
    // window.print() on the system page would print the whole desktop, so it must not be used.
    const systemPrint = vi.fn();
    Object.defineProperty(window, 'print', { value: systemPrint, configurable: true, writable: true });

    app.launch(ctx);
    await settle();

    button('طباعة').click();
    await settle();

    const frame = content.querySelector('iframe.faisal-pdf-printframe') as HTMLIFrameElement;
    expect(frame).not.toBeNull();
    expect(frame.getAttribute('src')).toContain('blob:');
    // jsdom never loads the blob URL, so the frame's own load (as a browser fires it) is sent.
    const frameWindow = frame.contentWindow as Window & { print: () => void; focus: () => void };
    const framePrint = vi.fn();
    frameWindow.print = framePrint;
    frameWindow.focus = vi.fn();
    frame.dispatchEvent(new Event('load'));

    expect(framePrint).toHaveBeenCalledTimes(1);
    expect(systemPrint).not.toHaveBeenCalled();
    expect(content.querySelector('.faisal-pdf-status')?.textContent).toContain('فُتحت نافذة طباعة هذا الملف');

    // Once the dialog reports that it closed, the frame is taken out of the window again.
    frameWindow.dispatchEvent(new Event('afterprint'));
    expect(content.querySelector('iframe.faisal-pdf-printframe')).toBeNull();
  });

  it('removes the print frame and revokes its blob URL with the 60s fallback, even with no afterprint', async () => {
    const pdf = await makePdf([{ w: 200, h: 300 }]);
    const { ctx, content, button } = makeApp('/home/user/print-fallback.pdf', pdf);

    app.launch(ctx);
    await settle();

    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    vi.useFakeTimers();
    try {
      button('طباعة').click();
      const frame = content.querySelector('iframe.faisal-pdf-printframe') as HTMLIFrameElement;
      expect(frame).not.toBeNull();
      const frameWindow = frame.contentWindow as Window & { print: () => void; focus: () => void };
      frameWindow.print = vi.fn();
      frameWindow.focus = vi.fn();
      frame.dispatchEvent(new Event('load'));

      // Some environments never fire afterprint: the frame must still go away by itself.
      expect(content.querySelector('iframe.faisal-pdf-printframe')).not.toBeNull();
      vi.advanceTimersByTime(60001);
      expect(content.querySelector('iframe.faisal-pdf-printframe')).toBeNull();
      expect(revoke).toHaveBeenCalledWith('blob:pdf-test');
    } finally {
      vi.useRealTimers();
      revoke.mockRestore();
    }
  });

  it('wraps every choice control in a 44px label row', async () => {
    const pdf = await makePdf([{ w: 200, h: 300 }]);
    const { ctx, content } = makeApp('/home/user/choices.pdf', pdf);

    app.launch(ctx);
    await settle();

    // Cover shape (rect/ellipse) + the three image page sizes: all five are wrapped, so none of
    // them is a bare small control the way the image radios used to be.
    const wrapped = content.querySelectorAll('label.faisal-pdf-check input[type="radio"]');
    expect(wrapped).toHaveLength(5);
    for (const input of Array.from(wrapped)) {
      expect(input.closest('label')?.classList.contains('faisal-pdf-check')).toBe(true);
    }

    // Every colour swatch carries the text-field class, so the 44px min-height that
    // `pdf-css.test.ts` pins for `.faisal-pdf-input` really applies to it.
    const colours = content.querySelectorAll('input.faisal-pdf-color');
    expect(colours.length).toBeGreaterThanOrEqual(3);
    for (const input of Array.from(colours)) expect(input.classList.contains('faisal-pdf-input')).toBe(true);
  });

  it('applies the watermark to every page when nothing is selected', async () => {
    const pdf = await makePdf([{ w: 200, h: 300 }, { w: 210, h: 310 }]);
    const { ctx, content, button } = makeApp('/home/user/mark-all.pdf', pdf);

    app.launch(ctx);
    await settle();

    (content.querySelector('#faisal-pdf-mark-text') as HTMLInputElement).value = 'COPY';
    button('إضافة العلامة المائية').click();
    await settle();

    const status = content.querySelector('.faisal-pdf-status')?.textContent ?? '';
    expect(status).toContain('أُضيفت العلامة المائية إلى 2 صفحة');
    expect(status).toContain('تُحقّق من الناتج');
  });

  it('covers a region through the window and says plainly that it is hiding, not redaction', async () => {
    const pdf = await makePdf([{ w: 300, h: 300 }]);
    const { ctx, content, files, button } = makeApp('/home/user/cover.pdf', pdf);

    app.launch(ctx);
    await settle();

    button('تغطية المنطقة').click();
    await settle();
    expect(content.querySelector('.faisal-pdf-status')?.textContent).toContain('غُطّيت منطقة في الصفحة 1');
    expect(content.textContent ?? '').toContain('ليست حجباً');

    button('حفظ كنسخة جديدة').click();
    await settle();
    const saved = files.get('/home/user/cover-copy.pdf');
    expect(saved).toBeTruthy();
    expect(contentOf(await PDFDocument.load(saved as Uint8Array, { updateMetadata: false }), 0)).toContain('re');
  });
});
