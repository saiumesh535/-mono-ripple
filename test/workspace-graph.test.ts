import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { resolveWorkspaceContext } from "../src/workspace";
import {
  buildWorkspaceGraph,
  impactedPackages,
} from "../src/workspace-graph";

/**
 * Build a pnpm-style monorepo with manual node_modules symlinks so
 * require.resolve works without running a package manager.
 *
 *   app → pkg-a → pkg-b
 *       → pkg-c
 */
function mkChain(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ww-graph-"));
  fs.writeFileSync(
    path.join(root, "pnpm-workspace.yaml"),
    'packages:\n  - "apps/*"\n  - "packages/*"\n',
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "root", private: true }),
  );

  const mk = (
    dir: string,
    pkg: Record<string, unknown>,
    links: Record<string, string> = {},
  ) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
    const nm = path.join(dir, "node_modules");
    for (const [name, target] of Object.entries(links)) {
      fs.mkdirSync(nm, { recursive: true });
      fs.symlinkSync(path.relative(nm, target), path.join(nm, name), "dir");
    }
  };

  const appDir = path.join(root, "apps", "app");
  const a = path.join(root, "packages", "pkg-a");
  const b = path.join(root, "packages", "pkg-b");
  const c = path.join(root, "packages", "pkg-c");

  mk(b, { name: "pkg-b", version: "0.0.0" });
  mk(c, { name: "pkg-c", version: "0.0.0" });
  mk(a, { name: "pkg-a", version: "0.0.0", dependencies: { "pkg-b": "workspace:*" } }, { "pkg-b": b });
  mk(
    appDir,
    {
      name: "app",
      private: true,
      dependencies: { "pkg-a": "workspace:*", "pkg-c": "workspace:*" },
    },
    { "pkg-a": a, "pkg-c": c },
  );

  return root;
}

test("buildWorkspaceGraph discovers transitive deps", () => {
  const root = mkChain();
  try {
    const appRoot = path.join(root, "apps", "app");
    const ctx = resolveWorkspaceContext(appRoot);
    const g = buildWorkspaceGraph(appRoot, ctx);
    const names = g.deps.map((d) => d.name).sort();
    assert.deepEqual(names, ["pkg-a", "pkg-b", "pkg-c"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dependents edges + impactedPackages bubble up from leaf", () => {
  const root = mkChain();
  try {
    const appRoot = path.join(root, "apps", "app");
    const ctx = resolveWorkspaceContext(appRoot);
    const g = buildWorkspaceGraph(appRoot, ctx);
    // A change in pkg-b should impact pkg-b and pkg-a (which depends on b).
    const impactedB = impactedPackages(g, ["pkg-b"]);
    assert.deepEqual(impactedB.sort(), ["pkg-a", "pkg-b"]);
    // A change in pkg-c should only impact itself.
    const impactedC = impactedPackages(g, ["pkg-c"]);
    assert.deepEqual(impactedC, ["pkg-c"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("topological order: leaf before its dependents", () => {
  const root = mkChain();
  try {
    const appRoot = path.join(root, "apps", "app");
    const ctx = resolveWorkspaceContext(appRoot);
    const g = buildWorkspaceGraph(appRoot, ctx);
    const i = (n: string) => g.topoOrder.indexOf(n);
    assert.ok(i("pkg-b") < i("pkg-a"), "pkg-b should come before pkg-a");
    assert.ok(i("pkg-b") !== -1 && i("pkg-a") !== -1 && i("pkg-c") !== -1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
