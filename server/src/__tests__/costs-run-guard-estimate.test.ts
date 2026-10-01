import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { costService } from "../services/costs.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Run guard estimate test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

// The estimate read is the one thing in claimQueuedRun that must never be able
// to stop a run. To prove that, the failure has to be injectable: no real
// database condition makes estimateRunCost throw while leaving the rest of the
// claim path healthy. estimateRunCost is the only method replaced here, and the
// default path delegates to the real implementation, so the passing tests in
// this file exercise the real estimator.
const estimateControl = vi.hoisted(() => ({ throwOnEstimate: false }));

vi.mock("../services/costs.ts", async () => {
  const actual = await vi.importActual<typeof import("../services/costs.ts")>("../services/costs.ts");
  return {
    ...actual,
    costService: (db: never, hooks: never) => {
      const service = actual.costService(db, hooks);
      return {
        ...service,
        estimateRunCost: async (...args: Parameters<typeof actual.costService> extends never ? never : [string, string, unknown?]) => {
          if (estimateControl.throwOnEstimate) {
            throw new Error("per-run spend distribution unavailable");
          }
          return service.estimateRunCost(args[0], args[1], args[2]);
        },
      };
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run cost estimate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

describeEmbeddedPostgres("run cost estimate", () => {
  let db!: ReturnType<typeof createDb>;
  let costs!: ReturnType<typeof costService>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  // A single instant every seeded cost timestamp and every explicit `now`
  // argument derives from, so a fixture cannot drift across the estimator's
  // lookback window. Anchored to the current time because the claim path reads
  // the real clock; the lookback test below pushes a run outside the window
  // explicitly rather than relying on a hardcoded date drifting out of it.
  let now!: Date;

  beforeAll(async () => {
    now = new Date();
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-cost-estimate-");
    db = createDb(tempDb.connectionString);
    costs = costService(db);
    heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    estimateControl.throwOnEstimate = false;
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Run guard estimate test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    // A run reaches its terminal status before finalizeRun finishes writing its
    // trailing events, so drain before truncating or a late write hits a
    // foreign key whose parent row is gone.
    await heartbeat.drainActiveRunExecutions();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await db.execute(sql.raw(`
          TRUNCATE TABLE
            "heartbeat_run_events",
            "heartbeat_runs",
            "agent_wakeup_requests",
            "agent_runtime_state",
            "cost_events",
            "activity_log",
            "issues",
            "agents",
            "companies"
          RESTART IDENTITY CASCADE
        `));
        return;
      } catch (error) {
        const isLateActivityRace =
          error instanceof Error &&
          error.message.includes("activity_log");
        if (!isLateActivityRace || attempt === 9) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }, 20_000);

  afterAll(async () => {
    await heartbeat.drainActiveRunExecutions();
    await tempDb?.cleanup();
  });

  async function seedCompany(name = "Estimate Co") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(
    companyId: string,
    name = "Estimate Agent",
    heartbeat: Record<string, unknown> = {},
  ) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1, ...heartbeat },
      },
      permissions: {},
    });
    return agentId;
  }

  /**
   * Completed runs that actually incurred cost. `perRunCents[i]` is the TOTAL
   * for run i, split across `eventsPerRun[i]` cost rows so a per-event
   * implementation cannot accidentally produce the same answer.
   */
  async function seedCompletedRunsWithCost(
    companyId: string,
    agentId: string,
    perRunCents: number[],
    eventsPerRun: number[] = perRunCents.map(() => 1),
    occurredAt: Date = now,
    billing: { billingType?: string; costStatus?: string } = {},
  ) {
    const runIds: string[] = [];
    const seeds: (typeof costEvents.$inferInsert)[] = [];
    for (const [index, totalCents] of perRunCents.entries()) {
      const runId = randomUUID();
      runIds.push(runId);
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "completed",
        startedAt: new Date(occurredAt.getTime() - 60_000),
        finishedAt: occurredAt,
      });
      const eventCount = Math.max(1, eventsPerRun[index] ?? 1);
      // Remainder lands on the last event so the per-run total is EXACTLY
      // totalCents. Even splitting with Math.round would drift by a cent or two
      // and the assertions below are on exact integers.
      const perEvent = Math.floor(totalCents / eventCount);
      for (let eventIndex = 0; eventIndex < eventCount; eventIndex += 1) {
        const isLast = eventIndex === eventCount - 1;
        seeds.push({
          companyId,
          agentId,
          heartbeatRunId: runId,
          provider: "openai",
          biller: "openai",
          billingType: billing.billingType ?? "metered_api",
          costStatus: billing.costStatus ?? "reported",
          model: "gpt-5",
          inputTokens: 100,
          cachedInputTokens: 0,
          outputTokens: 10,
          costCents: isLast ? totalCents - perEvent * (eventCount - 1) : perEvent,
          occurredAt: new Date(occurredAt.getTime() - 10_000 + eventIndex),
        });
      }
    }
    if (seeds.length > 0) await db.insert(costEvents).values(seeds);
    return runIds;
  }

  async function seedQueuedRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      contextSnapshot: {},
    });
    return runId;
  }

  async function readEstimatedCents(runId: string) {
    const [row] = await db
      .select({ estimatedCostCents: heartbeatRuns.estimatedCostCents })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    return row?.estimatedCostCents ?? null;
  }

  describe("estimateRunCost", () => {
    it("prices a run at the median of comparable per-run totals, not their mean", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      // Per-run totals: 100, 200, 300, 400, 1000.
      // mean = 400, p50 = 300, p90 = 400 + 0.6 * (1000 - 400) = 760.
      // The mean coincides with the median of the first four runs, so 1000 is
      // what separates the two estimators: a mean reports 400 here and a median
      // reports 300. This is the assertion that makes the estimator choice
      // testable rather than a preference.
      await seedCompletedRunsWithCost(
        companyId,
        agentId,
        [100, 200, 300, 400, 1000],
        [4, 2, 3, 4, 5],
      );

      const estimate = await costs.estimateRunCost(companyId, agentId, { now });

      expect(estimate).toEqual({
        companyId,
        agentId,
        estimatedCents: 300,
        upperBoundCents: 760,
        sampleSize: 5,
        lookbackDays: 30,
        method: "agent_run_p50_p90_billed",
      });
      expect(estimate.estimatedCents).not.toBe(400);
    });

    it("keeps an agent with no cost history at null rather than guessing zero", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Cold Start Agent");

      const estimate = await costs.estimateRunCost(companyId, agentId, { now });

      expect(estimate.estimatedCents).toBeNull();
      expect(estimate.upperBoundCents).toBeNull();
      expect(estimate.sampleSize).toBe(0);
      // The distinction the column comment warns about: null is not zero.
      expect(estimate.estimatedCents).not.toBe(0);
    });

    it("counts runs that never incurred cost as no history at all", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Never Spent Agent");
      await db.insert(heartbeatRuns).values({
        companyId,
        agentId,
        status: "completed",
        startedAt: new Date(now.getTime() - 60_000),
        finishedAt: now,
      });

      const estimate = await costs.estimateRunCost(companyId, agentId, { now });

      expect(estimate.estimatedCents).toBeNull();
      expect(estimate.sampleSize).toBe(0);
    });

    it("excludes subscription-included runs instead of pricing the agent at zero", async () => {
      // `normalizeBilledCostCents` records subscription_included spend as 0
      // because a subscription really does add nothing to the bill. That zero is
      // correct in a spend report and poison as an estimate population: three
      // such runs give p50 = 0, which is a number an operator reads as "this run
      // is free" — the one outcome that would justify no cap at all.
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Subscription Agent");
      await seedCompletedRunsWithCost(companyId, agentId, [0, 0, 0, 0], undefined, now, {
        billingType: "subscription_included",
      });

      const estimate = await costs.estimateRunCost(companyId, agentId, { now });

      expect(estimate.estimatedCents).toBeNull();
      expect(estimate.upperBoundCents).toBeNull();
      // Excluded from the population, not zeroed inside it.
      expect(estimate.sampleSize).toBe(0);
    });

    it("excludes unpriced runs, which have no cost receipt at all", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Unpriced Agent");
      await seedCompletedRunsWithCost(companyId, agentId, [500, 400, 300], undefined, now, {
        costStatus: "unpriced",
      });

      const estimate = await costs.estimateRunCost(companyId, agentId, { now });

      expect(estimate.estimatedCents).toBeNull();
      expect(estimate.sampleSize).toBe(0);
    });

    it("keeps metered history when an agent mixes subscription and metered runs", async () => {
      // The subscription runs must drop out without taking the metered ones with
      // them, otherwise a mixed agent loses its baseline entirely.
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Mixed Agent");
      await seedCompletedRunsWithCost(companyId, agentId, [0, 0], undefined, now, {
        billingType: "subscription_included",
      });
      await seedCompletedRunsWithCost(companyId, agentId, [100, 200, 300, 400]);

      const estimate = await costs.estimateRunCost(companyId, agentId, { now });

      expect(estimate.estimatedCents).toBe(250);
      expect(estimate.sampleSize).toBe(4);
    });

    it("withholds the estimate when the sample is too small to separate p50 from p90", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Thin History Agent");
      // Two runs is a range, not a distribution: p50 and p90 would just be the
      // two observations, so no estimate is reported at any confidence.
      await seedCompletedRunsWithCost(companyId, agentId, [100, 900]);

      const estimate = await costs.estimateRunCost(companyId, agentId, { now });

      expect(estimate.estimatedCents).toBeNull();
      expect(estimate.upperBoundCents).toBeNull();
      expect(estimate.sampleSize).toBe(2);
    });

    it("only counts the agent's own runs and never another company's", async () => {
      const companyId = await seedCompany("Mine");
      const otherCompanyId = await seedCompany("Theirs");
      const agentId = await seedAgent(companyId, "Mine Agent");
      const noisyAgentId = await seedAgent(companyId, "Noisy Peer");
      const otherAgentId = await seedAgent(otherCompanyId, "Their Agent");

      await seedCompletedRunsWithCost(companyId, agentId, [100, 200, 300]);
      // A peer agent's runaway must not move this agent's estimate.
      await seedCompletedRunsWithCost(companyId, noisyAgentId, [90_000]);
      // Nor may another company's spend.
      await seedCompletedRunsWithCost(otherCompanyId, otherAgentId, [90_000, 90_000, 90_000]);

      const estimate = await costs.estimateRunCost(companyId, agentId, { now });

      expect(estimate.estimatedCents).toBe(200);
      expect(estimate.sampleSize).toBe(3);
    });

    it("drops comparable runs from outside the lookback window", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);

      // Three recent runs plus one from long before the 30-day window. The stale
      // run is the most expensive, so including it would move the answer.
      await seedCompletedRunsWithCost(companyId, agentId, [100, 200, 300]);
      const staleRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: staleRunId,
        companyId,
        agentId,
        status: "completed",
        startedAt: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000),
        finishedAt: new Date(now.getTime() - 59 * 24 * 60 * 60 * 1000),
      });
      await db.insert(costEvents).values({
        companyId,
        agentId,
        heartbeatRunId: staleRunId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        costStatus: "reported",
        model: "gpt-5",
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 10,
        costCents: 500_000,
        occurredAt: new Date(now.getTime() - 59 * 24 * 60 * 60 * 1000),
      });

      const estimate = await costs.estimateRunCost(companyId, agentId, { now });

      expect(estimate.estimatedCents).toBe(200);
      expect(estimate.sampleSize).toBe(3);
    });

    it("excludes the run being priced so a re-claim cannot price itself", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const seededRunIds = await seedCompletedRunsWithCost(
        companyId,
        agentId,
        [100, 200, 300, 400, 1000],
      );
      const cheapestRunId = seededRunIds[0]!;
      const mostExpensiveRunId = seededRunIds[4]!;

      // p50 of the full five is 300.
      expect((await costs.estimateRunCost(companyId, agentId, { now })).estimatedCents).toBe(300);

      // Removing the cheapest run has to move the median UP and removing the
      // runaway has to move it DOWN. If the filter were ignored both would still
      // read 300, so this fails without the exclusion.
      expect(
        (await costs.estimateRunCost(companyId, agentId, { now, excludeRunId: cheapestRunId }))
          .estimatedCents,
      ).toBe(350);
      expect(
        (await costs.estimateRunCost(companyId, agentId, { now, excludeRunId: mostExpensiveRunId }))
          .estimatedCents,
      ).toBe(250);
      // Sample size proves the excluded row really left the population rather
      // than being zeroed in place.
      expect(
        (await costs.estimateRunCost(companyId, agentId, { now, excludeRunId: cheapestRunId }))
          .sampleSize,
      ).toBe(4);
    });
  });

  describe("estimate written at claim time", () => {
    it("stamps the estimate before execution for an agent with comparable history", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      await seedCompletedRunsWithCost(companyId, agentId, [100, 200, 300], [2, 3, 4]);

      const runId = await seedQueuedRun(companyId, agentId);
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();

      // The exact value the estimator produces for this fixture, not just a
      // truthy check. p50 of 100/200/300 is 200.
      expect(await readEstimatedCents(runId)).toBe(200);
      expect(mockAdapterExecute).toHaveBeenCalled();

      // getRun is the run-detail read model behind GET /heartbeat-runs/:runId.
      // It spreads getTableColumns(heartbeatRuns), so the column already reaches
      // an operator there with no route or OpenAPI change. Asserted so that
      // claim is verified rather than assumed: if someone later narrows that
      // projection to an allowlist, this fails.
      expect((await heartbeat.getRun(runId))?.estimatedCostCents).toBe(200);

      const estimateEvents = await db
        .select()
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId))
        .then((rows) => rows.filter((row) => row.eventType === "cost.estimate"));
      expect(estimateEvents).toHaveLength(1);
      expect(estimateEvents[0]?.payload).toMatchObject({
        estimatedCostCents: 200,
        upperBoundCents: 280,
        sampleSize: 3,
        lookbackDays: 30,
        method: "agent_run_p50_p90_billed",
      });
    });

    it("leaves the estimate null on the run for an agent with no comparable history", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Cold Start Agent");

      const runId = await seedQueuedRun(companyId, agentId);
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();

      // Asserted explicitly on the persisted row. A zero here would be a
      // fabricated baseline that later reads as "this run is free".
      expect(await readEstimatedCents(runId)).toBeNull();
      expect(await readEstimatedCents(runId)).not.toBe(0);
      // The run still executed. Cold start suppresses the number, not the work.
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    });

    it("claims and runs the work even when the distribution read throws", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      await seedCompletedRunsWithCost(companyId, agentId, [100, 200, 300]);
      estimateControl.throwOnEstimate = true;

      const runId = await seedQueuedRun(companyId, agentId);
      await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();
      await heartbeat.drainActiveRunExecutions();

      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
      const run = await heartbeat.getRun(runId);
      expect(run?.status).toBe("succeeded");
      expect(run?.error).toBeNull();
      // A failed estimate degrades to the same null a cold start produces.
      expect(await readEstimatedCents(runId)).toBeNull();
      const estimateEvents = await db
        .select()
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId))
        .then((rows) => rows.filter((row) => row.eventType === "cost.estimate"));
      expect(estimateEvents).toHaveLength(0);
    });

    it("does not overwrite a stamped estimate when the run is claimed again", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      await seedCompletedRunsWithCost(companyId, agentId, [100, 200, 300]);

      const runId = await seedQueuedRun(companyId, agentId);
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      const firstEstimate = await readEstimatedCents(runId);
      expect(firstEstimate).toBe(200);

      // Re-queue the same run and change the distribution underneath it, the
      // way a release-and-reclaim or a recovery retry would. If the write were
      // unconditional the baseline would move to the new median and
      // estimate-vs-actual would compare actual against a number chosen after
      // the fact.
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        status: "completed",
        startedAt: new Date(),
        finishedAt: new Date(),
      });
      await db.update(heartbeatRuns)
        .set({ status: "queued", startedAt: null, finishedAt: null })
        .where(eq(heartbeatRuns.id, runId));

      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();

      expect(await readEstimatedCents(runId)).toBe(firstEstimate);
      expect(await readEstimatedCents(runId)).toBe(200);
      const estimateEvents = await db
        .select()
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId))
        .then((rows) => rows.filter((row) => row.eventType === "cost.estimate"));
      expect(estimateEvents).toHaveLength(1);
    });

    it("keeps the existing budget and daily-cap gates ahead of the estimate write", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Capped Agent", { maxDailyRuns: 1 });
      await seedCompletedRunsWithCost(companyId, agentId, [100, 200, 300]);
      // One started run today already consumes the daily run cap.
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        status: "succeeded",
        startedAt: new Date(),
        finishedAt: new Date(),
      });

      const runId = await seedQueuedRun(companyId, agentId);
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();

      // The estimate write sits after the gates, so a blocked run is cancelled
      // with no estimate and no adapter execution. Stamping one here would put a
      // baseline on a run that never ran.
      const run = await heartbeat.getRun(runId);
      expect(run?.status).toBe("cancelled");
      expect(run?.errorCode).toBe("heartbeat.daily_run_limit");
      expect(mockAdapterExecute).not.toHaveBeenCalled();
      expect(await readEstimatedCents(runId)).toBeNull();
    });

    it("writes no estimate for a run cancelled after the budget gates", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      await seedCompletedRunsWithCost(companyId, agentId, [100, 200, 300]);

      // An unresolved blocker cancels the run later than the budget and
      // daily-cap checks do. It proves the write sits after every gate that can
      // abandon a run while it is still queued, not just the two named ones: this
      // agent has ample history, so a non-null estimate here would mean the write
      // ran on a run that was then cancelled and never executed.
      const issueId = randomUUID();
      const blockerIssueId = randomUUID();
      await db.insert(issues).values([
        {
          id: issueId,
          companyId,
          title: "Blocked work",
          status: "todo",
          assigneeAgentId: agentId,
        },
        {
          id: blockerIssueId,
          companyId,
          title: "Unresolved blocker",
          status: "todo",
        },
      ]);
      // Orientation matters: `issue_id` is the blocker and `related_issue_id` is the
      // dependent, which is what `listIssueDependencyReadinessMap` reads
      // (`server/src/services/issues.ts`). Seeding it the other way round declares
      // that the work issue blocks the other one, and the gate under test never
      // fires.
      await db.execute(sql.raw(`
        INSERT INTO "issue_relations" ("company_id", "issue_id", "related_issue_id", "type")
        VALUES ('${companyId}', '${blockerIssueId}', '${issueId}', 'blocks')
      `));

      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      });

      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();

      const run = await heartbeat.getRun(runId);
      expect(run?.status).toBe("cancelled");
      expect(run?.errorCode).toBe("issue_dependencies_blocked");
      expect(mockAdapterExecute).not.toHaveBeenCalled();
      expect(await readEstimatedCents(runId)).toBeNull();
    });
  });
});