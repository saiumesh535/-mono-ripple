import assert from "node:assert/strict";
import test from "node:test";
import { validateConfig, ConfigValidationError } from "../src/config-schema";

test("command required", () => {
  assert.throws(
    () => validateConfig("c.json", {}),
    (e: unknown) =>
      e instanceof ConfigValidationError &&
      e.issues.some((i) => i.includes('"command": required')),
  );
});

test("command accepts string or non-empty array", () => {
  const a = validateConfig("c.json", { command: "npm run dev" });
  assert.equal(a.command, "npm run dev");
  const b = validateConfig("c.json", { command: ["pnpm", "dev"] });
  assert.deepEqual(b.command, ["pnpm", "dev"]);
});

test("command rejects empty string and empty array", () => {
  assert.throws(() => validateConfig("c.json", { command: "" }), ConfigValidationError);
  assert.throws(() => validateConfig("c.json", { command: [] }), ConfigValidationError);
});

test("debounce must be integer in range", () => {
  assert.throws(
    () => validateConfig("c.json", { command: "x", debounce: -5 }),
    ConfigValidationError,
  );
  assert.throws(
    () => validateConfig("c.json", { command: "x", debounce: 99999 }),
    ConfigValidationError,
  );
  const ok = validateConfig("c.json", { command: "x", debounce: 250 });
  assert.equal(ok.debounce, 250);
});

test("before accepts string or array", () => {
  const a = validateConfig("c.json", { command: "x", before: "pnpm build" });
  assert.equal(a.before, "pnpm build");
  const b = validateConfig("c.json", { command: "x", before: ["pnpm", "build"] });
  assert.deepEqual(b.before, ["pnpm", "build"]);
});

test("unknown root fields are reported", () => {
  assert.throws(
    () => validateConfig("c.json", { command: "x", nonsense: 1 }),
    (e: unknown) =>
      e instanceof ConfigValidationError &&
      e.issues.some((i) => i.includes('unknown field "nonsense"')),
  );
});

test("packages[].customBuild accepts array form", () => {
  const c = validateConfig("c.json", {
    command: "x",
    packages: { "pkg-a": { customBuild: ["pnpm", "-F", "pkg-a", "build"] } },
  });
  assert.deepEqual(c.packages?.["pkg-a"].customBuild, [
    "pnpm",
    "-F",
    "pkg-a",
    "build",
  ]);
});

test("packages[].customBuildCwd validated to literal", () => {
  assert.throws(
    () =>
      validateConfig("c.json", {
        command: "x",
        packages: { "pkg-a": { customBuild: "pnpm build", customBuildCwd: "nope" } },
      }),
    ConfigValidationError,
  );
});

test("$schema field is allowed", () => {
  const ok = validateConfig("c.json", {
    $schema: "./schema.json",
    command: "x",
  });
  assert.equal(ok.command, "x");
});
