#!/usr/bin/env node
// Reap orphaned embedded-Postgres test clusters.
//
// Every embedded test cluster is created with `mkdtempSync(path.join(os.tmpdir(),
// prefix))`, so a leaked cluster's data directory is always a *direct child of the
// OS temp directory*. That is the discriminator this script keys on: it only ever
// targets a postgres process whose `-D` data directory sits directly under
// `os.tmpdir()`. A real, operator-installed PostgreSQL keeps its cluster in its
// own installation directory (for example `C:\Program Files\PostgreSQL\17\data`)
// and is never matched, so running this is safe on a developer machine that also
// hosts a real database.
//
// Why this exists: `cleanup()` in `test-embedded-postgres.ts` runs from vitest's
// afterAll hook, which never runs when a run is interrupted (Ctrl-C, a killed
// shell, a crashed runner). On Windows the postgres grandchild then survives its
// parent. A single interrupted run leaves one cluster behind; a few dozen
// interrupted runs leave a hundred postgres processes competing for CPU, and the
// next run's own `beforeAll` boot cannot finish inside the hook timeout.
//
// **This is a manual diagnostic and recovery tool.** Nothing invokes it: there is
// no package.json script, no CI step, and no caller in the test path. A human runs
// it when they suspect leaked clusters. It is deliberately not wired into the test
// path, because it cannot tell an *orphaned* cluster from one belonging to a suite
// that is still running elsewhere on the machine — the postgres command line names
// its data directory but not its owning vitest process. Killing on sight would
// sabotage a concurrent run in another checkout.
//
// Run it with `--force` to actually stop clusters; the default is report-only.
// Report-only is the default for the reason above: this prints what it found and
// leaves the decision to whoever ran it.
//
// The pure parts (command-line parsing, the temp-directory discriminator, and
// candidate de-duplication) are exported and covered by
// `reap-embedded-test-postgres.test.mjs`; every process side effect stays behind
// the `main()` guard at the bottom.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `realpath` on both sides, because a plain `path.resolve` comparison is not the
 * same string on every machine. Windows hands some processes an 8.3 short TEMP
 * path (`C:\Users\RUNNER~1\AppData\Local\Temp`) while the command line of the
 * postgres process it spawned may carry the long form, so comparing resolved paths
 * without canonicalising silently matched nothing and this script reported 0
 * forever. The native implementation is preferred because it also collapses
 * letter case on Windows; `fs.realpathSync` alone does not. A directory that does
 * not exist cannot be realpath'd; fall back to the resolved form, which
 * `isEmbeddedTestDataDir` rejects anyway because it checks existence.
 */
function canonical(pathToCanonicalize) {
  try {
    if (fs.realpathSync.native) return fs.realpathSync.native(pathToCanonicalize);
    return fs.realpathSync(pathToCanonicalize);
  } catch {
    return path.resolve(pathToCanonicalize);
  }
}

const TEMP_ROOT = canonical(os.tmpdir());

/**
 * A postgres command line carries its data directory after `-D`. Only accept a
 * directory that is a direct child of the temp root, which is the only shape
 * `mkdtempSync(path.join(os.tmpdir(), prefix))` can produce.
 */
export function isEmbeddedTestDataDir(dataDir, tempRoot = TEMP_ROOT) {
  if (!dataDir) return false;
  const resolved = canonical(dataDir);
  if (path.dirname(resolved) !== tempRoot) return false;
  return fs.existsSync(resolved);
}

/**
 * The `-D` value may be quoted (`-D "C:\Path With Spaces\pgdata"`) or bare
 * (`-D C:\pgdata`), including the no-space form `-DC:\pgdata`.
 */
export function parseDataDir(commandLine) {
  if (!commandLine) return null;
  const match = /-D\s*(?:"([^"]+)"|(\S+))/.exec(commandLine);
  if (!match) return null;
  return (match[1] ?? match[2] ?? "").trim() || null;
}

/**
 * One data directory can own several PIDs. On Windows there is no `fork()`, so
 * every backend is spawned with the *same* command line and each one names the
 * same `-D` directory; counting PIDs as clusters therefore reported nonsense such
 * as "stopped 1 of 2 orphaned test cluster(s)" for a single directory. Group by
 * canonical data directory so one directory is one cluster, and keep the extra
 * PIDs for reporting — `taskkill /T` already takes the whole tree, so they are
 * expected, not a surprise.
 */
export function dedupeClusterCandidates(candidates) {
  const byDataDir = new Map();
  for (const { pid, dataDir } of candidates) {
    const key = canonical(dataDir);
    const cluster = byDataDir.get(key);
    if (cluster) cluster.pids.push(pid);
    else byDataDir.set(key, { dataDir: key, pids: [pid] });
  }
  return [...byDataDir.values()];
}

/** Full candidate set for a list of `{ pid, commandLine }` rows. */
export function clusterCandidatesFor(processes, tempRoot = TEMP_ROOT) {
  const candidates = [];
  for (const { pid, commandLine } of processes) {
    const dataDir = parseDataDir(commandLine);
    if (!dataDir || !isEmbeddedTestDataDir(dataDir, tempRoot)) continue;
    candidates.push({ pid, dataDir: canonical(dataDir) });
  }
  return dedupeClusterCandidates(candidates);
}

function listPostgresProcesses() {
  if (process.platform === "win32") {
    // CIM gives the full command line, which `tasklist` does not. The
    // ObjectIdentifier is the PID; matching on ImageName alone would also catch
    // the client's `psql`, which is why the filter is deliberately narrow.
    const script =
      "Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\" " +
      "| Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
    const stdout = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    const parsed = stdout.trim() ? JSON.parse(stdout) : [];
    return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
      pid: Number(row.ProcessId),
      commandLine: row.CommandLine ?? "",
    }));
  }

  const stdout = execFileSync("ps", ["-A", "-o", "pid=,args="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /postgres/.test(line))
    .map((line) => {
      const match = /^(\d+)\s+(.*)$/.exec(line);
      return { pid: Number(match?.[1] ?? 0), commandLine: match?.[2] ?? "" };
    })
    .filter((row) => row.pid > 0);
}

/**
 * Kill one process tree. On win32 this is an unconditional
 * `taskkill /T /F` — there is no graceful step, because `taskkill` has no
 * signal semantics; on posix the caller passes SIGTERM first and SIGKILL as the
 * fallback. Returns whether the kill was accepted.
 */
function killPid(pid, signal) {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
      return true;
    }
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function stopCluster(cluster) {
  // One kill per directory. `taskkill /T` takes the whole process tree, which is
  // the extra backends sharing this `-D`; if it is refused, fall back to the
  // remaining PIDs so a partially-orphaned directory is still reclaimed.
  for (const pid of cluster.pids) {
    if (killPid(pid, "SIGTERM")) return { stopped: true, stoppedPid: pid };
  }
  for (const pid of cluster.pids) {
    if (killPid(pid, "SIGKILL")) return { stopped: true, stoppedPid: pid };
  }
  return { stopped: false, stoppedPid: null };
}

function reap({ force = false } = {}) {
  const clusters = clusterCandidatesFor(listPostgresProcesses());

  if (!force) {
    for (const { dataDir, pids } of clusters)
      process.stdout.write(
        `embedded-postgres reaper: ${pids.length} pid(s) [${pids.join(", ")}] are serving ${dataDir} (report-only; pass --force to stop it)\n`,
      );
    return { stopped: 0, found: clusters.length, extraPids: 0, removedDirs: 0 };
  }

  let stopped = 0;
  let extraPids = 0;
  const reclaimedDirs = [];
  for (const cluster of clusters) {
    const { stopped: didStop } = stopCluster(cluster);
    if (!didStop) continue;
    stopped += 1;
    // Everything else under this directory is expected: same `-D`, same command
    // line, no `fork()` on Windows. Counted, not chased.
    extraPids += cluster.pids.length - 1;
    reclaimedDirs.push(cluster.dataDir);
  }

  let removedDirs = 0;
  for (const dir of reclaimedDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      removedDirs += 1;
    } catch {
      // A cluster that is still shutting down may hold the directory. Leaving it
      // is harmless; the next run reaps it.
    }
  }

  return { stopped, found: clusters.length, extraPids, removedDirs };
}

function main() {
  let result;
  try {
    result = reap({ force: process.argv.includes("--force") });
  } catch (error) {
    process.stdout.write(
      `embedded-postgres reaper skipped: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return;
  }
  if (result.stopped > 0) {
    process.stdout.write(
      `embedded-postgres reaper: stopped ${result.stopped} of ${result.found} orphaned test data dir(s), reclaimed ${result.removedDirs} dir(s).`,
    );
    // The extra PIDs are reported rather than counted as clusters: on Windows
    // they are the other backends of the same data directory, killed by the
    // `/T` tree kill.
    process.stdout.write(
      result.extraPids > 0
        ? ` ${result.extraPids} further backend pid(s) shared those directories and went with them.\n`
        : "\n",
    );
  }
}

// Only run when invoked as a script. Importing this module (from the test) must
// not enumerate or kill anything.
if (
  process.argv[1] &&
  canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url))
) {
  main();
}

export { TEMP_ROOT, reap };