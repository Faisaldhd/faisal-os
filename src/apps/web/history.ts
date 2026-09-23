/**
 * Pure back/forward stack for a Web App window.
 *
 * An embedded site lives in a cross-origin iframe, so `contentWindow.history`
 * is unreadable (and the sandbox denies it anyway). The window therefore keeps
 * its OWN list of visited URLs, exactly like the Browser app keeps one per tab.
 * No DOM here, so the whole thing is unit-tested (see index.test.ts).
 */

export interface HistoryState {
  /** Visited URLs, oldest first. */
  entries: string[];
  /** Index of the current entry; always a valid index into `entries`. */
  index: number;
}

export function createHistory(initial: string): HistoryState {
  return { entries: [initial], index: 0 };
}

/**
 * Records a navigation. Navigating from a rewound position drops the entries
 * ahead of it (the standard browser rule), so back/forward never re-surfaces a
 * URL the user has already moved away from.
 */
export function pushUrl(state: HistoryState, url: string): HistoryState {
  const entries = [...state.entries.slice(0, state.index + 1), url];
  return { entries, index: entries.length - 1 };
}

/** Re-navigating to the URL already showing is not a new entry. */
export function pushUrlUnlessSame(state: HistoryState, url: string): HistoryState {
  return currentUrl(state) === url ? state : pushUrl(state, url);
}

/** Replaces the current entry instead of adding one (used after a redirect/rewrite). */
export function replaceUrl(state: HistoryState, url: string): HistoryState {
  const entries = [...state.entries];
  entries[state.index] = url;
  return { entries, index: state.index };
}

export function currentUrl(state: HistoryState): string | undefined {
  return state.entries[state.index];
}

export function canGoBack(state: HistoryState): boolean {
  return state.index > 0;
}

export function canGoForward(state: HistoryState): boolean {
  return state.index < state.entries.length - 1;
}

/** Moves one entry back; a no-op at the start of the stack. */
export function goBack(state: HistoryState): HistoryState {
  return canGoBack(state) ? { entries: state.entries, index: state.index - 1 } : state;
}

/** Moves one entry forward; a no-op at the end of the stack. */
export function goForward(state: HistoryState): HistoryState {
  return canGoForward(state) ? { entries: state.entries, index: state.index + 1 } : state;
}
