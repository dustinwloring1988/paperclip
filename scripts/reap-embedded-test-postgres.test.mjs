import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clusterCandidatesFor,
  dedupeClusterCandidates,
  isEmbeddedTestDataDir,
  parseDataDir,
} from "./reap-embedded-test-postgres.mjs";

const TEMP_ROOT = fs.realpathSync(os.tmpdir());
// A direct child of the temp root that exists, matching what mkdtempSync creates.
const embeddedDir = fs.mkdtempSync(path.join(TEMP_ROOT, "reaper-fixture-"));
// A real path inside, but not a direct child of the temp root.
const nestedDir = path.join(embeddedDir, "nested");
fs.mkdirSync(nestedDir);

test.after(() => {
  fs.rmSync(embeddedDir, { recursive: true, force: true });
});

test("parses the -D data directory from a real postmaster command line", () => {
  assert.equal(
    parseDataDir(
      '"C:\\Program Files\\PostgreSQL\\17\\bin\\postgres.exe" -D C:\\Users\\dev\\AppData\\Local\\Temp\\paperclip-abc123 -p 54321',
    ),
    "C:\\Users\\dev\\AppData\\Local\\Temp\\paperclip-abc123",
  );
  assert.equal(
    parseDataDir(
      '/usr/lib/postgresql/17/bin/postgres -D /var/folders/xy/T/paperclip-embedded-postgres-retry-recover-abc -p 5432',
    ),
    "/var/folders/xy/T/paperclip-embedded-postgres-retry-recover-abc",
  );
  // A quoted Windows path containing spaces, and the no-space `-D<path>` form.
  assert.equal(
    parseDataDir('"C:\\Program Files\\PostgreSQL\\17\\bin\\postgres.exe" -D "C:\\Users\\dev\\App Data\\Local\\Temp\\paperclip-def456" -p 54321'),
    "C:\\Users\\dev\\App Data\\Local\\Temp\\paperclip-def456",
  );
  assert.equal(
    parseDataDir(`postgres.exe -D${embeddedDir} -p 54321`),
    embeddedDir,
  );
  // No -D at all, and empty input, are both "not a cluster we can identify".
  assert.equal(parseDataDir("postgres.exe -p 54321"), null);
  assert.equal(parseDataDir(""), null);
  assert.equal(parseDataDir(undefined), null);
});

test("accepts only a direct child of the temp root that exists", () => {
  assert.equal(isEmbeddedTestDataDir(embeddedDir, TEMP_ROOT), true);
  // A path outside tmpdir — a real installed cluster — is never matched.
  assert.equal(isEmbeddedTestDataDir("C:\\Program Files\\PostgreSQL\\17\\data", TEMP_ROOT), false);
  assert.equal(isEmbeddedTestDataDir(path.dirname(TEMP_ROOT), TEMP_ROOT), false);
  // Inside tmpdir but not a direct child of it.
  assert.equal(isEmbeddedTestDataDir(nestedDir, TEMP_ROOT), false);
  // A direct child that does not exist.
  assert.equal(isEmbeddedTestDataDir(path.join(TEMP_ROOT, "reaper-not-here-xyz"), TEMP_ROOT), false);
});

test("normalises the temp path so a different spelling of the same path still matches", () => {
  // `path.resolve` alone is not enough. Windows can hand this process an 8.3 short
  // TEMP path (`C:\Users\RUNNER~1\AppData\Local\Temp`) while a postgres command
  // line carries the long form, and comparing the two resolved strings silently
  // matched nothing. `realpath` collapses either difference — case on Windows,
  // redundant segments anywhere — so one spelling can never become two clusters.
  const longDir = fs.mkdtempSync(path.join(TEMP_ROOT, "reaper-realpath-check-"));
  const alternateSpelling =
    process.platform === "win32"
      ? path.join(fs.realpathSync.native(TEMP_ROOT).toUpperCase(), path.basename(longDir))
      : path.join(TEMP_ROOT, ".", path.basename(longDir));
  assert.notEqual(alternateSpelling, longDir);
  assert.equal(isEmbeddedTestDataDir(alternateSpelling, TEMP_ROOT), true);
  // Same directory reached by two spellings collapses to one cluster.
  const [cluster] = dedupeClusterCandidates([
    { pid: 10, dataDir: longDir },
    { pid: 11, dataDir: alternateSpelling },
  ]);
  assert.deepEqual(cluster, { dataDir: longDir, pids: [10, 11] });
  fs.rmSync(longDir, { recursive: true, force: true });
});

test("dedupes PIDs that share one data directory into one cluster", () => {
  // On Windows there is no fork(): every backend is spawned with the same command
  // line, so one directory yields N PIDs. Counting PIDs as clusters is what made
  // the summary read "stopped 1 of 2 orphaned test cluster(s)" for one directory.
  const clusters = clusterCandidatesFor([
    { pid: 100, commandLine: `postgres.exe -D "${embeddedDir}" -p 54321` },
    { pid: 101, commandLine: `postgres.exe -D "${embeddedDir}" -p 54321` },
    { pid: 102, commandLine: `postgres.exe -D "${embeddedDir}" -p 54321` },
  ], TEMP_ROOT);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0], { dataDir: embeddedDir, pids: [100, 101, 102] });
});

test("keeps separate directories separate and drops non-embedded processes", () => {
  const other = fs.mkdtempSync(path.join(TEMP_ROOT, "reaper-fixture-2-"));
  try {
    const clusters = clusterCandidatesFor([
      { pid: 200, commandLine: `postgres.exe -D "${embeddedDir}"` },
      { pid: 201, commandLine: `postgres.exe -D "${other}"` },
      { pid: 202, commandLine: `postgres.exe -D "${nestedDir}"` },
      { pid: 203, commandLine: `postgres.exe -D "C:\\Program Files\\PostgreSQL\\17\\data"` },
      { pid: 204, commandLine: "psql.exe -d mydb" },
      { pid: 205, commandLine: `postgres.exe -D "${path.join(TEMP_ROOT, "reaper-gone-xyz")}"` },
    ], TEMP_ROOT);
    assert.equal(clusters.length, 2);
    assert.deepEqual(
      clusters.map((cluster) => cluster.dataDir).sort(),
      [embeddedDir, other].sort(),
    );
    assert.deepEqual(clusters.find((cluster) => cluster.dataDir === embeddedDir).pids, [200]);
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});