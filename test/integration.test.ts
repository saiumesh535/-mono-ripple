import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function mkWorkspace(): { root: string; appDir: string; pkgDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ww-int-"));
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
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "pkg-a", version: "0.0.0" }),
  );
  fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = 1;\n");
  fs.writeFileSync(
    path.join(appDir, "package.json"),
    JSON.stringify({
      name: "app",
      private: true,
      dependencies: { "pkg-a": "workspace:*" },
    }),
  );
  const nm = path.join(appDir, "node_modules");
  fs.mkdirSync(nm, { recursive: true });
  fs.symlinkSync(path.relative(nm, pkgDir), path.join(nm, "pkg-a"), "dir");
  return { root, appDir, pkgDir };
}

const CLI_ENTRY = path.resolve(__dirname, "..", "src", "cli.ts");
const TSX_BIN = path.resolve(__dirname, "..", "node_modules", ".bin", "tsx");

type Running = {
  stdout: string;
  stderr: string;
  kill: () => Promise<void>;
  onStdout: (text: string) => Promise<void>;
};

function spawnCli(appDir: string, argsAfterDash: string[]): Running {
  const child = spawn(
    TSX_BIN,
    [CLI_ENTRY, appDir, "--debounce", "50", "--no-interactive", "--no-status", "--", ...argsAfterDash],
    {
      cwd: appDir,
      env: { ...process.env, NO_COLOR: "1", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const state: Running = {
    stdout: "",
    stderr: "",
    async kill() {
      child.kill("SIGINT");
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
    onStdout(text: string) {
      return new Promise<void>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error(`timeout waiting for "${text}"; saw stdout=\n${state.stdout}\nstderr=\n${state.stderr}`)),
          10_000,
        );
        const check = () => {
          if (state.stdout.includes(text)) {
            clearTimeout(t);
            cleanup();
            resolve();
          }
        };
        const onData = (chunk: Buffer) => {
          state.stdout += chunk.toString("utf8");
          check();
        };
        const cleanup = () => child.stdout?.off("data", onData);
        child.stdout?.on("data", onData);
        check();
      });
    },
  };
  child.stdout?.on("data", (c: Buffer) => { state.stdout += c.toString("utf8"); });
  child.stderr?.on("data", (c: Buffer) => { state.stderr += c.toString("utf8"); });
  return state;
}

test("restarts when a workspace dep file changes", async () => {
  const { root, appDir, pkgDir } = mkWorkspace();
  // Dev command: node process that prints a tag, then sleeps forever.
  fs.writeFileSync(
    path.join(appDir, "dev.js"),
    [
      "console.log('BOOT ' + Date.now());",
      "setInterval(() => {}, 60_000);",
    ].join("\n"),
  );
  const cli = spawnCli(appDir, ["node", "dev.js"]);
  try {
    await cli.onStdout("BOOT ");
    const firstBoot = cli.stdout.match(/BOOT (\d+)/)?.[1];
    assert.ok(firstBoot, "first boot line");

    // Give watcher a beat to attach.
    await wait(300);

    // Touch a file in the dep.
    fs.writeFileSync(
      path.join(pkgDir, "index.js"),
      `module.exports = ${Date.now()};\n`,
    );

    // Wait for a second BOOT line.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`no restart; stdout=${cli.stdout}`)),
        10_000,
      );
      const poll = setInterval(() => {
        const all = cli.stdout.match(/BOOT \d+/g) ?? [];
        if (all.length >= 2) {
          clearTimeout(t);
          clearInterval(poll);
          resolve();
        }
      }, 100);
    });
  } finally {
    await cli.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
