import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { loadGitignore } from "../src/ignore";

test("loadGitignore: basic patterns and negation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ww-gi-"));
  try {
    fs.writeFileSync(
      path.join(dir, ".gitignore"),
      ["*.log", "!keep.log", "generated/", "node_modules"].join("\n"),
    );
    const m = loadGitignore([path.join(dir, ".gitignore")]);
    assert.equal(m.ignores(path.join(dir, "a.log")), true);
    assert.equal(m.ignores(path.join(dir, "keep.log")), false);
    assert.equal(m.ignores(path.join(dir, "generated"), true), true);
    assert.equal(m.ignores(path.join(dir, "node_modules/pkg/x.js")), true);
    assert.equal(m.ignores(path.join(dir, "src/main.ts")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadGitignore: anchored leading /", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ww-gi2-"));
  try {
    fs.writeFileSync(path.join(dir, ".gitignore"), "/build\n");
    const m = loadGitignore([path.join(dir, ".gitignore")]);
    assert.equal(m.ignores(path.join(dir, "build/x")), true);
    assert.equal(m.ignores(path.join(dir, "sub/build/x")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
