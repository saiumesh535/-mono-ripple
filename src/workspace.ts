import * as fs from "node:fs";
import * as path from "node:path";
import fg from "fast-glob";
import YAML from "yaml";

export type WorkspaceRootResult = {
  repoRoot: string;
  /** package name -> absolute directory */
  packages: Map<string, string>;
};

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

function normalizeGlobs(globs: string[]): string[] {
  return globs.map((g) => g.replace(/\\/g, "/"));
}

function collectWorkspaceGlobs(repoRoot: string): string[] | null {
  const pnpmWs = path.join(repoRoot, "pnpm-workspace.yaml");
  if (fs.existsSync(pnpmWs)) {
    const raw = fs.readFileSync(pnpmWs, "utf8");
    const doc = YAML.parse(raw) as { packages?: unknown };
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.packages)) {
      throw new Error(
        `[monoripple] Invalid pnpm-workspace.yaml: expected top-level "packages" array at ${pnpmWs}`,
      );
    }
    return doc.packages.filter((p): p is string => typeof p === "string");
  }

  const pkgPath = path.join(repoRoot, "package.json");
  if (!fs.existsSync(pkgPath)) {
    return null;
  }
  const pkg = readJson(pkgPath) as { workspaces?: unknown };
  if (!pkg.workspaces) {
    return null;
  }
  if (Array.isArray(pkg.workspaces)) {
    return pkg.workspaces.filter((p): p is string => typeof p === "string");
  }
  if (
    typeof pkg.workspaces === "object" &&
    pkg.workspaces !== null &&
    "packages" in pkg.workspaces &&
    Array.isArray((pkg.workspaces as { packages: unknown }).packages)
  ) {
    return (pkg.workspaces as { packages: string[] }).packages.filter(
      (p): p is string => typeof p === "string",
    );
  }
  throw new Error(
    `[monoripple] Unsupported "workspaces" shape in ${pkgPath}`,
  );
}

/**
 * Walk upward from startDir to find a directory that defines a JS workspace
 * (pnpm-workspace.yaml or package.json "workspaces").
 */
export function findWorkspaceRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  const { root } = path.parse(dir);
  while (true) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = readJson(pkgPath) as { workspaces?: unknown };
        if (pkg.workspaces) {
          return dir;
        }
      } catch {
        /* ignore malformed package.json */
      }
    }
    if (dir === root) {
      return null;
    }
    dir = path.dirname(dir);
  }
}

/**
 * Enumerate workspace packages: name -> absolute root (realpath).
 */
export function loadWorkspacePackages(repoRoot: string): Map<string, string> {
  const globs = collectWorkspaceGlobs(repoRoot);
  if (!globs || globs.length === 0) {
    throw new Error(
      `[monoripple] No workspace definition found under ${repoRoot} (pnpm-workspace.yaml or package.json workspaces).`,
    );
  }
  const patterns = normalizeGlobs(globs);
  const dirs = fg.sync(patterns, {
    cwd: repoRoot,
    onlyDirectories: true,
    absolute: true,
    followSymbolicLinks: false,
  });
  const map = new Map<string, string>();
  for (const dir of dirs) {
    const manifest = path.join(dir, "package.json");
    if (!fs.existsSync(manifest)) {
      continue;
    }
    try {
      const pkg = readJson(manifest) as { name?: unknown };
      if (typeof pkg.name !== "string" || !pkg.name) {
        continue;
      }
      const real = fs.realpathSync(dir);
      if (!map.has(pkg.name)) {
        map.set(pkg.name, real);
      }
    } catch {
      /* skip */
    }
  }
  return map;
}

export function resolveWorkspaceContext(
  appRoot: string,
): WorkspaceRootResult {
  const repoRoot = findWorkspaceRoot(appRoot);
  if (!repoRoot) {
    throw new Error(
      `[monoripple] Could not find pnpm-workspace.yaml or package.json workspaces when walking up from ${appRoot}.`,
    );
  }
  const packages = loadWorkspacePackages(repoRoot);
  return { repoRoot, packages };
}
