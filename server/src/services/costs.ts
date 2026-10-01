import { agentAvatarUrl, ISSUE_STATUSES, resolveAgentAppearance } from "@paperclipai/shared";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  companies,
  costEvents,
  goals,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { budgetService, type BudgetServiceHooks } from "./budgets.js";
import { visibleIssueCondition } from "./issue-visibility.js";

export interface CostDateRange {
  from?: Date;
  to?: Date;
}

const METERED_BILLING_TYPE = "metered_api";
const SUBSCRIPTION_BILLING_TYPES = ["subscription_included", "subscription_overage"] as const;

/**
 * An issue counts as completed when its current status is `done`.
 *
 * The full issue status set is `backlog | todo | in_progress | in_review |
 * done | blocked | cancelled` (ISSUE_STATUSES in packages/shared). `cancelled`
 * is terminal but is NOT completion, so `done` is the only completed status.
 * The `satisfies` clause makes this a compile error if that status set ever
 * stops containing `done`, rather than a silently empty metric.
 */
const COMPLETED_ISSUE_STATUSES = ["done"] as const satisfies readonly (typeof ISSUE_STATUSES)[number][];

function sumAsNumber(column: typeof costEvents.costCents | typeof costEvents.inputTokens | typeof costEvents.cachedInputTokens | typeof costEvents.outputTokens) {
  return sql<number>`coalesce(sum(${column}), 0)::double precision`;
}

/**
 * Postgres returns int8/numeric as strings over the wire, so every raw
 * aggregate row has to be coerced here. Anything non-finite collapses to null
 * instead of leaking NaN into a JSON response.
 */
function asNumberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function costRangeConditions(companyId: string, range?: CostDateRange) {
  const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
  if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
  if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));
  return conditions;
}

/**
 * Resolves a run to the issue it last touched, so a cost row carrying no
 * issue_id/project_id/goal_id can still be attributed.
 *
 * Same source as `byProject`: activity_log rows with entityType 'issue',
 * joined to that issue. DISTINCT ON is deliberately narrowed to run_id alone
 * (ordered by newest activity first) so the CTE yields at most one row per
 * run. That is what makes it safe to left join against cost_events without
 * fanning out and double counting a run's spend.
 */
function runIssueLinkCte(db: Db, companyId: string) {
  const issueIdAsText = sql<string>`${issues.id}::text`;
  return db
    .selectDistinctOn([activityLog.runId], {
      runId: activityLog.runId,
      issueId: issues.id,
      projectId: issues.projectId,
      goalId: issues.goalId,
    })
    .from(activityLog)
    .innerJoin(
      issues,
      and(
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, issueIdAsText),
      ),
    )
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(issues.companyId, companyId),
        isNotNull(activityLog.runId),
      ),
    )
    .orderBy(activityLog.runId, desc(activityLog.createdAt))
    .as("run_issue_links");
}

function currentUtcMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
  };
}

async function getMonthlySpendTotal(
  db: Db,
  scope: { companyId: string; agentId?: string | null },
) {
  const { start, end } = currentUtcMonthWindow();
  const conditions = [
    eq(costEvents.companyId, scope.companyId),
    gte(costEvents.occurredAt, start),
    lt(costEvents.occurredAt, end),
  ];
  if (scope.agentId) {
    conditions.push(eq(costEvents.agentId, scope.agentId));
  }
  const [row] = await db
    .select({
      total: sumAsNumber(costEvents.costCents),
    })
    .from(costEvents)
    .where(and(...conditions));
  return Number(row?.total ?? 0);
}

export function costService(db: Db, budgetHooks: BudgetServiceHooks = {}) {
  const budgets = budgetService(db, budgetHooks);
  return {
    createEvent: async (companyId: string, data: Omit<typeof costEvents.$inferInsert, "companyId">) => {
      const agent = await db
        .select()
        .from(agents)
        .where(eq(agents.id, data.agentId))
        .then((rows) => rows[0] ?? null);

      if (!agent) throw notFound("Agent not found");
      if (agent.companyId !== companyId) {
        throw unprocessable("Agent does not belong to company");
      }

      const event = await db
        .insert(costEvents)
        .values({
          ...data,
          companyId,
          biller: data.biller ?? data.provider,
          billingType: data.billingType ?? "unknown",
          cachedInputTokens: data.cachedInputTokens ?? 0,
        })
        .returning()
        .then((rows) => rows[0]);

      const [agentMonthSpend, companyMonthSpend] = await Promise.all([
        getMonthlySpendTotal(db, { companyId, agentId: event.agentId }),
        getMonthlySpendTotal(db, { companyId }),
      ]);

      await db
        .update(agents)
        .set({
          spentMonthlyCents: agentMonthSpend,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, event.agentId));

      await db
        .update(companies)
        .set({
          spentMonthlyCents: companyMonthSpend,
          updatedAt: new Date(),
        })
        .where(eq(companies.id, companyId));

      await budgets.evaluateCostEvent(event);

      return event;
    },

    summary: async (companyId: string, range?: CostDateRange) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const [{ total }] = await db
        .select({
          total: sumAsNumber(costEvents.costCents),
        })
        .from(costEvents)
        .where(and(...conditions));

      const spendCents = Number(total);
      const utilization =
        company.budgetMonthlyCents > 0
          ? (spendCents / company.budgetMonthlyCents) * 100
          : 0;

      return {
        companyId,
        spendCents,
        budgetCents: company.budgetMonthlyCents,
        utilizationPercent: Number(utilization.toFixed(2)),
      };
    },

    issueTreeSummary: async (
      companyId: string,
      issueId: string,
      options: { excludeRoot?: boolean } = {},
    ) => {
      // Callers must resolve and authorize a visible root issue before invoking this.
      // The route does that so zero counts are not mistaken for a missing root.
      const childIssues = alias(issues, "child");

      // The seed of the recursive CTE: when excludeRoot is true, start from
      // the direct children so the root issue itself is not counted.
      const cteSeed = options.excludeRoot
        ? sql`
            SELECT ${issues.id}
            FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.parentId} = ${issueId}
              AND ${issues.hiddenAt} IS NULL
              AND ${issues.harnessKind} IS NULL
          `
        : sql`
            SELECT ${issues.id}
            FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.id} = ${issueId}
              AND ${issues.hiddenAt} IS NULL
              AND ${issues.harnessKind} IS NULL
          `;

      const cteSeedText = options.excludeRoot
        ? sql`
            SELECT (${issues.id})::text AS id
            FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.parentId} = ${issueId}
              AND ${issues.hiddenAt} IS NULL
              AND ${issues.harnessKind} IS NULL
          `
        : sql`
            SELECT (${issues.id})::text AS id
            FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.id} = ${issueId}
              AND ${issues.hiddenAt} IS NULL
              AND ${issues.harnessKind} IS NULL
          `;

      const issueTreeCondition = sql<boolean>`
        ${issues.id} IN (
          WITH RECURSIVE issue_tree(id) AS (
            ${cteSeed}
            UNION ALL
            SELECT ${childIssues.id}
            FROM ${issues} ${childIssues}
            JOIN issue_tree ON ${childIssues.parentId} = issue_tree.id
            WHERE ${childIssues.companyId} = ${companyId}
              AND ${childIssues.hiddenAt} IS NULL
              AND ${childIssues.harnessKind} IS NULL
          )
          SELECT id FROM issue_tree
        )
      `;

      const runSummarySql = sql`
        WITH RECURSIVE issue_tree(id) AS (
          ${cteSeedText}
          UNION ALL
          SELECT (${childIssues.id})::text
          FROM ${issues} ${childIssues}
          JOIN issue_tree ON (${childIssues.parentId})::text = issue_tree.id
          WHERE ${childIssues.companyId} = ${companyId}
            AND ${childIssues.hiddenAt} IS NULL
            AND ${childIssues.harnessKind} IS NULL
        )
        SELECT
          count(distinct ${heartbeatRuns.id})::int AS "runCount",
          coalesce(sum(extract(epoch from (coalesce(${heartbeatRuns.finishedAt}, now()) - ${heartbeatRuns.startedAt})) * 1000), 0)::double precision AS "runtimeMs"
        FROM ${heartbeatRuns}
        WHERE ${heartbeatRuns.companyId} = ${companyId}
          AND ${heartbeatRuns.startedAt} IS NOT NULL
          AND (
            ${heartbeatRuns.contextSnapshot} ->> 'issueId' IN (SELECT id FROM issue_tree)
            OR EXISTS (
              SELECT 1
              FROM ${activityLog}
              JOIN issue_tree ON ${activityLog.entityId} = issue_tree.id
              WHERE ${activityLog.companyId} = ${companyId}
                AND ${activityLog.entityType} = 'issue'
                AND ${activityLog.runId} = ${heartbeatRuns.id}
            )
          )
      `;

      // Run cost-event aggregation and run-duration aggregation in parallel.
      // They're separate queries because cost_events fan out per-event and
      // joining heartbeat_runs through them would double-count run durations.
      const [costRowResult, runRowResult] = await Promise.all([
        db
          .select({
            issueCount: sql<number>`count(distinct ${issues.id})::int`,
            costCents: sumAsNumber(costEvents.costCents),
            inputTokens: sumAsNumber(costEvents.inputTokens),
            cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
            outputTokens: sumAsNumber(costEvents.outputTokens),
          })
          .from(issues)
          .leftJoin(
            costEvents,
            and(
              eq(costEvents.companyId, companyId),
              eq(costEvents.issueId, issues.id),
            ),
          )
          .where(
            and(
              eq(issues.companyId, companyId),
              visibleIssueCondition(),
              issueTreeCondition,
            ),
          ),
        db.execute(runSummarySql),
      ]);

      const costRow = costRowResult[0];
      const runRow = Array.isArray(runRowResult)
        ? (runRowResult[0] as { runCount?: number | string | null; runtimeMs?: number | string | null } | undefined)
        : undefined;

      return {
        issueId,
        issueCount: Number(costRow?.issueCount ?? 0),
        includeDescendants: true,
        costCents: Number(costRow?.costCents ?? 0),
        inputTokens: Number(costRow?.inputTokens ?? 0),
        cachedInputTokens: Number(costRow?.cachedInputTokens ?? 0),
        outputTokens: Number(costRow?.outputTokens ?? 0),
        runCount: Number(runRow?.runCount ?? 0),
        runtimeMs: Number(runRow?.runtimeMs ?? 0),
      };
    },

    byAgent: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const rows = await db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          agentAppearance: agents.appearance,
          agentStatus: agents.status,
          costCents: sumAsNumber(costEvents.costCents),
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionCachedInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cachedInputTokens} else 0 end), 0)::double precision`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.inputTokens} else 0 end), 0)::double precision`,
          subscriptionOutputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.outputTokens} else 0 end), 0)::double precision`,
        })
        .from(costEvents)
        .leftJoin(agents, eq(costEvents.agentId, agents.id))
        .where(and(...conditions))
        .groupBy(costEvents.agentId, agents.name, agents.appearance, agents.status)
        .orderBy(desc(sumAsNumber(costEvents.costCents)));
      return rows.map(row => {
        const appearance = resolveAgentAppearance(row.agentAppearance, row.agentId);
        return { ...row, agentAppearance: appearance, avatarUrl: agentAvatarUrl(appearance, 512) };
      });
    },

    byProvider: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      return db
        .select({
          provider: costEvents.provider,
          biller: costEvents.biller,
          billingType: costEvents.billingType,
          model: costEvents.model,
          costCents: sumAsNumber(costEvents.costCents),
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionCachedInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cachedInputTokens} else 0 end), 0)::double precision`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.inputTokens} else 0 end), 0)::double precision`,
          subscriptionOutputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.outputTokens} else 0 end), 0)::double precision`,
        })
        .from(costEvents)
        .where(and(...conditions))
        .groupBy(costEvents.provider, costEvents.biller, costEvents.billingType, costEvents.model)
        .orderBy(desc(sumAsNumber(costEvents.costCents)));
    },

    byBiller: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      return db
        .select({
          biller: costEvents.biller,
          costCents: sumAsNumber(costEvents.costCents),
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionCachedInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cachedInputTokens} else 0 end), 0)::double precision`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.inputTokens} else 0 end), 0)::double precision`,
          subscriptionOutputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.outputTokens} else 0 end), 0)::double precision`,
          providerCount: sql<number>`count(distinct ${costEvents.provider})::int`,
          modelCount: sql<number>`count(distinct ${costEvents.model})::int`,
        })
        .from(costEvents)
        .where(and(...conditions))
        .groupBy(costEvents.biller)
        .orderBy(desc(sumAsNumber(costEvents.costCents)));
    },

    /**
     * aggregates cost_events by provider for each of three rolling windows:
     * last 5 hours, last 24 hours, last 7 days.
     * purely internal consumption data, no external rate-limit sources.
     */
    windowSpend: async (companyId: string) => {
      const windows = [
        { label: "5h", hours: 5 },
        { label: "24h", hours: 24 },
        { label: "7d", hours: 168 },
      ] as const;

      const results = await Promise.all(
        windows.map(async ({ label, hours }) => {
          const since = new Date(Date.now() - hours * 60 * 60 * 1000);
          const rows = await db
            .select({
              provider: costEvents.provider,
              biller: sql<string>`case when count(distinct ${costEvents.biller}) = 1 then min(${costEvents.biller}) else 'mixed' end`,
              costCents: sumAsNumber(costEvents.costCents),
              inputTokens: sumAsNumber(costEvents.inputTokens),
              cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
              outputTokens: sumAsNumber(costEvents.outputTokens),
            })
            .from(costEvents)
            .where(
              and(
                eq(costEvents.companyId, companyId),
                gte(costEvents.occurredAt, since),
              ),
            )
            .groupBy(costEvents.provider)
            .orderBy(desc(sumAsNumber(costEvents.costCents)));

          return rows.map((row) => ({
            provider: row.provider,
            biller: row.biller,
            window: label as string,
            windowHours: hours,
            costCents: row.costCents,
            inputTokens: row.inputTokens,
            cachedInputTokens: row.cachedInputTokens,
            outputTokens: row.outputTokens,
          }));
        }),
      );

      return results.flat();
    },

    byAgentModel: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      // single query: group by agent + provider + model.
      // the (companyId, agentId, occurredAt) composite index covers this well.
      // order by provider + model for stable db-level ordering; cost-desc sort
      // within each agent's sub-rows is done client-side in the ui memo.
      const rows = await db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          agentAppearance: agents.appearance,
          provider: costEvents.provider,
          biller: costEvents.biller,
          billingType: costEvents.billingType,
          model: costEvents.model,
          costCents: sumAsNumber(costEvents.costCents),
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
        })
        .from(costEvents)
        .leftJoin(agents, eq(costEvents.agentId, agents.id))
        .where(and(...conditions))
        .groupBy(
          costEvents.agentId,
          agents.name,
          agents.appearance,
          costEvents.provider,
          costEvents.biller,
          costEvents.billingType,
          costEvents.model,
        )
        .orderBy(costEvents.provider, costEvents.biller, costEvents.billingType, costEvents.model);
      return rows.map(row => {
        const appearance = resolveAgentAppearance(row.agentAppearance, row.agentId);
        return { ...row, agentAppearance: appearance, avatarUrl: agentAvatarUrl(appearance, 512) };
      });
    },

    byProject: async (companyId: string, range?: CostDateRange) => {
      const issueIdAsText = sql<string>`${issues.id}::text`;
      const runProjectLinks = db
        .selectDistinctOn([activityLog.runId, issues.projectId], {
          runId: activityLog.runId,
          projectId: issues.projectId,
        })
        .from(activityLog)
        .innerJoin(
          issues,
          and(
            eq(activityLog.entityType, "issue"),
            eq(activityLog.entityId, issueIdAsText),
          ),
        )
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(issues.companyId, companyId),
            isNotNull(activityLog.runId),
            isNotNull(issues.projectId),
          ),
        )
        .orderBy(activityLog.runId, issues.projectId, desc(activityLog.createdAt))
        .as("run_project_links");

      const effectiveProjectId = sql<string | null>`coalesce(${costEvents.projectId}, ${runProjectLinks.projectId})`;
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const costCentsExpr = sumAsNumber(costEvents.costCents);

      return db
        .select({
          projectId: effectiveProjectId,
          projectName: projects.name,
          costCents: costCentsExpr,
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
        })
        .from(costEvents)
        .leftJoin(runProjectLinks, eq(costEvents.heartbeatRunId, runProjectLinks.runId))
        .innerJoin(projects, sql`${projects.id} = ${effectiveProjectId}`)
        .where(and(...conditions, sql`${effectiveProjectId} is not null`))
        .groupBy(effectiveProjectId, projects.name)
        .orderBy(desc(costCentsExpr));
    },

    /**
     * One row per heartbeat_runs.id that incurred cost in the range.
     *
     * A run is the spend unit, so the cost_events fan-out (many rows per run)
     * is collapsed with sum() here. cost_events_company_heartbeat_run_idx
     * covers the grouping key, so this needs no new index.
     */
    byRun: async (companyId: string, range?: CostDateRange, limit: number = 100) => {
      const runIssueLinks = runIssueLinkCte(db, companyId);
      const conditions = costRangeConditions(companyId, range);
      const effectiveIssueId = sql<string | null>`coalesce(${costEvents.issueId}, ${runIssueLinks.issueId})`;
      const effectiveProjectId = sql<string | null>`coalesce(${costEvents.projectId}, ${runIssueLinks.projectId})`;
      const costCentsExpr = sumAsNumber(costEvents.costCents);

      // A run can touch several issues, so its cost rows can carry different
      // issue/project ids. Grouping on them would split one run into several
      // rows and break the one-row-per-run contract, so take a deterministic
      // min() of each instead. min() ignores nulls, so a run whose rows are all
      // unattributed reports null rather than a bogus id.
      //
      // Bounded because this is the only per-row cost rollup: every sibling
      // collapses to agent/project/provider cardinality, so none of them needs a
      // limit. A company can hold far more runs than rows any client should page
      // through, so the route passes `parseCostLimit` (default 100, max 500). The
      // distribution endpoint, which is what a cap would actually be set from, is
      // an aggregate and is unaffected.
      //
      // A truncated page is a partial view, not a total: summing `costCents` across
      // one page gives that page's spend, not the company's. `startedAt` breaks ties
      // so that page is at least deterministic — two runs with identical spend would
      // otherwise come back in an arbitrary order and re-order between two identical
      // requests.
      return db
        .select({
          // Non-null by construction: heartbeat_run_id is filtered below.
          runId: sql<string>`${costEvents.heartbeatRunId}`,
          // The run's own agent, not the cost row's. A run has exactly one
          // agent, so this can never split the grouping key.
          agentId: heartbeatRuns.agentId,
          issueId: sql<string | null>`min(${effectiveIssueId}::text)::uuid`,
          projectId: sql<string | null>`min(${effectiveProjectId}::text)::uuid`,
          costCents: costCentsExpr,
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          costEventCount: sql<number>`count(*)::int`,
          startedAt: heartbeatRuns.startedAt,
          finishedAt: heartbeatRuns.finishedAt,
          status: heartbeatRuns.status,
        })
        .from(costEvents)
        .innerJoin(
          heartbeatRuns,
          and(
            eq(heartbeatRuns.id, costEvents.heartbeatRunId),
            eq(heartbeatRuns.companyId, companyId),
          ),
        )
        .leftJoin(runIssueLinks, eq(costEvents.heartbeatRunId, runIssueLinks.runId))
        .where(and(...conditions, isNotNull(costEvents.heartbeatRunId)))
        .groupBy(
          costEvents.heartbeatRunId,
          heartbeatRuns.agentId,
          heartbeatRuns.startedAt,
          heartbeatRuns.finishedAt,
          heartbeatRuns.status,
        )
        .orderBy(desc(costCentsExpr), desc(heartbeatRuns.startedAt))
        .limit(limit);
    },

    /**
     * The measurement layer for a per-run spend cap: where the cost of a single
     * run actually sits across observed runs.
     *
     * Granularity is the whole point. Percentiles are taken over PER-RUN
     * TOTALS, never over raw cost_events rows. A run emits many cost events (one
     * per model call), so percentiles over raw rows would measure the size of a
     * single billing event and read far lower than what a run costs. The CTE
     * sums cost_events by heartbeat_run_id FIRST; the ordered-set aggregates
     * then run over those per-run totals.
     *
     * percentile_cont interpolates between neighbours, which is the curve a
     * board member expects from a p95; results are rounded to the nearest cent
     * because cost_cents is an integer. Runs with zero cost still count toward
     * runCount and can drag an interpolated percentile down slightly, which is
     * honest: a free run really did happen.
     *
     * The aggregates never divide, so an empty company yields runCount 0 and
     * null percentiles rather than NaN.
     */
    runSpendDistribution: async (companyId: string, range?: CostDateRange) => {
      const conditions = costRangeConditions(companyId, range);

      // Sum cost_events to one row per run BEFORE any percentile is taken.
      // Tables stay unaliased so the drizzle-rendered column references above
      // remain valid inside this raw fragment.
      const perRunCost = sql`
        WITH per_run_cost AS (
          SELECT
            cost_events.heartbeat_run_id AS run_id,
            heartbeat_runs.agent_id AS agent_id,
            sum(cost_events.cost_cents)::bigint AS run_cost_cents
          FROM cost_events
          JOIN heartbeat_runs
            ON heartbeat_runs.id = cost_events.heartbeat_run_id
            AND heartbeat_runs.company_id = cost_events.company_id
          WHERE ${and(...conditions)}
            AND cost_events.heartbeat_run_id IS NOT NULL
          GROUP BY cost_events.heartbeat_run_id, heartbeat_runs.agent_id
        )
      `;

      const overallQuery = sql`
        ${perRunCost}
        SELECT
          count(*)::int AS "runCount",
          coalesce(sum(run_cost_cents), 0)::double precision AS "totalCents",
          round(percentile_cont(0.50) WITHIN GROUP (ORDER BY run_cost_cents)::numeric)::bigint AS "p50Cents",
          round(percentile_cont(0.90) WITHIN GROUP (ORDER BY run_cost_cents)::numeric)::bigint AS "p90Cents",
          round(percentile_cont(0.95) WITHIN GROUP (ORDER BY run_cost_cents)::numeric)::bigint AS "p95Cents",
          round(percentile_cont(0.99) WITHIN GROUP (ORDER BY run_cost_cents)::numeric)::bigint AS "p99Cents",
          max(run_cost_cents) AS "maxCents"
        FROM per_run_cost
      `;

      const byAgentQuery = sql`
        ${perRunCost}
        SELECT
          agent_id AS "agentId",
          count(*)::int AS "runCount",
          round(percentile_cont(0.95) WITHIN GROUP (ORDER BY run_cost_cents)::numeric)::bigint AS "p95Cents"
        FROM per_run_cost
        GROUP BY agent_id
        ORDER BY "runCount" DESC, "p95Cents" DESC NULLS LAST
      `;

      const [overallResult, byAgentResult] = await Promise.all([
        db.execute(overallQuery),
        db.execute(byAgentQuery),
      ]);

      const overallRow = (
        Array.isArray(overallResult) ? overallResult[0] : undefined
      ) as
        | {
            runCount?: number | string | null;
            totalCents?: number | string | null;
            p50Cents?: number | string | null;
            p90Cents?: number | string | null;
            p95Cents?: number | string | null;
            p99Cents?: number | string | null;
            maxCents?: number | string | null;
          }
        | undefined;

      const byAgentRows = (Array.isArray(byAgentResult) ? byAgentResult : []) as {
        agentId?: string | null;
        runCount?: number | string | null;
        p95Cents?: number | string | null;
      }[];

      return {
        companyId,
        runCount: Number(overallRow?.runCount ?? 0),
        totalCents: Number(overallRow?.totalCents ?? 0),
        p50Cents: asNumberOrNull(overallRow?.p50Cents),
        p90Cents: asNumberOrNull(overallRow?.p90Cents),
        p95Cents: asNumberOrNull(overallRow?.p95Cents),
        p99Cents: asNumberOrNull(overallRow?.p99Cents),
        // Null, not 0: "no runs" and "every run was free" are different answers.
        maxCents: asNumberOrNull(overallRow?.maxCents),
        byAgent: byAgentRows.map((row) => ({
          agentId: row.agentId ?? null,
          runCount: Number(row.runCount ?? 0),
          p95Cents: asNumberOrNull(row.p95Cents),
        })),
      };
    },

    /**
     * Cost effectiveness: what the company got for its spend.
     *
     * "Completed issue" means an issue whose CURRENT status is `done` (see
     * COMPLETED_ISSUE_STATUSES above). Two consequences of using current status
     * rather than a transition history:
     *
     * - We count DISTINCT ISSUES, not `done` transitions. An issue that reached
     *   done three times is one completed issue.
     * - Status can change after spend is recorded, and this metric follows the
     *   status. An issue reopened after completion drops out of BOTH the
     *   numerator and the denominator, so the ratio stays internally consistent
     *   rather than charging cost against work that no longer counts as done.
     *
     * The denominator is issues with spend inside the requested range, not every
     * `done` issue the company has ever had, so the numerator and denominator
     * describe the same population.
     */
    costPerOutcome: async (companyId: string, range?: CostDateRange) => {
      const runIssueLinks = runIssueLinkCte(db, companyId);
      const conditions = costRangeConditions(companyId, range);
      const effectiveProjectId = sql<string | null>`coalesce(${costEvents.projectId}, ${runIssueLinks.projectId})`;
      const effectiveGoalId = sql<string | null>`coalesce(${costEvents.goalId}, ${runIssueLinks.goalId})`;

      const [completedRows, perProjectRows, perGoalRows] = await Promise.all([
        // Joins on `cost_events.issue_id` directly, with no run-link fallback, so
        // the headline ratio only counts spend that was stamped with an issue at
        // write time. Run-linked spend still reaches perProject/perGoal below,
        // which do apply the fallback. Under partial stamping this makes
        // `perCompletedIssueCents` read HIGHER than true cost-per-outcome,
        // because unattributed spend is absent from the numerator while its issues
        // are still in the denominator. That is a deliberate, conservative choice:
        // the number shown is the cost of the spend we can actually attribute, not
        // a total-cost-per-issue figure. Report it as attributed cost.
        db
          .select({
            completedIssueCount: sql<number>`count(distinct ${issues.id})::int`,
            completedCostCents: sumAsNumber(costEvents.costCents),
          })
          .from(issues)
          .innerJoin(
            costEvents,
            and(eq(costEvents.issueId, issues.id), eq(costEvents.companyId, companyId)),
          )
          .where(
            and(
              eq(issues.companyId, companyId),
              visibleIssueCondition(),
              inArray(issues.status, [...COMPLETED_ISSUE_STATUSES]),
              ...conditions,
            ),
          ),
        db
          .select({
            projectId: effectiveProjectId,
            projectName: projects.name,
            costCents: sumAsNumber(costEvents.costCents),
            inputTokens: sumAsNumber(costEvents.inputTokens),
            cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
            outputTokens: sumAsNumber(costEvents.outputTokens),
          })
          .from(costEvents)
          .leftJoin(runIssueLinks, eq(costEvents.heartbeatRunId, runIssueLinks.runId))
          .innerJoin(projects, sql`${projects.id} = ${effectiveProjectId}`)
          .where(and(...conditions, sql`${effectiveProjectId} is not null`))
          .groupBy(effectiveProjectId, projects.name)
          .orderBy(desc(sql`sum(${costEvents.costCents})`)),
        db
          .select({
            goalId: effectiveGoalId,
            goalTitle: goals.title,
            costCents: sumAsNumber(costEvents.costCents),
            inputTokens: sumAsNumber(costEvents.inputTokens),
            cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
            outputTokens: sumAsNumber(costEvents.outputTokens),
          })
          .from(costEvents)
          .leftJoin(runIssueLinks, eq(costEvents.heartbeatRunId, runIssueLinks.runId))
          .innerJoin(goals, sql`${goals.id} = ${effectiveGoalId}`)
          .where(and(...conditions, sql`${effectiveGoalId} is not null`))
          .groupBy(effectiveGoalId, goals.title)
          .orderBy(desc(sql`sum(${costEvents.costCents})`)),
      ]);

      const completedIssueCount = Number(completedRows[0]?.completedIssueCount ?? 0);
      const completedCostCents = Number(completedRows[0]?.completedCostCents ?? 0);

      return {
        companyId,
        completedIssueCount,
        completedCostCents,
        // Null rather than Infinity/NaN when nothing completed in the range.
        perCompletedIssueCents: completedIssueCount > 0
          ? Math.round(completedCostCents / completedIssueCount)
          : null,
        perProject: perProjectRows,
        perGoal: perGoalRows,
      };
    },
  };
}
