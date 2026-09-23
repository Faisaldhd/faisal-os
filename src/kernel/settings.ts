import type { EventBus, Settings } from './types';

const KEY = 'faisal.settings.v1';
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const VALID_KEY = /^[a-z][a-z0-9._-]{0,63}$/i;

/** Simple settings in localStorage (tolerates failure in private mode). Prototype-pollution safe. */
export function createSettings(bus: EventBus): Settings {
  const data: Record<string, unknown> = Object.create(null);
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) if (VALID_KEY.test(k) && !FORBIDDEN.has(k)) data[k] = v;
    }
  } catch { /* corrupt or unavailable: start clean */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* ignore */ } };
  return {
    get<T>(key: string, fallback: T): T {
      return Object.hasOwn(data, key) ? (data[key] as T) : fallback;
    },
    set(key, value) {
      if (!VALID_KEY.test(key) || FORBIDDEN.has(key)) throw new Error(`Invalid settings key: ${key}`);
      data[key] = value;
      save();
      bus.emit('settings:change', { key, value });
    },
  };
}
