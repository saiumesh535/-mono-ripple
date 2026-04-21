import assert from "node:assert/strict";
import test from "node:test";
import { createChangeAccumulator } from "../src/change-accumulator";

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("coalesces rapid pushes into one burst with unique paths", async () => {
  const bursts: { paths: string[]; first: string }[] = [];
  const acc = createChangeAccumulator({
    debounceMs: 40,
    onBurst: (b) => bursts.push(b),
  });
  acc.push("/a/x.ts");
  acc.push("/a/y.ts");
  acc.push("/a/x.ts"); // duplicate
  await wait(70);
  assert.equal(bursts.length, 1);
  assert.equal(bursts[0].first, "/a/x.ts");
  assert.deepEqual(bursts[0].paths.sort(), ["/a/x.ts", "/a/y.ts"]);
});

test("separate bursts when quiet window elapses", async () => {
  const bursts: { paths: string[] }[] = [];
  const acc = createChangeAccumulator({
    debounceMs: 30,
    onBurst: (b) => bursts.push(b),
  });
  acc.push("/a");
  await wait(60);
  acc.push("/b");
  await wait(60);
  assert.equal(bursts.length, 2);
});

test("pause suppresses emission and drops buffer", async () => {
  const bursts: { paths: string[] }[] = [];
  const acc = createChangeAccumulator({
    debounceMs: 20,
    onBurst: (b) => bursts.push(b),
  });
  acc.push("/a");
  acc.setPaused(true);
  await wait(40);
  assert.equal(bursts.length, 0);
  acc.setPaused(false);
  acc.push("/b");
  await wait(40);
  assert.equal(bursts.length, 1);
  assert.deepEqual(bursts[0].paths, ["/b"]);
});
