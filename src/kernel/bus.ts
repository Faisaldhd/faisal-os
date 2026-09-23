import type { EventBus, SystemEvents, Unsubscribe } from './types';

export function createBus(): EventBus {
  const handlers = new Map<keyof SystemEvents, Set<(p: any) => void>>();
  return {
    on(type, handler): Unsubscribe {
      let set = handlers.get(type);
      if (!set) handlers.set(type, (set = new Set()));
      set.add(handler);
      return () => set!.delete(handler);
    },
    emit(type, payload) {
      handlers.get(type)?.forEach((h) => {
        try { h(payload); } catch (err) { console.error(`[bus] handler for ${String(type)} failed`, err); }
      });
    },
  };
}
