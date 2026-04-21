import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  computeInputHash,
  readLastHash,
  writeHash,
  clearHash,
} from "../src/build-cache";

test("computeInputHash is stable for identical content and differs on edit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ww-bc-"));
  try {
    fs.writeFileSync(path.join(root, "a.ts"), "hello");
    fs.writeFileSync(path.join(root, "b.ts"), "world");
    const h1 = computeInputHash(root, "pnpm build");
    const h2 = computeInputHash(root, "pnpm build");
    assert.equal(h1, h2);
    fs.writeFileSync(path.join(root, "a.ts"), "hello!");
    const h3 = computeInputHash(root, "pnpm build");
    assert.notEqual(h1, h3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("computeInputHash ignores node_modules + dist", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ww-bc2-"));
  try {
    fs.writeFileSync(path.join(root, "src.ts"), "x");
    const h1 = computeInputHash(root, "pnpm build");
    fs.mkdirSync(path.join(root, "node_modules", "junk"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "junk", "f"), "noise");
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "dist", "out.js"), "ignored");
    const h2 = computeInputHash(root, "pnpm build");
    assert.equal(h1, h2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("read/write/clear hash roundtrip", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ww-bc3-"));
  try {
    assert.equal(readLastHash(root, "k"), null);
    writeHash(root, "k", "abc");
    assert.equal(readLastHash(root, "k"), "abc");
    clearHash(root, "k");
    assert.equal(readLastHash(root, "k"), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("different commands produce different hashes for same inputs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ww-bc4-"));
  try {
    fs.writeFileSync(path.join(root, "a.ts"), "hello");
    const h1 = computeInputHash(root, "pnpm build");
    const h2 = computeInputHash(root, "pnpm compile");
    assert.notEqual(h1, h2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
