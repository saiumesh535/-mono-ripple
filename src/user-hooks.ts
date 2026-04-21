import * as fs from "node:fs";
import * as path from "node:path";
import type { EventBus, WatchEvent } from "./events";
import type { Logger } from "./logger";

/**
 * User-supplied JS hooks: a `monoripple.hooks.js` (or `.cjs`) file next to the
 * config, exporting any subset of `onStartup`, `onBurst`, `onBuild`,
 * `onRestart`, `onCrash`, `onShutdown`, or a generic `onEvent(e)`.
 * Hooks are fire-and-forget; thrown/rejected errors are caught and logged.
 *
 * Security: loading is opt-in only — the CLI gates this behind
 * `--allow-hooks-js` because any .js module can run arbitrary code on load.
 */

export type HookModule = Partial<{
  onStartup: (e: Extract<WatchEvent, { type: "startup" }>) => void | Promise<void>;
  onBurst: (e: Extract<WatchEvent, { type: "burst" }>) => void | Promise<void>;
  onBuild: (e: Extract<WatchEvent, { type: "build:start" | "build:end" | "build:fail" | "build:cache-hit" }>) => void | Promise<void>;
  onRestart: (e: Extract<WatchEvent, { type: "restart:start" | "restart:end" }>) => void | Promise<void>;
  onCrash: (e: Extract<WatchEvent, { type: "child:crash" }>) => void | Promise<void>;
  onShutdown: (e: Extract<WatchEvent, { type: "shutdown" }>) => void | Promise<void>;
  onEvent: (e: WatchEvent) => void | Promise<void>;
}>;

const CANDIDATES = [
  "monoripple.hooks.js",
  "monoripple.hooks.cjs",
  "dep-watch.hooks.js",
  "dep-watch.hooks.cjs",
] as const;

export function findHooksFile(configPath: string): string | null {
  const dir = path.dirname(path.resolve(configPath));
  for (const name of CANDIDATES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function loadHooks(file: string): HookModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(path.resolve(file)) as { default?: HookModule } | HookModule;
  const data =
    mod && typeof mod === "object" && "default" in mod && mod.default
      ? mod.default
      : (mod as HookModule);
  if (!data || typeof data !== "object") {
    throw new Error(`[monoripple] ${file}: expected object export`);
  }
  return data;
}

export function attachHooks(
  bus: EventBus,
  hooks: HookModule,
  logger: Pick<Logger, "warn">,
): void {
  const wrap = (name: string, fn: ((e: WatchEvent) => unknown) | undefined) => {
    if (!fn) return;
    return (e: WatchEvent) => {
      try {
        const r = fn(e);
        if (r && typeof (r as Promise<unknown>).then === "function") {
          (r as Promise<unknown>).catch((err: unknown) => {
            logger.warn(`user hook ${name} rejected: ${errMsg(err)}`);
          });
        }
      } catch (err) {
        logger.warn(`user hook ${name} threw: ${errMsg(err)}`);
      }
    };
  };

  const startup = wrap("onStartup", hooks.onStartup as ((e: WatchEvent) => unknown) | undefined);
  const burst = wrap("onBurst", hooks.onBurst as ((e: WatchEvent) => unknown) | undefined);
  const build = wrap("onBuild", hooks.onBuild as ((e: WatchEvent) => unknown) | undefined);
  const restart = wrap("onRestart", hooks.onRestart as ((e: WatchEvent) => unknown) | undefined);
  const crash = wrap("onCrash", hooks.onCrash as ((e: WatchEvent) => unknown) | undefined);
  const shutdown = wrap("onShutdown", hooks.onShutdown as ((e: WatchEvent) => unknown) | undefined);
  const any = wrap("onEvent", hooks.onEvent as ((e: WatchEvent) => unknown) | undefined);

  if (startup) bus.on("startup", startup);
  if (burst) bus.on("burst", burst);
  if (build) {
    bus.on("build:start", build);
    bus.on("build:end", build);
    bus.on("build:fail", build);
    bus.on("build:cache-hit", build);
  }
  if (restart) {
    bus.on("restart:start", restart);
    bus.on("restart:end", restart);
  }
  if (crash) bus.on("child:crash", crash);
  if (shutdown) bus.on("shutdown", shutdown);
  if (any) bus.on("*", any);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
