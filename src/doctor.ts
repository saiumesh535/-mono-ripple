import * as fs from "node:fs";
import * as path from "node:path";
import pc from "picocolors";
import { findDepWatchConfigPath, loadDepWatchConfig } from "./config";
import type { Logger } from "./logger";
import { resolveWorkspaceContext, findWorkspaceRoot } from "./workspace";
import { buildWorkspaceGraph } from "./workspace-graph";

export type DoctorResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  infos: string[];
};

/**
 * Diagnose a monoripple setup. Designed to be purely read-only.
 */
export function runDoctor(opts: {
  cwd: string;
  appHint?: string;
  logger: Logger;
}): DoctorResult {
  const { cwd, appHint, logger } = opts;
  const errors: string[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];

  logger.info(pc.bold("monoripple doctor"));

  // 1) Config discovery
  const cfgUp = findDepWatchConfigPath(cwd);
  if (cfgUp) {
    infos.push(`config found at: ${cfgUp}`);
  } else if (appHint) {
    const fromHint = findDepWatchConfigPath(path.resolve(cwd, appHint));
    if (fromHint) {
      warnings.push(
        `no config at or above ${cwd} — but one exists at ${fromHint}. Run from that directory or pass the app path so CLI loads it.`,
      );
    } else {
      errors.push(`no monoripple.config.json found at/above ${cwd} or ${appHint}. Run \`monoripple init\`.`);
    }
  } else {
    errors.push(`no monoripple.config.json found at/above ${cwd}. Run \`monoripple init\`.`);
  }

  const effectiveCfg = cfgUp
    ? loadDepWatchConfig(cwd)
    : appHint
      ? loadDepWatchConfig(path.resolve(cwd, appHint))
      : null;

  // 2) Workspace resolution
  const appDir = effectiveCfg
    ? resolveAppFromLoaded(effectiveCfg, cwd)
    : appHint
      ? path.resolve(cwd, appHint)
      : cwd;

  if (!fs.existsSync(path.join(appDir, "package.json"))) {
    errors.push(`app dir has no package.json: ${appDir}`);
    return report(logger, { ok: false, errors, warnings, infos });
  }
  const repoRoot = findWorkspaceRoot(appDir);
  if (!repoRoot) {
    errors.push(
      `no workspace root found above ${appDir} (expected pnpm-workspace.yaml or package.json "workspaces").`,
    );
    return report(logger, { ok: false, errors, warnings, infos });
  }
  infos.push(`repo root: ${repoRoot}`);

  // 3) Build graph + check resolvability
  let graph;
  try {
    const ctx = resolveWorkspaceContext(appDir);
    graph = buildWorkspaceGraph(appDir, ctx);
  } catch (e) {
    errors.push(`failed to build workspace graph: ${e instanceof Error ? e.message : String(e)}`);
    return report(logger, { ok: false, errors, warnings, infos });
  }

  infos.push(`app: ${graph.appRoot} (${graph.appName})`);
  infos.push(`${graph.deps.length} workspace dep${graph.deps.length === 1 ? "" : "s"} (transitive)`);

  // 4) Deps declared in app package.json but unresolvable
  const appPkg = safeReadPackageJson(appDir);
  const declared = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const block = appPkg[field];
    if (block && typeof block === "object" && !Array.isArray(block)) {
      for (const n of Object.keys(block as Record<string, unknown>)) declared.add(n);
    }
  }
  for (const name of declared) {
    const found = graph.byName.has(name);
    if (!found) {
      // only warn if a workspace package with that name actually exists on disk
      const wsPath = findWorkspacePackageOnDisk(repoRoot, name);
      if (wsPath) {
        warnings.push(
          `dep "${name}" is a workspace package at ${wsPath} but not resolvable from ${appDir}/node_modules — run \`pnpm install\`.`,
        );
      }
    }
  }

  // 5) Packages with a `build` script but no customBuild in config
  const pkgCfg = effectiveCfg?.config.packages ?? {};
  for (const dep of graph.deps) {
    const depPkg = safeReadPackageJson(dep.root);
    const scripts = depPkg.scripts as Record<string, string> | undefined;
    const hasBuildScript = scripts && (scripts.build || scripts.compile);
    const ov = pkgCfg[dep.name];
    const hasHook = ov && (ov.customBuild !== undefined || Object.keys(ov).length > 0);
    if (hasBuildScript && !hasHook) {
      warnings.push(
        `${dep.name} has a "${scripts.build ? "build" : "compile"}" script but no packages["${dep.name}"].customBuild — changes will only restart, not rebuild.`,
      );
    }
  }

  // 6) Symlink mismatches between app/node_modules and workspace path
  const nm = path.join(appDir, "node_modules");
  for (const dep of graph.deps) {
    const linked = path.join(nm, ...dep.name.split("/"));
    if (fs.existsSync(linked)) {
      try {
        const real = fs.realpathSync(linked);
        if (real !== dep.root) {
          warnings.push(
            `${dep.name} node_modules link points to ${real} but workspace root is ${dep.root}.`,
          );
        }
      } catch {
        warnings.push(`${dep.name} node_modules entry exists but realpath failed.`);
      }
    }
  }

  // 7) Stale dist older than newest src
  for (const dep of graph.deps) {
    const distDir = path.join(dep.root, "dist");
    const srcDir = path.join(dep.root, "src");
    if (fs.existsSync(distDir) && fs.existsSync(srcDir)) {
      const distT = newestMtime(distDir);
      const srcT = newestMtime(srcDir);
      if (srcT > distT) {
        warnings.push(
          `${dep.name}: src/ is newer than dist/ — an initial build may be needed before first restart.`,
        );
      }
    }
  }

  // 8) Co-existing tools
  if (fs.existsSync(path.join(repoRoot, "turbo.json"))) {
    infos.push(`turbo.json detected — ensure customBuild doesn't double-build (turbo may already handle this).`);
  }
  if (fs.existsSync(path.join(repoRoot, "nx.json"))) {
    infos.push(`nx.json detected — consider whether Nx's own watcher overlaps with monoripple.`);
  }

  return report(logger, {
    ok: errors.length === 0,
    errors,
    warnings,
    infos,
  });
}

function resolveAppFromLoaded(
  loaded: { path: string; config: { app?: string } },
  cwd: string,
): string {
  const configDir = path.dirname(path.resolve(loaded.path));
  const app = loaded.config.app;
  if (!app || app === "" || app === ".") return configDir;
  if (path.isAbsolute(app)) return path.resolve(app);
  const repoRoot = findWorkspaceRoot(configDir);
  if (repoRoot) return path.resolve(repoRoot, app);
  return path.resolve(cwd, app);
}

function safeReadPackageJson(dir: string): Record<string, unknown> {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(dir, "package.json"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function findWorkspacePackageOnDisk(
  repoRoot: string,
  name: string,
): string | null {
  const candidates = [
    path.join(repoRoot, "packages", ...name.split("/")),
    path.join(repoRoot, "apps", ...name.split("/")),
    path.join(repoRoot, ...name.split("/")),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "package.json"))) return c;
  }
  return null;
}

function newestMtime(dir: string): number {
  let max = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        walk(full);
      } else {
        try {
          const m = fs.statSync(full).mtimeMs;
          if (m > max) max = m;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dir);
  return max;
}

function report(logger: Logger, r: DoctorResult): DoctorResult {
  for (const m of r.infos) logger.info(`  ${pc.dim("·")} ${m}`);
  for (const m of r.warnings) logger.warn(`  ${pc.yellow("⚠")} ${m}`);
  for (const m of r.errors) logger.error(`  ${pc.red("✗")} ${m}`);
  if (r.ok && r.warnings.length === 0) {
    logger.info(pc.green("  ✓ all checks passed"));
  } else if (r.ok) {
    logger.info(pc.yellow(`  ${r.warnings.length} warning${r.warnings.length === 1 ? "" : "s"}`));
  } else {
    logger.error(pc.red(`  ${r.errors.length} error${r.errors.length === 1 ? "" : "s"}, ${r.warnings.length} warning${r.warnings.length === 1 ? "" : "s"}`));
  }
  return r;
}
