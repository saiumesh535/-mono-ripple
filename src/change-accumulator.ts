export type ChangeBurst = {
  /** Unique absolute paths that changed during the quiet window. */
  paths: string[];
  /** First path observed in the burst (for back-compat / logging). */
  first: string;
};

export type ChangeAccumulator = {
  push: (absPath: string) => void;
  flush: () => void;
  paused: () => boolean;
  setPaused: (paused: boolean) => void;
  close: () => void;
};

/**
 * Collect file-change events during a quiet window, emit a single burst
 * once no new events have arrived for `debounceMs`.
 */
export function createChangeAccumulator(options: {
  debounceMs: number;
  onBurst: (burst: ChangeBurst) => void;
}): ChangeAccumulator {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const buffer = new Set<string>();
  let first: string | null = null;
  let paused = false;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (buffer.size === 0 || first === null) return;
    const paths = [...buffer];
    const f = first;
    buffer.clear();
    first = null;
    options.onBurst({ paths, first: f });
  };

  return {
    push(absPath) {
      if (paused) return;
      if (first === null) first = absPath;
      buffer.add(absPath);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, options.debounceMs);
    },
    flush,
    paused: () => paused,
    setPaused(v) {
      paused = v;
      if (v && timer) {
        clearTimeout(timer);
        timer = undefined;
        buffer.clear();
        first = null;
      }
    },
    close() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      buffer.clear();
      first = null;
    },
  };
}
