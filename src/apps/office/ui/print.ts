/**
 * Office — printing only the document (الطباعة).
 *
 * A hidden same-origin iframe receives a *copy* of the pages (cloned nodes, never
 * markup strings) plus a print stylesheet, and prints itself. The desktop, the
 * ribbon and every other window stay out of the printout; "Save as PDF" in the
 * browser's print dialog is the PDF export.
 */
export function printNodes(content: HTMLElement, css: string, title: string): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = 'position:fixed;inset-inline-start:-10000px;top:0;width:10px;height:10px;border:0;opacity:0';
  document.body.append(frame);
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) { frame.remove(); return; }
  doc.open();
  doc.close();
  doc.title = title;
  const style = doc.createElement('style');
  style.textContent = css;
  doc.head.append(style);
  doc.body.append(doc.importNode(content, true));
  const cleanup = (): void => { setTimeout(() => frame.remove(), 1000); };
  win.addEventListener('afterprint', cleanup, { once: true });
  setTimeout(() => {
    try { win.focus(); win.print(); } catch { /* printing unavailable: nothing to clean but the frame */ }
    setTimeout(cleanup, 60000);
  }, 150);
}
