import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Every suite here boots its own embedded Postgres cluster in beforeAll and
    // tears it down in afterAll, so the box is only as fast as one boot. Vitest's
    // defaults run files in parallel and allow a 20s hook / 5s test budget, which
    // is not a budget this cost class can meet: `client.test.ts` legitimately takes
    // minutes replaying migrations, and a parallel boot starves the others into
    // phantom "Hook timed out" failures that look like product bugs.
    //
    // These values mirror the reasoning already documented in
    // `server/vitest.config.ts`: serialize the files, and give the boot/teardown
    // hooks and the slow tests enough room that a busy machine still passes. The
    // hook ceiling sits above EMBEDDED_POSTGRES_TEST_TIMEOUT_MS (90s) in
    // ./src/test-embedded-postgres.ts, which is that module's own documented
    // budget for a start. Note that a project-level value here wins over any
    // `--hook-timeout` flag on the command line — see the note in
    // scripts/run-vitest-stable.mjs before changing either number.
    //
    // `testTimeout` is 120000 rather than something larger because it is a
    // ceiling, not a budget: the slowest test observed here (`client.test.ts`,
    // which replays every migration) needs about a third of that, and a bigger
    // number only turns a hang into a five-minute wait instead of a two-minute
    // one. The boot cost lives in `hookTimeout`, which is the one that matters.
    pool: "forks",
    maxWorkers: 1,
    minWorkers: 1,
    maxConcurrency: 1,
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    hookTimeout: 180000,
    teardownTimeout: 30000,
    testTimeout: 120000,
    isolate: true,
  },
});
