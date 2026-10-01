import { z } from "zod";
import { BILLING_TYPES, COST_STATUSES } from "../constants.js";

export const createCostEventSchema = z.object({
  agentId: z.string().guid(),
  issueId: z.string().guid().optional().nullable(),
  projectId: z.string().guid().optional().nullable(),
  goalId: z.string().guid().optional().nullable(),
  heartbeatRunId: z.string().guid().optional().nullable(),
  billingCode: z.string().optional().nullable(),
  provider: z.string().min(1),
  biller: z.string().min(1).optional(),
  billingType: z.enum(BILLING_TYPES).optional().default("unknown"),
  costStatus: z.enum(COST_STATUSES).optional().default("reported"),
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative().optional().default(0),
  cachedInputTokens: z.number().int().nonnegative().optional().default(0),
  outputTokens: z.number().int().nonnegative().optional().default(0),
  costCents: z.number().int().nonnegative(),
  occurredAt: z.string().datetime(),
}).transform((value) => ({
  ...value,
  biller: value.biller ?? value.provider,
}));

export type CreateCostEvent = z.infer<typeof createCostEventSchema>;

export const updateBudgetSchema = z.object({
  budgetMonthlyCents: z.number().int().nonnegative(),
});

export type UpdateBudget = z.infer<typeof updateBudgetSchema>;

/** One `heartbeat_runs` row and everything its cost_events added up to. */
export const costRunRollupSchema = z.object({
  runId: z.string().guid(),
  agentId: z.string().guid(),
  // A run can touch several issues, so the rollup reports one deterministic
  // issue id rather than splitting the run across several rows.
  issueId: z.string().guid().nullable(),
  projectId: z.string().guid().nullable(),
  costCents: z.number().nonnegative(),
  inputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  costEventCount: z.number().int().nonnegative(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  status: z.string(),
});

export type CostRunRollup = z.infer<typeof costRunRollupSchema>;

/**
 * Percentiles are null when there are no runs in range. Null and 0 are
 * deliberately different: null means "nothing to measure", 0 would claim every
 * run was free.
 */
export const runSpendDistributionSchema = z.object({
  companyId: z.string().guid(),
  runCount: z.number().int().nonnegative(),
  totalCents: z.number().nonnegative(),
  p50Cents: z.number().nullable(),
  p90Cents: z.number().nullable(),
  p95Cents: z.number().nullable(),
  p99Cents: z.number().nullable(),
  maxCents: z.number().nullable(),
  byAgent: z.array(
    z.object({
      agentId: z.string().guid().nullable(),
      runCount: z.number().int().nonnegative(),
      p95Cents: z.number().nullable(),
    }),
  ),
});

export type RunSpendDistribution = z.infer<typeof runSpendDistributionSchema>;

const costGroupRollupShape = {
  costCents: z.number().nonnegative(),
  inputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
};

/** Null when nothing completed in the range; never Infinity or NaN. */
export const costPerOutcomeSchema = z.object({
  companyId: z.string().guid(),
  completedIssueCount: z.number().int().nonnegative(),
  completedCostCents: z.number().nonnegative(),
  perCompletedIssueCents: z.number().nullable(),
  perProject: z.array(
    z.object({
      projectId: z.string().guid().nullable(),
      projectName: z.string(),
      ...costGroupRollupShape,
    }),
  ),
  perGoal: z.array(
    z.object({
      goalId: z.string().guid().nullable(),
      goalTitle: z.string(),
      ...costGroupRollupShape,
    }),
  ),
});

export type CostPerOutcome = z.infer<typeof costPerOutcomeSchema>;
