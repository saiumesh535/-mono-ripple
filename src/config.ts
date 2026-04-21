import * as fs from "node:fs";
import * as path from "node:path";
import fg from "fast-glob";
import {
  DEFAULT_PACKAGE_CUSTOM_BUILD,
  type DepPackageConfig,
  type HookCommand,
  type ParsedCli,
} from "./cli-options";
import { resolveDirectWorkspaceDeps } from "./resolve-deps";
import { findWorkspaceRoot, resolveWorkspaceContext } from "./workspace";
import { validateConfig } from "./config-schema";

const PREFIX = "[monoripple]";

export type DepWatchConfigFile = {
  /**
   * App directory: relative to **workspace root**, or absolute.
   * Omit or use `"."` when the config file lives **inside** that app package (recommended).
   */
  app?: string;
  /** Command to run in the app directory. String → shell; array → direct spawn. */
  command: string | string[];
  debounce?: number;
  verbose?: boolean;
  /** Pre-restart hook (from repo root). String → shell; array → direct spawn. */
  before?: HookCommand;
  beforeDepsOnly?: boolean;
  /** Enable interactive keypress UI (requires TTY). Default: auto (on TTY, off in CI). */
  interactive?: boolean;
  /** Refuse to run unacked hooks. Default false (warn + continue). */
  strictHooks?: boolean;
  /** Graceful shutdown timeout for child (ms). Default 10000. */
  killTimeoutMs?: number;
  /** Per-package post-build cooldown (ms). Default 500. */
  cooldownMs?: number;
  /** Max parallel customBuilds at the same topo level. Default 4. */
  buildConcurrency?: number;
  /** Apply .gitignore rules to the watcher. Default true. */
  useGitignore?: boolean;
  /** Disable input-hash build cache. Default false. */
  noCache?: boolean;
  /** Per-workspace-package overrides keyed by npm `name`. */
  packages?: Record<string, DepPackageConfig>;
};

/**
 * Config file names searched, in priority order. `monoripple.*` wins; the
 * `dep-watch.*` names are kept as back-compat aliases for users migrating
 * from the older package name.
 */
const CONFIG_NAMES = [
  "monoripple.config.json",
  "monoripple.config.cjs",
  "dep-watch.config.json",
  "dep-watch.config.cjs",
] as const;

export function findDepWatchConfigPath(startDir: string): string | null {
  let dir = path.resolve(startDir);
  const { root } = path.parse(dir);
  while (true) {
    for (const name of CONFIG_NAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
}

function readJsonConfig(file: string): DepWatchConfigFile {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  return validateConfig(file, raw);
}

function readCjsConfig(file: string): DepWatchConfigFile {
  const abs = path.resolve(file);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(abs) as { default?: unknown } | unknown;
  const data =
    mod && typeof mod === "object" && "default" in mod && mod.default
      ? mod.default
      : mod;
  return validateConfig(file, data);
}

export function loadDepWatchConfigFile(
  configPath: string,
  opts: { allowCjs?: boolean } = {},
): DepWatchConfigFile {
  if (configPath.endsWith(".json")) return readJsonConfig(configPath);
  const envAllow =
    process.env.MONORIPPLE_ALLOW_CJS_CONFIG === "1" ||
    process.env.DEP_WATCH_ALLOW_CJS_CONFIG === "1";
  if (!opts.allowCjs && !envAllow) {
    throw new Error(
      `${PREFIX} refusing to load .cjs config (executes arbitrary JS): ${configPath}\n` +
        `  Pass --allow-cjs-config or set MONORIPPLE_ALLOW_CJS_CONFIG=1 to opt in,\n` +
        `  or convert to monoripple.config.json.`,
    );
  }
  return readCjsConfig(configPath);
}

export function loadDepWatchConfig(
  startDir: string,
  opts: { allowCjs?: boolean } = {},
): { path: string; config: DepWatchConfigFile } | null {
  const found = findDepWatchConfigPath(startDir);
  if (!found) return null;
  return { path: found, config: loadDepWatchConfigFile(found, opts) };
}

export function normalizeDevCommand(
  command: string | string[] | undefined,
  commandUsesShell: boolean,
): { argv: string[]; shell: boolean } {
  if (command === undefined) return { argv: [], shell: false };
  if (typeof command === "string") return { argv: [command], shell: true };
  return { argv: command, shell: commandUsesShell };
}

function defaultAppDir(repoRoot: string): string {
  const apps = fg.sync(["apps/*", "packages/*"], {
    cwd: repoRoot,
    onlyDirectories: true,
  });
  const preferred = apps.find((p) => p.startsWith("apps/"));
  const rel = (preferred ?? apps[0])?.replace(/\\/g, "/");
  return rel ?? "apps/server";
}

export function writeInitConfig(options: {
  cwd: string;
  appHint?: string;
  workspaceRoot?: boolean;
}): string {
  const start = options.appHint
    ? path.resolve(options.cwd, options.appHint)
    : options.cwd;
  const repoRoot = findWorkspaceRoot(start);
  if (!repoRoot) {
    throw new Error(
      `${PREFIX} --init could not find a workspace root (pnpm-workspace.yaml or package.json workspaces).`,
    );
  }

  const appRel = options.appHint
    ? path.relative(repoRoot, path.resolve(options.cwd, options.appHint)).replace(/\\/g, "/")
    : path.relative(repoRoot, path.join(repoRoot, defaultAppDir(repoRoot))).replace(/\\/g, "/");

  const appAbs = path.resolve(repoRoot, appRel);
  if (!fs.existsSync(path.join(appAbs, "package.json"))) {
    throw new Error(
      `${PREFIX} --init expected a package directory with package.json at ${appAbs}`,
    );
  }

  const packages: Record<string, DepPackageConfig> = {};
  const ctx = resolveWorkspaceContext(appAbs);
  for (const d of resolveDirectWorkspaceDeps(appAbs, ctx)) {
    packages[d.name] = { customBuild: DEFAULT_PACKAGE_CUSTOM_BUILD };
  }

  const config: DepWatchConfigFile & { $schema?: string } = {
    $schema: "./node_modules/@mono/ripple/monoripple.config.schema.json",
    ...(options.workspaceRoot ? { app: appRel } : {}),
    command: "npm run dev",
    debounce: 200,
    packages: Object.keys(packages).length > 0 ? packages : undefined,
  };

  const outPath = options.workspaceRoot
    ? path.join(repoRoot, "monoripple.config.json")
    : path.join(appAbs, "monoripple.config.json");
  fs.writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return outPath;
}

export function resolveAppDirFromConfig(
  cwd: string,
  file: { path: string; config: DepWatchConfigFile },
): string {
  const configDir = path.dirname(path.resolve(file.path));
  const repoRoot = findWorkspaceRoot(configDir);
  const appField = file.config.app;

  const implicit = appField === undefined || appField === "" || appField === ".";

  let appAbs: string;
  if (implicit) {
    if (repoRoot && path.resolve(configDir) === path.resolve(repoRoot)) {
      throw new Error(
        `${PREFIX} ${file.path}: config is at the workspace root — set "app" (e.g. "apps/server") or move this file into the app package and omit "app".`,
      );
    }
    appAbs = configDir;
  } else if (path.isAbsolute(appField)) {
    appAbs = path.resolve(appField);
  } else {
    if (!repoRoot) {
      throw new Error(
        `${PREFIX} ${file.path}: could not find workspace root to resolve "app": ${appField}`,
      );
    }
    appAbs = path.resolve(repoRoot, appField);
  }

  const rel = path.relative(path.resolve(cwd), appAbs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return appAbs;
  return rel === "" ? "." : rel;
}

export type FlagParse = {
  positional: string[];
  debounceMs?: number;
  verbose?: boolean;
  before?: string;
  beforeDepsOnly?: boolean | undefined;
  interactive?: boolean;
  json?: boolean;
  statusLine?: boolean;
  allowHooks?: boolean;
  strictHooks?: boolean;
  killTimeoutMs?: number;
  dryRun?: boolean;
  explain?: boolean;
  noCache?: boolean;
  cooldownMs?: number;
  buildConcurrency?: number;
  allowCjsConfig?: boolean;
  allowHooksJs?: boolean;
  useGitignore?: boolean;
};

function inCi(): boolean {
  const v = process.env.CI;
  return Boolean(v) && v !== "false" && v !== "0";
}

export function parseHeadFlags(head: string[]): FlagParse {
  const out: FlagParse = { positional: [] };

  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if (a === "--debounce" || a === "-d") {
      const n = head[++i];
      if (n === undefined) throw new Error(`${PREFIX} --debounce requires a number (milliseconds).`);
      const ms = Number(n);
      if (!Number.isFinite(ms) || ms < 0) throw new Error(`${PREFIX} Invalid --debounce value: ${n}`);
      out.debounceMs = Math.floor(ms);
    } else if (a === "--before") {
      const cmd = head[++i];
      if (cmd === undefined) throw new Error(`${PREFIX} --before requires a shell command (quote if spaced).`);
      out.before = cmd;
    } else if (a === "--before-deps-only") {
      out.beforeDepsOnly = true;
    } else if (a === "--verbose" || a === "-v") {
      out.verbose = true;
    } else if (a === "--interactive" || a === "-i") {
      out.interactive = true;
    } else if (a === "--no-interactive") {
      out.interactive = false;
    } else if (a === "--json") {
      out.json = true;
    } else if (a === "--no-status") {
      out.statusLine = false;
    } else if (a === "--status") {
      out.statusLine = true;
    } else if (a === "--allow-hooks") {
      out.allowHooks = true;
    } else if (a === "--strict-hooks") {
      out.strictHooks = true;
    } else if (a === "--kill-timeout") {
      const n = head[++i];
      if (n === undefined) throw new Error(`${PREFIX} --kill-timeout requires milliseconds.`);
      const ms = Number(n);
      if (!Number.isFinite(ms) || ms < 100) throw new Error(`${PREFIX} Invalid --kill-timeout value: ${n}`);
      out.killTimeoutMs = Math.floor(ms);
    } else if (a === "--dry-run") {
      out.dryRun = true;
    } else if (a === "--explain") {
      out.explain = true;
    } else if (a === "--no-cache") {
      out.noCache = true;
    } else if (a === "--cooldown") {
      const n = head[++i];
      if (n === undefined) throw new Error(`${PREFIX} --cooldown requires milliseconds.`);
      const ms = Number(n);
      if (!Number.isFinite(ms) || ms < 0) throw new Error(`${PREFIX} Invalid --cooldown value: ${n}`);
      out.cooldownMs = Math.floor(ms);
    } else if (a === "--build-concurrency") {
      const n = head[++i];
      if (n === undefined) throw new Error(`${PREFIX} --build-concurrency requires an integer.`);
      const c = Number(n);
      if (!Number.isFinite(c) || c < 1) throw new Error(`${PREFIX} Invalid --build-concurrency: ${n}`);
      out.buildConcurrency = Math.floor(c);
    } else if (a === "--allow-cjs-config") {
      out.allowCjsConfig = true;
    } else if (a === "--allow-hooks-js") {
      out.allowHooksJs = true;
    } else if (a === "--no-gitignore") {
      out.useGitignore = false;
    } else if (a === "--gitignore") {
      out.useGitignore = true;
    } else if (a.startsWith("-")) {
      throw new Error(`${PREFIX} Unknown flag: ${a}`);
    } else {
      out.positional.push(a);
    }
  }

  return out;
}

export function resolveInvocation(
  argv: string[],
  file: { path: string; config: DepWatchConfigFile } | null,
): ParsedCli {
  const sep = argv.indexOf("--");
  let head: string[];
  let tail: string[];
  let tailFromConfig = false;

  if (sep === -1) {
    head = argv;
    if (file?.config.command !== undefined && file.config.command !== null) {
      tail = [];
      tailFromConfig = true;
    } else {
      throw new Error(
        `${PREFIX} Missing command. Use "-- <command>", or add "command" to monoripple.config.json (run \`monoripple init\`).\n`,
      );
    }
  } else {
    head = argv.slice(0, sep);
    tail = argv.slice(sep + 1);
    if (
      tail.length === 0 &&
      file?.config.command !== undefined &&
      file.config.command !== null
    ) {
      tailFromConfig = true;
      tail = [];
    } else if (tail.length === 0) {
      throw new Error(`${PREFIX} Provide a command after "--", or set "command" in monoripple.config.json.`);
    }
  }

  const flags = parseHeadFlags(head);

  const mergedBefore: HookCommand | undefined = flags.before ?? file?.config.before;
  const mergedBeforeDepsOnly =
    flags.beforeDepsOnly ?? file?.config.beforeDepsOnly ?? false;
  if (mergedBeforeDepsOnly && !mergedBefore) {
    throw new Error(`${PREFIX} before-deps-only requires --before or config "before".`);
  }

  let appDir: string;
  if (flags.positional[0] !== undefined) {
    appDir = flags.positional[0];
  } else if (file) {
    appDir = resolveAppDirFromConfig(process.cwd(), file);
  } else {
    throw new Error(
      `${PREFIX} Missing <appDir>. Pass it on the command line, use a monoripple.config.json (next to the app or with "app" set), or run from a directory under that app.`,
    );
  }

  if (flags.positional.length > 1) {
    throw new Error(
      `${PREFIX} Expected at most one app directory; got: ${flags.positional.join(" ")}`,
    );
  }

  let commandSource: string | string[];
  let commandShell: boolean;

  if (tailFromConfig) {
    commandSource = file!.config.command;
    commandShell = typeof commandSource === "string";
  } else {
    commandSource = tail;
    commandShell = false;
  }

  const { argv: command, shell: normalizedShell } = normalizeDevCommand(
    commandSource,
    commandShell,
  );
  if (command.length === 0) throw new Error(`${PREFIX} Command is empty.`);

  const c = file?.config;
  const debounceMs = flags.debounceMs ?? c?.debounce ?? 200;
  const verbose = flags.verbose ?? c?.verbose ?? false;
  const before = mergedBefore;
  const beforeDepsOnly = mergedBeforeDepsOnly;
  const killTimeoutMs = flags.killTimeoutMs ?? c?.killTimeoutMs ?? 10_000;

  const ttyIn = Boolean(process.stdin.isTTY);
  const interactiveDefault = ttyIn && !inCi();
  const interactive =
    flags.interactive ?? c?.interactive ?? interactiveDefault;
  const json = flags.json ?? false;
  const statusDefault = Boolean(process.stderr.isTTY) && !json && !inCi();
  const statusLine = flags.statusLine ?? statusDefault;
  const allowHooks = flags.allowHooks ?? false;
  const strictHooks = flags.strictHooks ?? false;
  const dryRun = flags.dryRun ?? false;
  const explain = flags.explain ?? false;
  const noCache = flags.noCache ?? false;
  const cooldownMs = flags.cooldownMs ?? 500;
  const buildConcurrency = flags.buildConcurrency ?? 4;
  const allowCjsConfig = flags.allowCjsConfig ?? false;
  const allowHooksJs = flags.allowHooksJs ?? false;
  const useGitignore = flags.useGitignore ?? true;

  if (sep === -1 && !file) {
    throw new Error(`${PREFIX} Internal: no file and no -- separator`);
  }

  return {
    appDir,
    command,
    commandShell: normalizedShell,
    debounceMs,
    verbose,
    before,
    beforeDepsOnly,
    configPath: file?.path ?? null,
    packageOverrides: c?.packages,
    interactive,
    json,
    statusLine,
    allowHooks,
    strictHooks,
    killTimeoutMs,
    dryRun,
    explain,
    noCache,
    cooldownMs,
    buildConcurrency,
    allowCjsConfig,
    allowHooksJs,
    useGitignore,
  };
}

export function parseArgs(argv: string[]): ParsedCli {
  return resolveInvocation(argv, null);
}

export function usageText(): string {
  return [
    `${PREFIX} Usage:`,
    `  monoripple [appDir] [options] [-- <command...>]`,
    `  monoripple init [appDir]   (or: --init)`,
    `  monoripple doctor [appDir] (diagnose the current setup)`,
    ``,
    `With monoripple.config.json beside your app (or at repo root with "app" set) you can omit "--" and use config "command".`,
    `(\`dep-watch.config.json\` is still read for backwards compatibility.)`,
    ``,
    `Options:`,
    `  --init [appDir] [--workspace-root]   Write monoripple.config.json`,
    `  --debounce <ms>, -d <ms>             Debounce delay (default 200)`,
    `  --verbose, -v`,
    `  --before "<shell cmd>"`,
    `  --before-deps-only`,
    `  --interactive, -i / --no-interactive Interactive keypress UI (auto on TTY, off in CI)`,
    `  --json                               NDJSON logs (disables status line)`,
    `  --status / --no-status               Persistent TTY status line`,
    `  --allow-hooks                        Remember trust for this config's hooks (silences warnings)`,
    `  --strict-hooks                       Refuse to run hooks until --allow-hooks is passed once`,
    `  --kill-timeout <ms>                  Child graceful shutdown timeout (default 10000)`,
    `  --dry-run                            Watch + log decisions; never spawn child or hooks`,
    `  --explain                            Print the decision tree at startup and exit`,
    `  --no-cache                           Skip the customBuild input-hash cache`,
    `  --cooldown <ms>                      Per-package post-build quiet window (default 500)`,
    `  --build-concurrency <n>              Max parallel customBuilds at the same topo level (default 4)`,
    `  --no-gitignore                       Don't apply .gitignore rules to the watcher`,
    `  --allow-cjs-config                   Permit .cjs config files (they execute JS on load)`,
    `  --allow-hooks-js                     Load monoripple.hooks.js if present (arbitrary JS)`,
    ``,
    `Interactive keys: r restart · b restart+before · d info · v verbose · p pause · c clear · q quit · ? help`,
    ``,
    `Examples:`,
    `  monoripple init`,
    `  monoripple init apps/server --workspace-root`,
    `  monoripple`,
    `  monoripple apps/server -- pnpm dev`,
  ].join("\n");
}
