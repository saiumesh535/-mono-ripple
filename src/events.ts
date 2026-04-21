export type WatchEvent =
  | { type: "startup"; ts: number; watchRoots: string[]; deps: string[] }
  | { type: "burst"; ts: number; paths: string[]; packages: string[] }
  | { type: "build:start"; ts: number; pkg: string; command: string }
  | { type: "build:cache-hit"; ts: number; pkg: string }
  | { type: "build:end"; ts: number; pkg: string; ms: number }
  | { type: "build:fail"; ts: number; pkg: string; ms: number; error: string }
  | { type: "before:start"; ts: number; command: string }
  | { type: "before:end"; ts: number; ms: number }
  | { type: "before:fail"; ts: number; ms: number; error: string }
  | { type: "restart:start"; ts: number; reason: string }
  | { type: "restart:end"; ts: number; ms: number }
  | { type: "child:start"; ts: number }
  | { type: "child:crash"; ts: number; code: number | null; signal: NodeJS.Signals | null }
  | { type: "shutdown"; ts: number };

export type WatchEventType = WatchEvent["type"];

export type EventBus = {
  emit: (e: WatchEvent) => void;
  on: (type: WatchEventType | "*", handler: (e: WatchEvent) => void) => () => void;
};

export function createEventBus(): EventBus {
  const subs = new Map<string, Set<(e: WatchEvent) => void>>();
  return {
    emit(e) {
      const byType = subs.get(e.type);
      if (byType) for (const h of byType) safeCall(h, e);
      const all = subs.get("*");
      if (all) for (const h of all) safeCall(h, e);
    },
    on(type, handler) {
      let set = subs.get(type);
      if (!set) {
        set = new Set();
        subs.set(type, set);
      }
      set.add(handler);
      return () => set!.delete(handler);
    },
  };
}

function safeCall(h: (e: WatchEvent) => void, e: WatchEvent): void {
  try {
    h(e);
  } catch {
    /* subscriber errors are never propagated */
  }
}
