---
title: Costs
summary: Cost events, summaries, and budget management
---

Track token usage and spending across agents, projects, and the company.

## Report Cost Event

```
POST /api/companies/{companyId}/cost-events
{
  "agentId": "{agentId}",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "inputTokens": 15000,
  "outputTokens": 3000,
  "costCents": 12
}
```

Typically reported automatically by adapters after each heartbeat.

## Company Cost Summary

```
GET /api/companies/{companyId}/costs/summary
```

Returns total spend, budget, and utilization for the current month.

## Costs by Agent

```
GET /api/companies/{companyId}/costs/by-agent
```

Returns per-agent cost breakdown for the current month.

## Costs by Project

```
GET /api/companies/{companyId}/costs/by-project
```

Returns per-project cost breakdown for the current month.

## Costs by Run

```
GET /api/companies/{companyId}/costs/by-run
```

One row per heartbeat run that incurred cost, highest-spend first. Accepts the
shared `from`/`to` range plus `limit` (default 100, max 500).

A truncated page is a partial view, not a total: summing `costCents` across one
page gives that page's spend, not the company's. Use
`/costs/run-spend-distribution` for whole-range aggregates.

## Run Spend Distribution

```
GET /api/companies/{companyId}/costs/run-spend-distribution
```

Percentiles over **per-run totals**, not over individual cost events: a run emits
one event per model call, so event-level percentiles would measure the size of a
single billing call rather than what a run costs. This is the endpoint a per-run
spend cap would be set from.

## Cost per Outcome

```
GET /api/companies/{companyId}/costs/cost-per-outcome
```

Spend per completed issue, per project, and per goal. A ratio with no qualifying
issues returns `null` rather than zero or `Infinity`.

## Budget Management

### Set Company Budget

```
PATCH /api/companies/{companyId}
{ "budgetMonthlyCents": 100000 }
```

### Set Agent Budget

```
PATCH /api/agents/{agentId}
{ "budgetMonthlyCents": 5000 }
```

## Budget Enforcement

| Threshold | Effect |
|-----------|--------|
| 80% | Soft alert — agent should focus on critical tasks |
| 100% | Hard stop — agent is auto-paused |

Budget windows reset on the first of each month (UTC).
