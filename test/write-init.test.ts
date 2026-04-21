import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DEFAULT_PACKAGE_CUSTOM_BUILD } from "../src/cli-options";
import { writeInitConfig } from "../src/config";
import { resolveDirectWorkspaceDeps } from "../src/resolve-deps";
import { resolveWorkspaceContext } from "../src/workspace";

/**
 * Minimal pnpm-style layout with a manual symlink so `require.resolve` works
 * without running `pnpm install` (no network).
 */
function mkWorkspaceWithLinkedDep(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ww-ws-"));
  fs.writeFileSync(
    path.join(root, "pnpm-workspace.yaml"),
    'packages:\n  - "apps/*"\n  - "packages/*"\n',
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "root", private: true }),
  );
  const appDir = path.join(root, "apps", "app");
  const pkgDir = path.join(root, "packages", "pkg-a");
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "package.json"),
    JSON.stringify({
      name: "app",
      private: true,
      dependencies: { "pkg-a": "workspace:*" },
    }),
  );
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "pkg-a", version: "0.0.0" }),
  );
  const nm = path.join(appDir, "node_modules");
  fs.mkdirSync(nm, { recursive: true });
  const linkPath = path.join(nm, "pkg-a");
  const rel = path.relative(nm, pkgDir);
  fs.symlinkSync(rel, linkPath, "dir");
  return root;
}

test("resolveDirectWorkspaceDeps is empty without workspace link (documents user pitfall)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ww-nolink-"));
  try {
    fs.writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      'packages:\n  - "apps/*"\n  - "packages/*"\n',
    );
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "root", private: true }),
    );
    const appDir = path.join(root, "apps", "app");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "package.json"),
      JSON.stringify({
        name: "app",
        private: true,
        dependencies: { "pkg-a": "workspace:*" },
      }),
    );
    fs.mkdirSync(path.join(root, "packages", "pkg-a"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "packages", "pkg-a", "package.json"),
      JSON.stringify({ name: "pkg-a", version: "0.0.0" }),
    );
    const ctx = resolveWorkspaceContext(appDir);
    const deps = resolveDirectWorkspaceDeps(appDir, ctx);
    assert.equal(
      deps.length,
      0,
      "without node_modules link, init emits no packages — run pnpm install in the monorepo",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeInitConfig (in-app) lists each linked workspace dep with customBuild", () => {
  const root = mkWorkspaceWithLinkedDep();
  const appDir = path.join(root, "apps", "app");
  const cfgPath = path.join(appDir, "monoripple.config.json");
  try {
    const out = writeInitConfig({ cwd: root, appHint: "apps/app" });
    assert.equal(out, cfgPath);
    const json = JSON.parse(fs.readFileSync(out, "utf8")) as {
      app?: string;
      command: string;
      packages?: Record<string, { customBuild?: string }>;
    };
    assert.equal(json.command, "npm run dev");
    assert.equal(json.app, undefined);
    assert.ok(json.packages);
    assert.equal(json.packages["pkg-a"].customBuild, DEFAULT_PACKAGE_CUSTOM_BUILD);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeInitConfig (--workspace-root) writes app + packages at repo root", () => {
  const root = mkWorkspaceWithLinkedDep();
  const cfgPath = path.join(root, "monoripple.config.json");
  try {
    const out = writeInitConfig({
      cwd: root,
      appHint: "apps/app",
      workspaceRoot: true,
    });
    assert.equal(out, cfgPath);
    const json = JSON.parse(fs.readFileSync(out, "utf8")) as {
      app: string;
      packages?: Record<string, { customBuild?: string }>;
    };
    assert.equal(json.app, "apps/app");
    assert.equal(json.packages?.["pkg-a"]?.customBuild, DEFAULT_PACKAGE_CUSTOM_BUILD);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
