import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { WorkspaceRootResult } from "./workspace";

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
] as const;

export type WorkspaceDep = {
  name: string;
  /** Realpath of the package root directory. */
  root: string;
};

export type WorkspaceGraph = {
  /** App's own package name (for edges pointing back at the app). */
  appName: string;
  /** App realpath root. */
  appRoot: string;
  /** All workspace packages reachable from the app (direct + transitive). Sorted by name. */
  deps: WorkspaceDep[];
  /** name -> WorkspaceDep for quick lookup. */
  byName: Map<string, WorkspaceDep>;
  /** edges: "package X depends on packages [Y, Z]" (within the watched set). */
  dependsOn: Map<string, Set<string>>;
  /** reverse edges: "package X is depended on by [A, B]" (within the watched set). */
  dependents: Map<string, Set<string>>;
  /** Topological order (leaves first, app last). Excludes the app. */
  topoOrder: string[];
};

function readJson(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function depNamesOf(pkg: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const field of DEP_FIELDS) {
    const block = pkg[field];
    if (block && typeof block === "object" && !Array.isArray(block)) {
      for (const name of Object.keys(block as Record<string, unknown>)) {
        names.add(name);
      }
    }
  }
  return [...names];
}

/** Resolve a dependency's actual install location from the given package dir. */
function resolveInstalledRoot(
  fromDir: string,
  name: string,
): string | null {
  try {
    const requireFrom = createRequire(path.join(fromDir, "package.json"));
    const manifest = requireFrom.resolve(`${name}/package.json`);
    return fs.realpathSync(path.dirname(manifest));
  } catch {
    return null;
  }
}

/**
 * Build a graph of workspace dependencies reachable from the app (BFS over
 * dependencies/devDependencies/peerDependencies, intersected with the workspace registry).
 */
export function buildWorkspaceGraph(
  appRoot: string,
  ctx: WorkspaceRootResult,
): WorkspaceGraph {
  const appManifest = readJson(path.join(appRoot, "package.json")) ?? {};
  const appName =
    typeof appManifest.name === "string" && appManifest.name
      ? appManifest.name
      : path.basename(appRoot);

  const byName = new Map<string, WorkspaceDep>();
  const dependsOn = new Map<string, Set<string>>();
  const expectedByName = new Map<string, string>();
  for (const [name, dir] of ctx.packages) {
    expectedByName.set(name, fs.realpathSync(dir));
  }

  const appDeps = new Set<string>();
  dependsOn.set(appName, appDeps);

  const queue: { name: string; dir: string }[] = [];
  for (const name of depNamesOf(appManifest)) {
    if (!expectedByName.has(name)) continue;
    const installed = resolveInstalledRoot(appRoot, name);
    if (!installed) continue;
    if (installed !== expectedByName.get(name)) continue;
    if (!byName.has(name)) {
      byName.set(name, { name, root: installed });
      queue.push({ name, dir: installed });
    }
    appDeps.add(name);
  }

  while (queue.length > 0) {
    const { name, dir } = queue.shift()!;
    const manifest = readJson(path.join(dir, "package.json")) ?? {};
    const names = depNamesOf(manifest);
    const childDeps = new Set<string>();
    dependsOn.set(name, childDeps);
    for (const child of names) {
      if (!expectedByName.has(child)) continue;
      if (child === name) continue;
      const installed = resolveInstalledRoot(dir, child);
      if (!installed) continue;
      if (installed !== expectedByName.get(child)) continue;
      if (!byName.has(child)) {
        byName.set(child, { name: child, root: installed });
        queue.push({ name: child, dir: installed });
      }
      childDeps.add(child);
    }
  }

  const dependents = new Map<string, Set<string>>();
  for (const [from, tos] of dependsOn) {
    for (const to of tos) {
      let set = dependents.get(to);
      if (!set) {
        set = new Set();
        dependents.set(to, set);
      }
      set.add(from);
    }
  }

  const topoOrder = topoSort(byName, dependsOn);

  const deps = [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return {
    appName,
    appRoot,
    deps,
    byName,
    dependsOn,
    dependents,
    topoOrder,
  };
}

/** Kahn's algorithm; cycles are broken deterministically (leftover nodes appended by name). */
function topoSort(
  byName: Map<string, WorkspaceDep>,
  dependsOn: Map<string, Set<string>>,
): string[] {
  const names = [...byName.keys()];
  const indeg = new Map<string, number>();
  for (const n of names) indeg.set(n, 0);
  for (const [from, tos] of dependsOn) {
    if (!byName.has(from)) continue;
    for (const to of tos) {
      if (byName.has(to)) {
        indeg.set(from, (indeg.get(from) ?? 0) + 1);
      }
    }
  }
  const out: string[] = [];
  const zero = names.filter((n) => (indeg.get(n) ?? 0) === 0).sort();
  while (zero.length > 0) {
    const n = zero.shift()!;
    out.push(n);
    const parents = [...byName.keys()].filter((p) =>
      dependsOn.get(p)?.has(n),
    );
    for (const p of parents) {
      const left = (indeg.get(p) ?? 0) - 1;
      indeg.set(p, left);
      if (left === 0) {
        const pos = zero.findIndex((x) => x > p);
        if (pos === -1) zero.push(p);
        else zero.splice(pos, 0, p);
      }
    }
  }
  const remaining = names.filter((n) => !out.includes(n)).sort();
  return [...out, ...remaining];
}

/**
 * Given a set of changed package names, compute the full set that needs
 * rebuilding — every affected package plus any workspace package that depends
 * on one of them (within the watched graph). Returned in topological order.
 */
export function impactedPackages(
  graph: WorkspaceGraph,
  changed: Iterable<string>,
): string[] {
  const impacted = new Set<string>();
  const queue: string[] = [];
  for (const n of changed) {
    if (graph.byName.has(n) && !impacted.has(n)) {
      impacted.add(n);
      queue.push(n);
    }
  }
  while (queue.length > 0) {
    const n = queue.shift()!;
    const ups = graph.dependents.get(n);
    if (!ups) continue;
    for (const up of ups) {
      if (up === graph.appName) continue;
      if (graph.byName.has(up) && !impacted.has(up)) {
        impacted.add(up);
        queue.push(up);
      }
    }
  }
  return graph.topoOrder.filter((n) => impacted.has(n));
}
