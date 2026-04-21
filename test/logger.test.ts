import assert from "node:assert/strict";
import test from "node:test";
import { createLogger } from "../src/logger";

function withNoColor<T>(fn: () => T): T {
  const prev = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    return fn();
  } finally {
    if (prev === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = prev;
    }
  }
}

test("quiet mode: info has tag only (no level prefix)", () => {
  withNoColor(() => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      createLogger({ verbose: false }).info("hello");
    } finally {
      console.error = orig;
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[monoripple\] hello$/);
  });
});

test("verbose mode: plain output includes ISO time and INFO", () => {
  withNoColor(() => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      createLogger({ verbose: true }).info("hello");
    } finally {
      console.error = orig;
    }
    assert.equal(lines.length, 1);
    assert.match(
      lines[0],
      /^\d{2}:\d{2}:\d{2}\.\d{3} \[monoripple\] INFO hello$/,
    );
  });
});

test("quiet mode: warn still shows level", () => {
  withNoColor(() => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      createLogger({ verbose: false }).warn("careful");
    } finally {
      console.error = orig;
    }
    assert.match(lines[0], /^\[monoripple\] WARN careful$/);
  });
});

test("debug is silent when not verbose", () => {
  withNoColor(() => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      createLogger({ verbose: false }).debug("nope");
    } finally {
      console.error = orig;
    }
    assert.equal(lines.length, 0);
  });
});
