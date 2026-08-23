import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { installGracefulShutdown } from "../src/graceful-shutdown.js";

test("graceful shutdown closes once and removes both signal handlers", async () => {
  const signals = new EventEmitter();
  let closeCount = 0;
  let release: (() => void) | undefined;
  const closing = new Promise<void>((resolve) => {
    release = resolve;
  });
  installGracefulShutdown(signals, async () => {
    closeCount += 1;
    await closing;
  });

  signals.emit("SIGTERM");
  signals.emit("SIGINT");
  assert.equal(closeCount, 1);
  release?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signals.listenerCount("SIGTERM"), 0);
  assert.equal(signals.listenerCount("SIGINT"), 0);
});

test("graceful shutdown reports close failures", async () => {
  const signals = new EventEmitter();
  let reported: unknown;
  installGracefulShutdown(
    signals,
    async () => {
      throw new Error("close failed");
    },
    (error) => {
      reported = error;
    }
  );
  signals.emit("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(String(reported), /close failed/u);
});

