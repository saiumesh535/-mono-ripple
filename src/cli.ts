#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import pc from "picocolors";
import {
  effectivePackageCustomBuild,
  packageCustomBuildCwd,
  type HookCommand,
  type ParsedCli,
} from "./cli-options";
import {
  loadDepWatchConfig,
  resolveInvocation,
  usageText,
  writeInitConfig,
} from "./config";
import { findWorkspaceDepForFile } from "./find-workspace-dep";
import { isPathInsideDir } from "./path-utils";
import { DevRunner } from "./runner";
import { formatHook, runHookCommand } from "./run-shell";
import { createLogger, type Logger } from "./logger";
import { resolveWorkspaceContext } from "./workspace";
import {
  buildWorkspaceGraph,
  impactedPackages,
  type WorkspaceGraph,
} from "./workspace-graph";
import { createWatcher } from "./watcher";
import { createKeypressController } from "./keypress";
import { createStatusLine } from "./status-line";
import { hookFingerprint, isAcked, recordAck } from "./hook-ack";
import { createEventBus, type EventBus, type WatchEvent } from "./events";
import {
  computeInputHash,
  readLastHash,
  writeHash,
} from "./build-cache";
import { findGitignoreFiles, loadGitignore } from "./ignore";
import { groupIntoLevels, runPool } from "./concurrency";
import { runDoctor } from "./doctor";
import { attachHooks, findHooksFile, loadHooks } from "./user-hooks";

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  const quietLog = createLogger({ verbose: false });

  // doctor subcommand
  if (rawArgv[0] === "doctor") {
    const appHint = rawArgv.slice(1).find((a) => !a.startsWith("-"));
    const logger = createLogger({ verbose: false });
    const result = runDoctor({ cwd: process.cwd(), appHint, logger });
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  // init subcommand
  const isInit = rawArgv[0] === "--init" || rawArgv[0] === "init";
  if (isInit) {
    try {
      let appHint: string | undefined;
      let workspaceRoot = false;
      for (const a of rawArgv.slice(1)) {
        if (a === "--workspace-root") workspaceRoot = true;
        else if (!a.startsWith("-")) appHint ??= a;
      }
      const out = writeInitConfig({ cwd: process.cwd(), appHint, workspaceRoot });
      if (workspaceRoot) {
        quietLog.info(`wrote ${out} at workspace root with "app" + explicit packages[…].customBuild (pnpm run build)`);
      } else {
        quietLog.info(`wrote ${out} (app = directory containing this file; use init … --workspace-root for a root-level config with "app")`);
      }
    } catch (e) {
      quietLog.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
    return;
  }

  const allowCjsConfigEarly = rawArgv.includes("--allow-cjs-config");

  let parsed: ParsedCli;
  let configFile: ReturnType<typeof loadDepWatchConfig> = null;
  try {
    configFile = loadDepWatchConfig(process.cwd(), { allowCjs: allowCjsConfigEarly });
    if (!configFile) {
      const hint = firstPositional(rawArgv);
      if (hint) {
        const hintPath = path.resolve(process.cwd(), hint);
        if (fs.existsSync(hintPath)) {
          configFile = loadDepWatchConfig(hintPath, { allowCjs: allowCjsConfigEarly });
        }
      }
    }
    parsed = resolveInvocation(rawArgv, configFile);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    quietLog.error(msg);
    if (!msg.includes("Usage:")) {
      console.error("");
      console.error(usageText());
    }
    process.exitCode = 1;
    return;
  }

  const status = createStatusLine({ enabled: parsed.statusLine && !parsed.dryRun });
  const logger = createLogger({
    verbose: parsed.verbose,
    json: parsed.json,
    write: (line) => {
      if (!status.enabled()) {
        console.error(line);
        return;
      }
      process.stderr.write(status.withPrint(`${line}\n`));
    },
  });

  const appRoot = fs.realpathSync(path.resolve(process.cwd(), parsed.appDir));
  if (!fs.existsSync(path.join(appRoot, "package.json"))) {
    logger.error(`No package.json in ${appRoot}`);
    status.stop();
    process.exitCode = 1;
    return;
  }

  const ctx = resolveWorkspaceContext(appRoot);

  if (parsed.configPath) {
    const inside = isPathInsideDir(
      path.resolve(parsed.configPath),
      path.resolve(ctx.repoRoot),
    );
    if (!inside) {
      logger.error(
        `config ${parsed.configPath} is outside the detected workspace root ${ctx.repoRoot} — refusing to execute its hooks.`,
      );
      status.stop();
      process.exitCode = 1;
      return;
    }
  }

  const graph: WorkspaceGraph = buildWorkspaceGraph(appRoot, ctx);
  const watchRoots = new Set<string>([appRoot]);
  for (const d of graph.deps) watchRoots.add(d.root);

  status.setWatchCount(graph.deps.length);

  const bus = createEventBus();
  const now = () => Date.now();

  // JSON mode: mirror every bus event to a structured log line.
  if (parsed.json) {
    bus.on("*", (e) => logger.event(e.type, JSON.stringify(e), e as unknown as Record<string, unknown>));
  }

  // Load user JS hooks (opt-in).
  if (parsed.allowHooksJs && configFile) {
    const hooksFile = findHooksFile(configFile.path);
    if (hooksFile) {
      try {
        const mod = loadHooks(hooksFile);
        attachHooks(bus, mod, logger);
        logger.info(`user hooks: ${hooksFile}`);
      } catch (e) {
        logger.error(`failed to load ${hooksFile}: ${e instanceof Error ? e.message : String(e)}`);
        status.stop();
        process.exitCode = 1;
        return;
      }
    }
  }

  if (parsed.configPath) logger.info(`config: ${parsed.configPath}`);
  logger.info(`repo root: ${ctx.repoRoot}`);
  logger.info(`app: ${appRoot} (${graph.appName})`);
  if (graph.deps.length === 0) {
    logger.info("workspace deps: (none — watching app only)");
  } else {
    logger.info(`workspace deps (${graph.deps.length}): ${graph.deps.map((d) => d.name).join(", ")}`);
    for (const d of graph.deps) logger.debug(`  ${d.name} → ${d.root}`);
  }
  logger.info(`watch roots: ${[...watchRoots].join(", ")}`);
  logger.info(
    `command: ${parsed.commandShell ? parsed.command[0] : parsed.command.join(" ")} (cwd=${appRoot}${parsed.commandShell ? ", shell" : ""})`,
  );
  if (parsed.before) {
    logger.info(
      `--before: ${formatHook(parsed.before)} (cwd=${ctx.repoRoot})${parsed.beforeDepsOnly ? " [deps-only]" : ""}`,
    );
  }
  if (parsed.dryRun) logger.info(pc.yellow("dry-run mode: no child will be spawned, no hooks will run"));
  if (parsed.interactive) logger.info("interactive: on — press ? for keybindings");
  if (!parsed.noCache) logger.info(`cache: on (content-hashed input; --no-cache to disable)`);

  if (!(await ensureHookTrust(logger, parsed, configFile))) {
    status.stop();
    process.exitCode = 1;
    return;
  }

  // --explain: print decision tree and exit.
  if (parsed.explain) {
    printExplain(logger, parsed, graph, ctx.repoRoot, appRoot);
    status.stop();
    return;
  }

  bus.emit({
    type: "startup",
    ts: now(),
    watchRoots: [...watchRoots],
    deps: graph.deps.map((d) => d.name),
  });

  let restartInFlight = false;
  let pendingBurst: { paths: string[]; first: string } | null = null;
  let firstStartDone = false;
  let verboseRuntime = parsed.verbose;

  const runner = new DevRunner({
    cwd: appRoot,
    command: parsed.command,
    shell: parsed.commandShell,
    detachStdin: parsed.interactive,
    killTimeoutMs: parsed.killTimeoutMs,
    onExit: ({ code, signal }) => {
      bus.emit({ type: "child:crash", ts: now(), code, signal });
      status.set({ kind: "crashed", code, signal });
      logger.event("child-exit", `child exited (code=${code}, signal=${signal ?? "null"}) — restarting…`);
      try {
        if (!parsed.dryRun) runner.start();
        bus.emit({ type: "child:start", ts: now() });
        status.set({ kind: "running", since: Date.now() });
      } catch (e) {
        logger.error(`failed to restart: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  async function runHook(
    cmd: HookCommand,
    cwd: string,
    kind: string,
    prefix?: string,
  ): Promise<boolean> {
    if (parsed.dryRun) {
      logger.info(`${pc.yellow("[dry-run]")} would run ${kind} ▸ ${formatHook(cmd)} (cwd=${cwd})`);
      return true;
    }
    logger.event("hook-start", `${kind} ▸ ${formatHook(cmd)} (cwd=${cwd})`, {
      kind, command: cmd, cwd,
    });
    try {
      await runHookCommand(cmd, { cwd, ...(prefix ? { prefix } : {}) });
      logger.event("hook-ok", `${kind} ✓`, { kind });
      return true;
    } catch (e) {
      logger.warn(`${kind} failed: ${e instanceof Error ? e.message : String(e)}`, { kind });
      return false;
    }
  }

  async function maybeRunBefore(
    reason: "initial" | "watch",
    changedPaths: string[],
  ): Promise<boolean> {
    if (!parsed.before) return true;
    if (reason === "watch" && parsed.beforeDepsOnly && changedPaths.length > 0) {
      const anyOutsideApp = changedPaths.some(
        (p) => !isPathInsideDir(path.resolve(p), appRoot),
      );
      if (!anyOutsideApp) {
        logger.debug("skipping --before (all changes inside app root)");
        return true;
      }
    }
    const start = now();
    bus.emit({ type: "before:start", ts: start, command: formatHook(parsed.before) });
    const ok = await runHook(parsed.before, ctx.repoRoot, "--before");
    const end = now();
    if (ok) bus.emit({ type: "before:end", ts: end, ms: end - start });
    else bus.emit({ type: "before:fail", ts: end, ms: end - start, error: "non-zero exit" });
    return ok;
  }

  /** Run one package's customBuild with input-hash cache. */
  const runOneBuild = async (name: string): Promise<boolean> => {
    const dep = graph.byName.get(name);
    if (!dep) return true;
    const pkgOv = parsed.packageOverrides?.[name];
    const customBuild = effectivePackageCustomBuild(pkgOv);
    if (!customBuild) return true;
    const cwd = packageCustomBuildCwd(pkgOv, dep.root, ctx.repoRoot);

    const cacheKey = `customBuild@${name}`;
    const useCache = !parsed.noCache && !parsed.dryRun;

    if (useCache) {
      const input = computeInputHash(dep.root, customBuild);
      const last = readLastHash(dep.root, cacheKey);
      if (last === input) {
        logger.info(
          `${pc.green("cache hit")} packages["${name}"].customBuild (inputs unchanged)`,
        );
        bus.emit({ type: "build:cache-hit", ts: now(), pkg: name });
        return true;
      }
    }

    status.set({ kind: "building", pkg: name });
    const start = now();
    bus.emit({ type: "build:start", ts: start, pkg: name, command: formatHook(customBuild) });
    const ok = await runHook(customBuild, cwd, `packages["${name}"].customBuild`, name);
    const end = now();
    const ms = end - start;

    if (ok) {
      bus.emit({ type: "build:end", ts: end, pkg: name, ms });
      if (useCache) {
        try {
          const after = computeInputHash(dep.root, customBuild);
          writeHash(dep.root, cacheKey, after);
        } catch (e) {
          logger.debug(`cache write failed for ${name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // Post-build cooldown: suppress watch events inside the package for cooldownMs.
      if (parsed.cooldownMs > 0) {
        watcher.cooldown(dep.root, parsed.cooldownMs);
      }
    } else {
      bus.emit({ type: "build:fail", ts: end, pkg: name, ms, error: "non-zero exit" });
    }
    return ok;
  };

  const runCustomBuildsFor = async (
    changedPackages: Set<string>,
  ): Promise<boolean> => {
    if (changedPackages.size === 0) return true;
    const impacted = impactedPackages(graph, changedPackages);
    if (impacted.length === 0) return true;

    // Only include packages that actually have a customBuild hook.
    const effective = impacted.filter((name) => {
      const ov = parsed.packageOverrides?.[name];
      return effectivePackageCustomBuild(ov) !== undefined;
    });
    if (effective.length === 0) return true;

    const levels = groupIntoLevels(effective, graph.dependsOn);
    logger.event(
      "build-plan",
      `build plan: ${levels.map((l) => l.join("+")).join(" → ")}`,
      { levels },
    );

    for (const level of levels) {
      if (level.length === 0) continue;
      let anyFailed = false;
      await runPool(level, parsed.buildConcurrency, async (name) => {
        const ok = await runOneBuild(name);
        if (!ok) anyFailed = true;
      });
      if (anyFailed) return false;
    }
    return true;
  };

  const processBurst = async (paths: string[], first: string) => {
    const changedPackages = new Set<string>();
    for (const p of paths) {
      const abs = path.resolve(p);
      const dep = findWorkspaceDepForFile(abs, appRoot, graph.deps);
      if (dep) changedPackages.add(dep.name);
    }
    const label =
      paths.length === 1
        ? path.relative(ctx.repoRoot, first) || first
        : `${paths.length} files (first: ${path.relative(ctx.repoRoot, first) || first})`;

    status.set({ kind: "restarting", path: label });
    bus.emit({
      type: "burst",
      ts: now(),
      paths,
      packages: [...changedPackages],
    });
    logger.event("change", `change detected in ${label} → restarting…`, {
      paths: paths.map((p) => path.relative(ctx.repoRoot, p) || p),
      packages: [...changedPackages],
    });

    const restartStart = now();
    bus.emit({ type: "restart:start", ts: restartStart, reason: label });

    if (!(await runCustomBuildsFor(changedPackages))) return;
    if (!(await maybeRunBefore("watch", paths))) return;

    if (!parsed.dryRun) {
      try {
        await runner.stopForRestart();
      } catch (e) {
        logger.error(`stop failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      runner.start();
      bus.emit({ type: "child:start", ts: now() });
    } else {
      logger.info(`${pc.yellow("[dry-run]")} would restart child`);
    }
    const restartEnd = now();
    status.incRestarts();
    status.set({ kind: "running", since: Date.now() });
    bus.emit({ type: "restart:end", ts: restartEnd, ms: restartEnd - restartStart });
    logger.info(pc.dim(`restart complete in ${restartEnd - restartStart}ms`));
  };

  const scheduleBurst = async (burst: { paths: string[]; first: string }) => {
    if (restartInFlight) {
      pendingBurst = mergeBursts(pendingBurst, burst);
      return;
    }
    restartInFlight = true;
    try {
      let current: { paths: string[]; first: string } | null = burst;
      while (current) {
        const next = current;
        pendingBurst = null;
        await processBurst(next.paths, next.first);
        current = pendingBurst;
      }
    } finally {
      restartInFlight = false;
    }
  };

  // .gitignore integration
  let extraIgnore: ((p: string) => boolean) | undefined;
  if (parsed.useGitignore) {
    const files = findGitignoreFiles(ctx.repoRoot, [...watchRoots]);
    if (files.length > 0) {
      const matcher = loadGitignore(files);
      extraIgnore = (p: string) => matcher.ignores(p);
      logger.debug(`gitignore: loaded ${files.length} file(s)`);
    }
  }

  const watcher = createWatcher({
    roots: [...watchRoots],
    debounceMs: parsed.debounceMs,
    verbose: parsed.verbose,
    onBurst: (b) => void scheduleBurst(b),
    logger,
    ...(extraIgnore ? { extraIgnore } : {}),
  });

  const shutdown = async () => {
    bus.emit({ type: "shutdown", ts: now() });
    status.set({ kind: "shutdown" });
    await watcher.close();
    await runner.shutdown();
    status.stop();
  };

  let quitting = false;
  const quitGracefully = (exitCode = 0) => {
    if (quitting) return;
    quitting = true;
    keypress.stop();
    void shutdown().finally(() => process.exit(exitCode));
  };

  const keypress = createKeypressController({
    enabled: parsed.interactive,
    logger,
    actions: {
      restart: () => {
        logger.info("↻ manual restart (key r)");
        void scheduleBurst({ paths: [appRoot], first: appRoot });
      },
      restartWithBefore: () => {
        logger.info("↻ manual restart + --before (key b)");
        void (async () => {
          if (parsed.before) await runHook(parsed.before, ctx.repoRoot, "--before (manual)");
          void scheduleBurst({ paths: [appRoot], first: appRoot });
        })();
      },
      printInfo: () => {
        logger.info(pc.bold("watch info:"));
        logger.info(`  app: ${appRoot} (${graph.appName})`);
        logger.info(`  repo root: ${ctx.repoRoot}`);
        logger.info(`  deps (${graph.deps.length}):`);
        for (const d of graph.deps) logger.info(`    ${d.name} → ${d.root}`);
        logger.info(`  watch roots: ${[...watchRoots].join(", ")}`);
        logger.info(`  paused: ${watcher.isPaused()}`);
      },
      toggleVerbose: () => {
        verboseRuntime = !verboseRuntime;
        logger.info(`verbose → ${verboseRuntime}`);
      },
      togglePause: () => {
        if (watcher.isPaused()) {
          watcher.resume();
          logger.info("▶ resumed file watching");
          if (firstStartDone) status.set({ kind: "running", since: Date.now() });
        } else {
          watcher.pause();
          logger.info("⏸ paused file watching");
          status.set({ kind: "paused" });
        }
      },
      clearScreen: () => {
        if (process.stderr.isTTY) process.stderr.write("\x1b[2J\x1b[H");
      },
      quit: () => {
        logger.info("bye.");
        quitGracefully(0);
      },
    },
  });

  process.on("SIGINT", () => quitGracefully(0));
  process.on("SIGTERM", () => quitGracefully(0));

  void (async () => {
    if (await maybeRunBefore("initial", [])) {
      if (!parsed.dryRun) runner.start();
      else logger.info(`${pc.yellow("[dry-run]")} would start child ${parsed.command.join(" ")}`);
      bus.emit({ type: "child:start", ts: now() });
      firstStartDone = true;
      status.set({ kind: "running", since: Date.now() });
    } else {
      logger.error("not starting child because --before failed");
      await shutdown();
      process.exitCode = 1;
    }
  })();
}

function firstPositional(argv: string[]): string | undefined {
  const sep = argv.indexOf("--");
  const head = sep === -1 ? argv : argv.slice(0, sep);
  const valueFlags = new Set([
    "--debounce", "-d", "--before", "--kill-timeout", "--cooldown", "--build-concurrency",
  ]);
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if (valueFlags.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    return a;
  }
  return undefined;
}

function mergeBursts(
  prev: { paths: string[]; first: string } | null,
  next: { paths: string[]; first: string },
): { paths: string[]; first: string } {
  if (!prev) return next;
  const paths = new Set(prev.paths);
  for (const p of next.paths) paths.add(p);
  return { paths: [...paths], first: prev.first };
}

function printExplain(
  logger: Logger,
  parsed: ParsedCli,
  graph: WorkspaceGraph,
  repoRoot: string,
  appRoot: string,
): void {
  logger.info(pc.bold("explain:"));
  logger.info(`  app: ${appRoot} (${graph.appName})`);
  logger.info(`  repo root: ${repoRoot}`);
  logger.info(`  debounce: ${parsed.debounceMs}ms; cooldown after build: ${parsed.cooldownMs}ms`);
  logger.info(`  build concurrency: ${parsed.buildConcurrency}`);
  logger.info(`  when a file changes under:`);
  logger.info(`    ${appRoot} → app change: skip builds, run --before${parsed.beforeDepsOnly ? " (disabled: --before-deps-only)" : ""}, restart`);
  for (const dep of graph.deps) {
    const ov = parsed.packageOverrides?.[dep.name];
    const cb = effectivePackageCustomBuild(ov);
    const cwd = cb ? packageCustomBuildCwd(ov, dep.root, repoRoot) : null;
    const dependents = [...(graph.dependents.get(dep.name) ?? [])].filter(
      (n) => n !== graph.appName,
    );
    logger.info(`    ${dep.root}`);
    logger.info(`      → package: ${dep.name}`);
    if (cb) {
      logger.info(`      → customBuild: ${formatHook(cb)} (cwd=${cwd})`);
    } else {
      logger.info(`      → customBuild: (none — only restart)`);
    }
    if (dependents.length > 0) {
      logger.info(`      → also rebuild (depends on ${dep.name}): ${dependents.join(", ")}`);
    }
  }
  logger.info(`    then: ${parsed.before ? `run --before (${formatHook(parsed.before)})` : "(no --before)"} → restart child`);
}

async function ensureHookTrust(
  logger: Logger,
  parsed: ParsedCli,
  file: { path: string; config: import("./config").DepWatchConfigFile } | null,
): Promise<boolean> {
  if (!file) return true;
  const hookBodies: Record<string, HookCommand> = {};
  if (file.config.before !== undefined) hookBodies.__before = file.config.before;
  if (file.config.packages) {
    for (const [name, p] of Object.entries(file.config.packages)) {
      if (p.customBuild !== undefined) hookBodies[name] = p.customBuild;
    }
  }
  if (Object.keys(hookBodies).length === 0) return true;

  const configAbs = path.resolve(file.path);
  const fp = hookFingerprint(configAbs, hookBodies);
  const acked = isAcked(fp);

  if (parsed.allowHooks && !acked) {
    recordAck(fp, configAbs);
    logger.info(`trust recorded for this config's hooks.`);
    return true;
  }

  if (acked) return true;

  logger.warn(`this config defines hook commands that will execute on file changes:`);
  for (const [k, v] of Object.entries(hookBodies)) {
    const label = k === "__before" ? "before" : `packages["${k}"].customBuild`;
    logger.warn(`  ${label}: ${formatHook(v)}`);
  }

  if (parsed.strictHooks) {
    logger.error(`--strict-hooks: refusing to run. Re-run with --allow-hooks to trust this config's hooks.`);
    return false;
  }

  logger.warn(`pass --strict-hooks to require explicit trust, or --allow-hooks to silence this warning.`);
  return true;
}

void main();
