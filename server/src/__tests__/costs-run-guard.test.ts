import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  activityLog,
  agents,
  companies,
  costEvents,
  createDb,
  goals,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import { costService } from "../services/costs.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const RANGE = {
  from: new Date("2026-04-01T00:00:00.000Z"),
  to: new Date("2026-04-30T23:59:59.999Z"),
};

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type CostEventSeed = {
  agentId: string;
  runId?: string | null;
  issueId?: string | null;
  projectId?: string | null;
  goalId?: string | null;
  costCents: number;
  /** Spread cost events within the range; defaults to a fixed in-range instant. */
  minute?: number;
};

describeEmbeddedPostgres("cost run-guard measurement layer", () => {
  let db!: ReturnType<typeof createDb>;
  let costs!: ReturnType<typeof costService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-costs-run-guard-");
    db = createDb(tempDb.connectionString);
    costs = costService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(overrides: { name?: string } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: overrides.name ?? "Run Guard Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedRun(
    companyId: string,
    agentId: string,
    options: { status?: string; startedAt?: Date; finishedAt?: Date } = {},
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: options.status ?? "completed",
      startedAt: options.startedAt ?? new Date("2026-04-10T00:00:00.000Z"),
      finishedAt: options.finishedAt ?? new Date("2026-04-10T00:05:00.000Z"),
    });
    return runId;
  }

  async function seedCostEvents(companyId: string, seeds: CostEventSeed[]) {
    await db.insert(costEvents).values(
      seeds.map((seed) => ({
        companyId,
        agentId: seed.agentId,
        heartbeatRunId: seed.runId ?? null,
        issueId: seed.issueId ?? null,
        projectId: seed.projectId ?? null,
        goalId: seed.goalId ?? null,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        costStatus: "reported",
        model: "gpt-5",
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 10,
        costCents: seed.costCents,
        occurredAt: new Date(Date.UTC(2026, 3, 10, 0, seed.minute ?? 0)),
      })),
    );
  }

  it("rolls cost_events up to one row per run and attributes the project via the activity_log fallback", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Run Agent");
    const projectId = randomUUID();
    const directProjectId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();

    await db.insert(projects).values([
      { id: projectId, companyId, name: "Linked Project", status: "active" },
      { id: directProjectId, companyId, name: "Direct Project", status: "active" },
    ]);
    await db.insert(goals).values({ id: goalId, companyId, title: "Linked Goal" });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      goalId,
      title: "Work the run touched",
      status: "in_progress",
      priority: "medium",
      issueNumber: 1,
      identifier: "TST-1",
    });

    // Run A: two cost events with no project_id/goal_id, only recoverable
    // through the run -> issue activity_log link.
    const linkedRunId = await seedRun(companyId, agentId, {
      status: "completed",
      startedAt: new Date("2026-04-10T01:00:00.000Z"),
      finishedAt: new Date("2026-04-10T01:02:00.000Z"),
    });
    // Run B: cost event carries its own project_id, so the fallback is not used.
    const directRunId = await seedRun(companyId, agentId, { status: "failed" });

    await db.insert(activityLog).values({
      companyId,
      runId: linkedRunId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "issue.checked_out",
      entityType: "issue",
      entityId: issueId,
      details: {},
    });

    await seedCostEvents(companyId, [
      { agentId, runId: linkedRunId, costCents: 100, minute: 1 },
      { agentId, runId: linkedRunId, costCents: 50, minute: 2 },
      { agentId, runId: directRunId, projectId: directProjectId, costCents: 300, minute: 3 },
    ]);

    const rows = await costs.byRun(companyId, RANGE);

    // One row per run, ordered by costCents desc.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      runId: directRunId,
      agentId,
      costCents: 300,
      costEventCount: 1,
      projectId: directProjectId,
      status: "failed",
    });
    expect(rows[1]).toMatchObject({
      runId: linkedRunId,
      agentId,
      issueId,
      projectId,
      costCents: 150,
      costEventCount: 2,
      inputTokens: 200,
      outputTokens: 20,
      status: "completed",
    });
    // Run-level timestamps come from heartbeat_runs, not the cost rows.
    expect(rows[1]?.startedAt).toEqual(new Date("2026-04-10T01:00:00.000Z"));
    expect(rows[1]?.finishedAt).toEqual(new Date("2026-04-10T01:02:00.000Z"));
    expect(rows[1]?.finishedAt?.getTime()).toBeGreaterThan(rows[1]?.startedAt?.getTime() ?? 0);

    // Runs with no cost are not "free runs"; they are simply absent.
    const emptyRunId = await seedRun(companyId, agentId);
    const afterEmptyRun = await costs.byRun(companyId, RANGE);
    expect(afterEmptyRun.map((row) => row.runId)).not.toContain(emptyRunId);
    expect(afterEmptyRun).toHaveLength(2);
  });

  it("takes percentiles over per-run totals, not over individual cost events", async () => {
    const companyId = await seedCompany();
    const agentA = await seedAgent(companyId, "Agent A");
    const agentB = await seedAgent(companyId, "Agent B");

    // Per-run totals: A=40, B=100, C=400, D=800, E=1600.
    // Raw cost-event rows: 10,10,10,10,100,200,200,800,1600.
    // The two sets give clearly different percentiles (p50 400 vs 100,
    // p95 1440 vs 1280), so a per-event implementation cannot pass.
    const runs: { runId: string; agentId: string }[] = [];
    for (let index = 0; index < 5; index += 1) {
      const agentId = index === 4 ? agentB : agentA;
      runs.push({ runId: await seedRun(companyId, agentId), agentId });
    }
    const perRunCents = [40, 100, 400, 800, 1600];

    const seeds: CostEventSeed[] = [];
    // Runs A/B/C are built from multiple events; runs D/E are one event each.
    [4, 1, 2, 1, 1].forEach((eventCount, runIndex) => {
      const perEvent = perRunCents[runIndex] / eventCount;
      for (let eventIndex = 0; eventIndex < eventCount; eventIndex += 1) {
        seeds.push({
          agentId: runs[runIndex]!.agentId,
          runId: runs[runIndex]!.runId,
          costCents: perEvent,
          minute: runIndex * 10 + eventIndex,
        });
      }
    });
    await seedCostEvents(companyId, seeds);

    const distribution = await costs.runSpendDistribution(companyId, RANGE);

    expect(distribution.companyId).toBe(companyId);
    expect(distribution.runCount).toBe(5);
    expect(distribution.totalCents).toBe(2940);
    expect(distribution.maxCents).toBe(1600);
    expect(distribution.p50Cents).toBe(400);
    expect(distribution.p90Cents).toBe(1280);
    expect(distribution.p95Cents).toBe(1440);
    expect(distribution.p99Cents).toBe(1568);

    // Agent A owns runs worth 40/100/400/800 -> p95 interpolates to 740.
    // Agent B owns the single 1600 run.
    expect(distribution.byAgent).toEqual([
      { agentId: agentA, runCount: 4, p95Cents: 740 },
      { agentId: agentB, runCount: 1, p95Cents: 1600 },
    ]);
  });

  it("returns zero runs and null percentiles for a company with no spend", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Idle Agent");
    // A run that never incurred cost must not appear in the distribution.
    await seedRun(companyId, agentId);

    const distribution = await costs.runSpendDistribution(companyId, RANGE);

    expect(distribution).toEqual({
      companyId,
      runCount: 0,
      totalCents: 0,
      p50Cents: null,
      p90Cents: null,
      p95Cents: null,
      p99Cents: null,
      maxCents: null,
      byAgent: [],
    });
    for (const value of [distribution.totalCents, distribution.p50Cents, distribution.p95Cents, distribution.maxCents]) {
      expect(value).not.toBeNaN();
    }
    expect(JSON.stringify(distribution)).not.toContain("null,null,null,null,null");

    const outcome = await costs.costPerOutcome(companyId, RANGE);
    expect(outcome.perCompletedIssueCents).toBeNull();
    expect(outcome.completedIssueCount).toBe(0);
    expect(outcome.completedCostCents).toBe(0);
    expect(outcome.perProject).toEqual([]);
    expect(outcome.perGoal).toEqual([]);
  });

  it("divides by completed issues only and returns null when nothing completed", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Outcome Agent");
    const projectId = randomUUID();
    const goalId = randomUUID();
    const doneIssueId = randomUUID();
    const openIssueId = randomUUID();
    const runId = await seedRun(companyId, agentId);

    await db.insert(projects).values({ id: projectId, companyId, name: "Outcome Project", status: "active" });
    await db.insert(goals).values({ id: goalId, companyId, title: "Outcome Goal" });
    await db.insert(issues).values([
      {
        id: doneIssueId,
        companyId,
        projectId,
        goalId,
        title: "Finished",
        // The only completed status is `done`; `cancelled` is terminal but not
        // completion. See COMPLETED_ISSUE_STATUSES in services/costs.ts.
        status: "done",
        priority: "medium",
        issueNumber: 1,
        identifier: "TST-1",
      },
      {
        id: openIssueId,
        companyId,
        projectId,
        goalId,
        title: "Still going",
        status: "in_progress",
        priority: "medium",
        issueNumber: 2,
        identifier: "TST-2",
      },
      {
        id: randomUUID(),
        companyId,
        projectId,
        goalId,
        title: "Abandoned",
        status: "cancelled",
        priority: "medium",
        issueNumber: 3,
        identifier: "TST-3",
      },
    ]);

    await seedCostEvents(companyId, [
      // No project_id/goal_id on the row: both come from the run -> issue link.
      { agentId, runId, issueId: doneIssueId, costCents: 300, minute: 1 },
      { agentId, runId, issueId: openIssueId, costCents: 700, minute: 2 },
      { agentId, runId, issueId: null, costCents: 500, minute: 3 },
    ]);
    await db.insert(activityLog).values({
      companyId,
      runId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "issue.checked_out",
      entityType: "issue",
      entityId: doneIssueId,
      details: {},
    });

    const outcome = await costs.costPerOutcome(companyId, RANGE);

    expect(outcome.completedIssueCount).toBe(1);
    expect(outcome.completedCostCents).toBe(300);
    // 300 / 1 completed issue. Spend on in_progress and unattributed work is
    // excluded from the numerator so it matches the denominator's population.
    expect(outcome.perCompletedIssueCents).toBe(300);

    // The project/goal fallback attributes the whole run, including the row
    // that carries no issue, because attribution is per run not per cost row.
    expect(outcome.perProject).toEqual([
      expect.objectContaining({ projectId, projectName: "Outcome Project", costCents: 1500 }),
    ]);
    expect(outcome.perGoal).toEqual([
      expect.objectContaining({ goalId, goalTitle: "Outcome Goal", costCents: 1500 }),
    ]);
  });

  it("never exposes another company's cost through any run measurement", async () => {
    const companyId = await seedCompany({ name: "Mine" });
    const otherCompanyId = await seedCompany({ name: "Theirs" });
    const agentId = await seedAgent(companyId, "Mine Agent");
    const otherAgentId = await seedAgent(otherCompanyId, "Their Agent");
    const runId = await seedRun(companyId, agentId);
    const otherRunId = await seedRun(otherCompanyId, otherAgentId);

    await seedCostEvents(companyId, [{ agentId, runId, costCents: 250, minute: 1 }]);
    await seedCostEvents(otherCompanyId, [
      { agentId: otherAgentId, runId: otherRunId, costCents: 9_999, minute: 2 },
    ]);

    const rows = await costs.byRun(companyId, RANGE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId, costCents: 250 });

    const distribution = await costs.runSpendDistribution(companyId, RANGE);
    expect(distribution.runCount).toBe(1);
    expect(distribution.totalCents).toBe(250);
    expect(distribution.maxCents).toBe(250);
    expect(distribution.byAgent).toEqual([{ agentId, runCount: 1, p95Cents: 250 }]);

    const outcome = await costs.costPerOutcome(companyId, RANGE);
    expect(outcome.companyId).toBe(companyId);
    expect(outcome.completedIssueCount).toBe(0);
    expect(outcome.perCompletedIssueCents).toBeNull();
  });
});