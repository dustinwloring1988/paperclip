import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  __embeddedPostgresLifecycleForTests as lifecycle,
  __embeddedPostgresStartMaxAttemptsForTests as MAX_ATTEMPTS,
  __setEmbeddedPostgresCtorProviderForTests,
  __startEmbeddedPostgresWithRetryForTests as startWithRetry,
} from "./test-embedded-postgres.js";

// A fake embedded-postgres constructor. It records every constructed instance so
// the test can assert the retry uses a fresh port and a fresh data directory each
// attempt. `start()` emits the same output the real cluster writes for a port
// conflict, then rejects with an empty message (the real rejection shape). The
// option type matches the real constructor so no type cast is needed.
type FakeOptions = {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
};

const BIND_CONFLICT_LOG = 'could not bind IPv4 address "127.0.0.1": Address already in use';

function makeFakeCtor(failFirst: number) {
  const constructed: FakeOptions[] = [];
  let started = 0;

  class FakeEmbeddedPostgres {
    private readonly options: FakeOptions;
    stopCalls = 0;
    constructor(options: FakeOptions) {
      this.options = options;
      constructed.push(options);
    }
    async initialise(): Promise<void> {}
    async start(): Promise<void> {
      started += 1;
      if (started <= failFirst) {
        // Mirror the real failure: Postgres logs the reason, then `start()`
        // rejects with an Error whose message is empty.
        this.options.onLog?.(BIND_CONFLICT_LOG);
        throw new Error();
      }
    }
    async stop(): Promise<void> {
      this.stopCalls += 1;
    }
  }

  return { ctor: FakeEmbeddedPostgres, constructed };
}

describe("startEmbeddedPostgresWithRetry", () => {
  afterEach(() => {
    __setEmbeddedPostgresCtorProviderForTests(null);
  });

  it("recovers from a transient port conflict and returns on a later attempt", async () => {
    const { ctor, constructed } = makeFakeCtor(2);
    __setEmbeddedPostgresCtorProviderForTests(async () => ctor);

    const started = await startWithRetry("paperclip-retry-recover-");

    // The first two attempts fail, the third succeeds.
    expect(constructed).toHaveLength(3);

    // Each attempt uses a fresh data directory. The two failed directories are
    // removed. The returned directory still exists.
    const dataDirs = constructed.map((options) => options.databaseDir);
    expect(new Set(dataDirs).size).toBe(3);
    expect(fs.existsSync(dataDirs[0])).toBe(false);
    expect(fs.existsSync(dataDirs[1])).toBe(false);
    expect(started.dataDir).toBe(dataDirs[2]);
    expect(fs.existsSync(started.dataDir)).toBe(true);

    // Each attempt allocates a port.
    for (const options of constructed) {
      expect(Number.isInteger(options.port)).toBe(true);
      expect(options.port).toBeGreaterThan(0);
    }

    // Clean up the returned attempt.
    await started.instance.stop();
    fs.rmSync(started.dataDir, { recursive: true, force: true });
  });

  it("throws with the real Postgres output after the attempt bound", async () => {
    const { ctor, constructed } = makeFakeCtor(Number.POSITIVE_INFINITY);
    __setEmbeddedPostgresCtorProviderForTests(async () => ctor);

    await expect(startWithRetry("paperclip-retry-fail-")).rejects.toThrow(/after \d+ attempts/);

    // The retry stops at the bound and does not loop forever.
    expect(constructed).toHaveLength(MAX_ATTEMPTS);

    // Every failed attempt removes its data directory.
    for (const options of constructed) {
      expect(fs.existsSync(options.databaseDir)).toBe(false);
    }
  });

  it("keeps the real failure reason instead of a generic fallback", async () => {
    const { ctor } = makeFakeCtor(Number.POSITIVE_INFINITY);
    __setEmbeddedPostgresCtorProviderForTests(async () => ctor);

    const error = await startWithRetry("paperclip-retry-reason-").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    // The thrown message carries the captured Postgres output, not only the
    // generic "embedded Postgres startup failed" text.
    expect((error as Error).message).toContain("Address already in use");
  });

  it("does not grow the live-cluster set or the exit listener across start/stop cycles", async () => {
    // Every cluster this module starts is tracked for exit cleanup, and the
    // cleanup runs on both the signal path and `exit`. Two properties have to hold
    // no matter how many times a suite starts and stops a cluster: the set must
    // not accumulate, and the process must not accumulate `exit` listeners (which
    // would eventually trip vitest's MaxListeners warning).
    const exitListenersBefore = process.listenerCount("exit");
    const liveBefore = lifecycle.liveClusterCount();
    const exitListenerCounts: number[] = [];

    for (const attempt of [1, 2, 3]) {
      const { ctor } = makeFakeCtor(0);
      __setEmbeddedPostgresCtorProviderForTests(async () => ctor);
      const started = await startWithRetry(`paperclip-cycle-${attempt}-`);
      // A running cluster is tracked, exactly one entry more than before.
      expect(lifecycle.liveClusterCount()).toBe(liveBefore + 1);
      // Repeated starts install the cleanup once, not once per cluster. The
      // baseline may already include an install from an earlier test in this file,
      // so the assertion is that the count never moves again.
      exitListenerCounts.push(lifecycle.exitListenerCount());
      expect(lifecycle.exitListenerCount()).toBeLessThanOrEqual(exitListenersBefore + 1);

      await started.instance.stop();
      fs.rmSync(started.dataDir, { recursive: true, force: true });
      // Releasing is what a caller's `cleanup()` does after its stop settles.
      lifecycle.releaseLiveCluster(started.instance);
      expect(lifecycle.liveClusterCount()).toBe(liveBefore);
    }

    expect(new Set(exitListenerCounts).size).toBe(1);
    __setEmbeddedPostgresCtorProviderForTests(null);
  });

  it("issues one stop per cluster even when the exit path runs twice", async () => {
    // On `exit` there is no event loop, and on SIGINT the handler re-raises
    // immediately, so `stop()` never settles and the guard that clears the
    // internal handle never runs. Without an explicit idempotence marker the
    // second pass would issue a second `taskkill` for an already-dying pid.
    const { ctor } = makeFakeCtor(0);
    __setEmbeddedPostgresCtorProviderForTests(async () => ctor);
    const started = await startWithRetry("paperclip-idempotent-stop-");

    lifecycle.stopAllLiveClusters();
    lifecycle.stopAllLiveClusters();
    lifecycle.stopAllLiveClusters();

    const instance = started.instance as unknown as { stopCalls: number };
    expect(instance.stopCalls).toBe(1);

    lifecycle.releaseLiveCluster(started.instance);
    fs.rmSync(started.dataDir, { recursive: true, force: true });
    __setEmbeddedPostgresCtorProviderForTests(null);
  });
});
