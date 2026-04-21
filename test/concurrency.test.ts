import assert from "node:assert/strict";
import test from "node:test";
import { groupIntoLevels, runPool } from "../src/concurrency";

test("runPool respects concurrency limit and runs all items", async () => {
  let inflight = 0;
  let maxInflight = 0;
  const done: number[] = [];
  await runPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
    inflight++;
    if (inflight > maxInflight) maxInflight = inflight;
    await new Promise((r) => setTimeout(r, 20));
    inflight--;
    done.push(n);
  });
  assert.equal(done.length, 6);
  assert.ok(maxInflight <= 2, `maxInflight=${maxInflight}`);
});

test("groupIntoLevels: leaves in level 0, parents above", () => {
  // a → b → c (a depends on b depends on c)
  const order = ["c", "b", "a"];
  const deps = new Map<string, Set<string>>([
    ["a", new Set(["b"])],
    ["b", new Set(["c"])],
    ["c", new Set()],
  ]);
  const levels = groupIntoLevels(order, deps);
  assert.deepEqual(levels[0], ["c"]);
  assert.deepEqual(levels[1], ["b"]);
  assert.deepEqual(levels[2], ["a"]);
});

test("groupIntoLevels: independent nodes share a level", () => {
  const order = ["x", "y", "z"];
  const deps = new Map<string, Set<string>>([
    ["x", new Set()],
    ["y", new Set()],
    ["z", new Set(["x", "y"])],
  ]);
  const levels = groupIntoLevels(order, deps);
  assert.deepEqual(levels[0].sort(), ["x", "y"]);
  assert.deepEqual(levels[1], ["z"]);
});

test("runPool surfaces the first error", async () => {
  await assert.rejects(
    () =>
      runPool([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
      }),
    /boom/,
  );
});
