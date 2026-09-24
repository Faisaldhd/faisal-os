/**
 * Office — the contract between the window (index.ts) and an editor (Writer,
 * the sheet, the deck, plain text). The window owns the file, the history and
 * the save; an editor owns its view and its ribbon tabs, and changes the model
 * only by handing an `Edit` to `commit`.
 */
import type { Edit, OfficeModel } from './model';
import type { RibbonTab } from './ui/ribbon';

export interface EditorContext {
  model(): OfficeModel | null;
  commit(edit: Edit): void;
  undo(): void;
  redo(): void;
  editable(): boolean;
  /** Re-reads the ribbon and the status bar (after a selection change, say). */
  refresh(): void;
  setStatus(text: string): void;
  /** The element overlays and modals are placed in. */
  host(): HTMLElement;
  filePath(): string | null;
  /** The ribbon's File tab: shared by every editor. */
  fileTab(): RibbonTab;
  /** Writes an exported copy next to the file (a new name, never an overwrite) and offers a download. */
  exportFile(data: Uint8Array | string, ext: string, mime: string): Promise<void>;
  /** Prints only `content` (a detached copy of the pages), never the desktop. */
  print(content: HTMLElement, pageCss: string): void;
}

export interface StatusInfo {
  /** Context shown at the inline-start of the status bar ("Page 2 of 5", "B4"). */
  parts: string[];
  zoom?: { value: number; set(value: number): void };
}

export interface Editor {
  readonly element: HTMLElement;
  tabs(): RibbonTab[];
  /** Redraws from the model (after load, undo, redo). */
  render(): void;
  status(): StatusInfo;
  /** Keyboard shortcuts the editor handles itself; return true when handled. */
  onKey?(ev: KeyboardEvent): boolean;
  dispose(): void;
}
