import * as path from "node:path";
import chokidar from "chokidar";
import type { Logger } from "./logger";
import {
  createChangeAccumulator,
  type ChangeAccumulator,
  type ChangeBurst,
} from "./change-accumulator";

const IGNORE_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".next",
  ".turbo",
  "coverage",
  ".cache",
]);

function segmentIgnores(filePath: string): boolean {
  const segments = filePath.split(path.sep);
  for (const segment of segments) {
    if (IGNORE_DIR_NAMES.has(segment)) return true;
  }
  return false;
}

export type ExtraIgnore = (absPath: string) => boolean;

export type WatchOptions = {
  roots: string[];
  debounceMs: number;
  verbose: boolean;
  onBurst: (burst: ChangeBurst) => void;
  logger: Pick<Logger, "debug" | "warn" | "error">;
  /** Additional ignore predicate. Return true to drop the event. */
  extraIgnore?: ExtraIgnore;
};

export type WatchHandle = {
  close: () => Promise<void>;
  pause: () => void;
  resume: () => void;
  isPaused: () => boolean;
  flush: () => void;
  /**
   * After a successful build inside the given absolute directory, ignore
   * any change events inside it for `windowMs` ms. Prevents post-build
   * write → restart loops.
   */
  cooldown: (absDir: string, windowMs: number) => void;
};

export function createWatcher(options: WatchOptions): WatchHandle {
  const { roots, debounceMs, verbose, onBurst, logger, extraIgnore } = options;

  const accumulator: ChangeAccumulator = createChangeAccumulator({
    debounceMs,
    onBurst,
  });

  // absDir (normalized) -> expiresAt ms
  const cooldowns = new Map<string, number>();
  const isInCooldown = (absPath: string): string | null => {
    const now = Date.now();
    for (const [dir, expiresAt] of cooldowns) {
      if (expiresAt < now) {
        cooldowns.delete(dir);
        continue;
      }
      if (absPath === dir || absPath.startsWith(dir + path.sep)) return dir;
    }
    return null;
  };

  const watcher = chokidar.watch(roots, {
    ignoreInitial: true,
    ignored: (p) => segmentIgnores(p),
    awaitWriteFinish: {
      stabilityThreshold: 50,
      pollInterval: 50,
    },
  });

  const handler = (event: string, absPath: string) => {
    if (extraIgnore?.(absPath)) {
      if (verbose) logger.debug(`watcher ${event} ignored (gitignore) ${absPath}`);
      return;
    }
    const cool = isInCooldown(absPath);
    if (cool) {
      if (verbose) logger.debug(`watcher ${event} skipped (post-build cooldown on ${cool}) ${absPath}`);
      return;
    }
    if (verbose) logger.debug(`watcher ${event} ${absPath}`);
    accumulator.push(absPath);
  };

  watcher.on("add", (p) => handler("add", p));
  watcher.on("change", (p) => handler("change", p));
  watcher.on("unlink", (p) => handler("unlink", p));
  watcher.on("error", (err) => {
    logger.error(`watcher error: ${String(err)}`);
  });

  return {
    async close() {
      accumulator.close();
      await watcher.close();
    },
    pause() {
      accumulator.setPaused(true);
    },
    resume() {
      accumulator.setPaused(false);
    },
    isPaused() {
      return accumulator.paused();
    },
    flush() {
      accumulator.flush();
    },
    cooldown(absDir, windowMs) {
      const key = path.normalize(absDir);
      const expiresAt = Date.now() + Math.max(50, windowMs);
      cooldowns.set(key, expiresAt);
    },
  };
}
