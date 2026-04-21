import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, type WatchEvent } from "../src/events";

test("createEventBus: typed subscribe + wildcard", () => {
  const bus = createEventBus();
  const got: string[] = [];
  bus.on("build:start", (e) => got.push(`specific ${e.type}`));
  bus.on("*", (e) => got.push(`any ${e.type}`));
  const e: WatchEvent = {
    type: "build:start",
    ts: 1,
    pkg: "x",
    command: "cmd",
  };
  bus.emit(e);
  bus.emit({ type: "shutdown", ts: 2 });
  assert.deepEqual(got, ["specific build:start", "any build:start", "any shutdown"]);
});

test("createEventBus: handler error is swallowed", () => {
  const bus = createEventBus();
  bus.on("shutdown", () => {
    throw new Error("boom");
  });
  // Should not throw.
  bus.emit({ type: "shutdown", ts: 1 });
});

test("createEventBus: unsubscribe", () => {
  const bus = createEventBus();
  let count = 0;
  const off = bus.on("shutdown", () => count++);
  bus.emit({ type: "shutdown", ts: 1 });
  off();
  bus.emit({ type: "shutdown", ts: 2 });
  assert.equal(count, 1);
});
