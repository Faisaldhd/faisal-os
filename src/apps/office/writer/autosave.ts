/**
 * Writer — autosave (الحفظ التلقائي), the pure part.
 *
 * Autosave must not weaken the rule the whole app is built on: an explicit save writes the
 * document and keeps exactly ONE `.bak`, a failed or cancelled save writes nothing, and the file
 * is read back before "Saved" is shown. So an autosave NEVER touches the document and never
 * rotates the backup. It writes a separate RECOVERY COPY beside it, and the next time the document
 * is opened the owner is asked whether to take that copy — never silently.
 *
 * Everything here is numbers and strings, so the decisions ("is it time to write?", "which copy is
 * newer than the file?") are testable without a browser or a file system.
 */

/** Settings key in `localStorage`. */
export const AUTOSAVE_KEY = 'faisal.office.autosave';

/** The intervals the settings offer, in seconds. */
export const AUTOSAVE_INTERVALS = [15, 30, 60, 120] as const;

/** On, every 30 seconds after the last change. */
export const DEFAULT_AUTOSAVE: AutosavePrefs = { on: true, seconds: 30 };

/** How often the timer wakes up to ask `shouldAutosave`. Cheap: it writes only when due. */
export const AUTOSAVE_TICK_MS = 5000;

export interface AutosavePrefs {
  on: boolean;
  seconds: number;
}

/**
 * Settings from storage. Anything unreadable falls back to the default rather than throwing: a
 * broken preference must never stop the editor from opening.
 */
export function parseAutosavePrefs(raw: string | null | undefined): AutosavePrefs {
  if (!raw) return { ...DEFAULT_AUTOSAVE };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_AUTOSAVE };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_AUTOSAVE };
  const src = parsed as { on?: unknown; seconds?: unknown };
  const seconds = src.seconds === undefined ? DEFAULT_AUTOSAVE.seconds : clampInterval(Number(src.seconds));
  const on = typeof src.on === 'boolean' ? src.on : DEFAULT_AUTOSAVE.on;
  return { on, seconds };
}

export function serializeAutosavePrefs(prefs: AutosavePrefs): string {
  return JSON.stringify({ on: prefs.on, seconds: clampInterval(prefs.seconds) });
}

/** The nearest offered interval, so a hand-edited value cannot produce a 1-second writer. */
export function clampInterval(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_AUTOSAVE.seconds;
  if (AUTOSAVE_INTERVALS.includes(seconds as (typeof AUTOSAVE_INTERVALS)[number])) return seconds;
  let best = AUTOSAVE_INTERVALS[0] as number;
  for (const option of AUTOSAVE_INTERVALS) if (Math.abs(option - seconds) < Math.abs(best - seconds)) best = option;
  return best;
}

/**
 * Where the recovery copy of a document lives: beside it, with the document's own name plus
 * `.autosave`. `/home/user/Documents/notes.docx` → `/home/user/Documents/notes.docx.autosave`.
 *
 * The copy is deliberately NOT a `.docx` of its own name: it must never be mistaken for a
 * document, so it keeps the recovered bytes of exactly one file and nothing else.
 */
export function recoveryPathFor(docPath: string): string {
  return `${docPath}.autosave`;
}

/** The document a recovery copy belongs to, or null when the name is not a recovery copy. */
export function documentOfRecovery(recoveryPath: string): string | null {
  return recoveryPath.endsWith('.autosave') ? recoveryPath.slice(0, -'.autosave'.length) : null;
}

/** What the timer knows when it asks whether it is time to write. */
export interface AutosaveFacts {
  /** Autosave is switched on in the settings. */
  on: boolean;
  /** Seconds of quiet required after the last change. */
  seconds: number;
  /** The document differs from what is on disk. */
  dirty: boolean;
  /** An explicit save (or another write) is in flight: never write over it. */
  saving: boolean;
  /** A counter that grows with every change the owner makes. */
  editSeq: number;
  /** The `editSeq` the recovery copy was last written for. */
  writtenSeq: number;
  /** Milliseconds since the last change. */
  sinceEditMs: number;
}

/**
 * Whether the timer should write a recovery copy now.
 *
 * The `editSeq > writtenSeq` test is what keeps a long-idle document from being rewritten every
 * interval: after a copy is written the document stays dirty (only an explicit save cleans it),
 * so without it the timer would write the same bytes forever.
 */
export function shouldAutosave(facts: AutosaveFacts): boolean {
  if (!facts.on || !facts.dirty || facts.saving) return false;
  if (facts.editSeq <= facts.writtenSeq) return false;
  const quiet = clampInterval(facts.seconds) * 1000;
  return facts.sinceEditMs >= quiet;
}

/** A file as the timer sees it: a path and a modification time. */
export interface RecoveryEntry {
  path: string;
  mtime: number;
}

/**
 * The recovery copy worth offering for `docPath`: the one this document owns and only when it is
 * NEWER than the document itself. An older copy is a leftover — the file was saved after it — and
 * offering it would invite the owner to lose work.
 */
export function newestRecovery(
  entries: readonly RecoveryEntry[],
  docPath: string,
  docMtime: number,
): RecoveryEntry | null {
  const wanted = recoveryPathFor(docPath);
  let best: RecoveryEntry | null = null;
  for (const entry of entries) {
    if (entry.path !== wanted) continue;
    if (!(entry.mtime > docMtime)) continue;
    if (!best || entry.mtime > best.mtime) best = entry;
  }
  return best;
}

/** `HH:MM` in the reader's own clock, for the status line ("saved automatically 12:30"). */
export function formatClock(at: Date): string {
  const h = String(at.getHours()).padStart(2, '0');
  const m = String(at.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}
