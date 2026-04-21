import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  findDepWatchConfigPath,
  loadDepWatchConfig,
  resolveAppDirFromConfig,
} from "../src/config";

function writeJson(p: string, data: unknown) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

test("findDepWatchConfigPath walks upward from cwd", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ww-find-"));
  const app = path.join(root, "apps", "svc");
  const cfg = path.join(app, "dep-watch.config.json");
  try {
    writeJson(cfg, { command: "npm run dev" });
    assert.equal(findDepWatchConfigPath(app), cfg);
    assert.equal(findDepWatchConfigPath(path.join(app, "src")), cfg);
    assert.equal(findDepWatchConfigPath(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveAppDirFromConfig: implicit app = config directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ww-impl-"));
  const app = path.join(root, "apps", "svc");
  const cfgPath = path.join(app, "dep-watch.config.json");
  try {
    writeJson(cfgPath, { command: "npm run dev" });
    const appDir = resolveAppDirFromConfig(app, {
      path: cfgPath,
      config: { command: "npm run dev" },
    });
    assert.equal(path.resolve(app, appDir), path.resolve(app));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveAppDirFromConfig: config at workspace root without app throws", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ww-root-"));
  const cfgPath = path.join(root, "dep-watch.config.json");
  try {
    fs.writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      'packages:\n  - "packages/*"\n',
    );
    writeJson(path.join(root, "package.json"), { name: "r", private: true });
    writeJson(cfgPath, { command: "npm run dev" });
    assert.throws(
      () =>
        resolveAppDirFromConfig(root, {
          path: cfgPath,
          config: { command: "npm run dev" },
        }),
      /workspace root/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loadDepWatchConfig: repo root cwd does not see app-only config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ww-load-"));
  const app = path.join(root, "apps", "svc");
  try {
    fs.writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      'packages:\n  - "apps/*"\n',
    );
    writeJson(path.join(root, "package.json"), { name: "r", private: true });
    writeJson(path.join(app, "dep-watch.config.json"), {
      command: "npm run dev",
    });
    assert.equal(loadDepWatchConfig(root), null);
    assert.notEqual(loadDepWatchConfig(app), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
