import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { WorkspaceRootResult } from "./workspace";
import { buildWorkspaceGraph, type WorkspaceDep } from "./workspace-graph";

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
] as const;

function readPackageJson(dir: string): Record<string, unknown> {
  const p = path.join(dir, "package.json");
  return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
}

/**
 * Direct workspace dependencies of `appRoot`. Kept for back-compat; new code
 * should prefer {@link buildWorkspaceGraph} which includes transitive deps.
 */
export function resolveDirectWorkspaceDeps(
  appRoot: string,
  ctx: WorkspaceRootResult,
): WorkspaceDep[] {
  const appPkg = readPackageJson(appRoot);
  const requireFromApp = createRequire(path.join(appRoot, "package.json"));
  const names = new Set<string>();
  for (const field of DEP_FIELDS) {
    const block = appPkg[field];
    if (!block || typeof block !== "object" || block === null) {
      continue;
    }
    for (const name of Object.keys(block as Record<string, unknown>)) {
      names.add(name);
    }
  }

  const roots: WorkspaceDep[] = [];
  for (const name of names) {
    const expected = ctx.packages.get(name);
    if (!expected) continue;
    let resolvedPkgJson: string;
    try {
      resolvedPkgJson = requireFromApp.resolve(`${name}/package.json`);
    } catch {
      continue;
    }
    const resolvedRoot = fs.realpathSync(
      path.dirname(path.resolve(resolvedPkgJson)),
    );
    const expectedReal = fs.realpathSync(expected);
    if (resolvedRoot === expectedReal) {
      roots.push({ name, root: resolvedRoot });
    }
  }
  roots.sort((a, b) => a.name.localeCompare(b.name));
  return roots;
}

/** Convenience: full transitive graph from the app. */
export function resolveWorkspaceDepsGraph(
  appRoot: string,
  ctx: WorkspaceRootResult,
) {
  return buildWorkspaceGraph(appRoot, ctx);
}
