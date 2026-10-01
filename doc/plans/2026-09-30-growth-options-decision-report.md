# Growth Options Decision Report

**Date:** 2026-09-30
**Method:** Five parallel research agents, each assigned one lens (competitive landscape, enterprise/procurement, connectors, developer platform, market segments & GTM). Each read the repo first, then researched externally with citations, then returned two proposals.
**Purpose:** Give the board enough evidence to decide what to fund next.

> **Caveat on external numbers.** Every local claim in this report was verified against the repo. External figures (market sizes, GitHub stats, competitor pricing, funding) come from the agents' web research and several are marked UNVERIFIED by the researcher who found them. Spot-check anything you intend to build a plan around.

---

## 1. Executive summary

Five independent research lenses converged on three findings that matter more than any individual feature idea.

**Finding 1 — The competitive white space is the P&L, and Paperclip already owns the hard half of it.**

Every competitor sits on exactly one side of the income statement. Agent runtimes (Devin, Codex, Cursor, Claude Code, Retool Agents) measure *effort*. Vertical outcome agents (Sentry Seer $40/contributor, Agentforce $2.00/conversation, Intercom Fin $0.99/outcome) measure *their own domain's revenue*. Infrastructure (Bedrock AgentCore, LangSmith, Temporal) meters *platform cost*.

**Nobody lets a human board see `revenue − agent spend − margin`, per agent and per goal.** Paperclip's schema is already `companies → goals → projects → issues → runs → cost_events`, and the governed Stripe connection already ships (`packages/shared/src/app-definitions/stripe.json`, tier S4, DCR OAuth against `https://mcp.stripe.com`). The revenue half of the ledger is the only thing missing. The words `revenue` and `mrr` appear **nowhere** in `server/src`, `packages/db/src`, `packages/shared/src`, or `ui/src` — while `doc/PRODUCT.md` promises company-level revenue tracking and `doc/SPEC-implementation.md` §5.2 explicitly excludes it. **The repo contradicts itself on this point today.**

**Finding 2 — Cost control is proven demand, and Paperclip is two thirds of the way there.**

Cognition's own engineering blog concedes the bottleneck: running many agents makes teams "bottlenecked on everything around those agents: the management, planning, and reviewing." Independent Devin reviews report 3–8× ACU overruns with *"no mid-task cost alert in the current UI."* Multiple operator threads report five-to-six× budget blowouts and runaway loops with no alarm.

Paperclip already has monthly hard stops with per-agent and per-company scoping (`budget_policies.hardStopEnabled`, enforced in `server/src/services/budgets.ts`), full run-level cost attribution, and two ad-hoc provider session ceilings. What is missing is a **per-run cap enforced during the run**, a pre-flight estimate, and cost-per-outcome.

**Finding 3 — There is no monetization layer at all, and that is the largest single gap.**

Grepping the repo for billing, subscription, entitlement, plan, or seat returns nothing. There is no `subscriptions` table, no billing route, no Stripe integration for Paperclip itself. There *is* a hosted Paperclip Cloud runtime (`server/src/services/cloud-instance.ts`), a 6,446-line company portability service with GitHub import, a teams catalog with supply-chain trust levels and pinned commits, and a 544-path OpenAPI document.

The reference model is Temporal: MIT core, **>$250M ARR**, 43M self-hosted installs, **+200% YoY**. PostHog: 21k stars → 190k customers. Paperclip's funnel exists; the monetization layer does not.

**Consequence for prioritization:** the top three recommendations below are sequenced so that the cheapest thing unblocks the most expensive thing.

---

## 2. The ten proposals at a glance

Scores are the agents' own, normalized. "Fit" measures alignment with the declared V1 scope in `doc/SPEC-implementation.md` §5.1 and the non-goals in §5.2.

| # | Proposal | Effort | Demand | Diff. | Rev. | Fit | **Total** | Already planned? |
|---|---|---|---|---|---|---|---|---|
| 1 | **Run Guard** — per-run spend caps, pre-flight cost estimate, cost-per-outcome | M | 9 | 9 | 8 | 9 | **8.4** | No |
| 2 | **Agency Portfolio** — per-client companies, client portal, portfolio P&L | M | 7 | 9 | 8 | 7 | **7.4** | No |
| 3 | **Tamper-Evident Audit Ledger** — hash-chained agent actions, SIEM streaming | M | 8 | 9 | 8 | 7 | **7.9** | Partly (§9.10 EE) |
| 4 | **Federated Identity** — SAML/OIDC SSO + SCIM provisioning | M | 9 | 5 | 8 | 5 | **7.2** | No (explicit non-goal) |
| 5 | **Company P&L** — revenue ingestion, margin per agent/goal | S/M | 7 | 8 | 7 | 6 | **7.2** | No (explicitly out of scope) |
| 6 | **CEO-in-a-Box** — meta-agent hires the company + metered Cloud tier | M | 8 | 7 | 7 | 6 | **7.2** | No |
| 7 | **ClipHub** — public registry for agent companies/teams/skills | M | 7 | 9 | 8 | 5 | **7.0** | No (§5.2 out of scope) |
| 8 | **Intercom connector** | S | 8 | 6 | 7 | 8 | **7.2** | **Yes** (Batch B) |
| 9 | **Figma connector** | S–M | 7 | 6 | 6 | 8 | **6.6** | Yes (matrix) |
| 10 | **`@paperclipai/sdk` + `paperclipai harness`** | L | 8 | 6 | 7 | 4 | **5.6** | No |

### What the table tells you

- **Proposals 8 and 9 are work-queue items, not strategy.** Both are already in `doc/connections/FIRST-30-MATRIX.md`. Ship them because they are cheap and they close a visible gap — but do not let them crowd out the strategic bets.
- **Proposal 10 has the worst effort-to-value ratio of the ten** and the reason is measurable: **440 of the 2xx responses in `server/src/routes/openapi.ts` are bare `r.ok()` with no response schema.** Codegen today produces a typed-input / `unknown`-output client. The L effort is almost entirely that response-schema sweep.
- **Proposal 4 is a deliberate reversal of a documented decision.** `doc/PRODUCT.md:130` says "Do not build enterprise-grade RBAC first," and `doc/plans/2026-03-13-features.md` lists enterprise SSO and SCIM as explicit non-goals. That is fine — but it must be a gated paid tier, not a V1 default.

---

## 3. Recommendations

### Recommendation 1 — Do the two "cheap S" items now, in parallel (2 weeks, near-zero risk)

**Ship Intercom and Figma, plus Exa and Apify.**

All four are pure data changes: a manifest entry in `packages/shared/src/self-serve-mcp-research.json`, a row in `scripts/ingest-app-definitions.mjs`, generated `app-definitions/<slug>.json`, an official brand SVG in `ui/public/brands/apps/`, and a doc in `doc/connections/`. **No `server/` or `ui/src/` production code changes.** The catalog currently holds 79 definitions (56 store-visible).

Why Intercom specifically: it is the **only** provider where Paperclip has an empty *category* (zero customer-support connectors), the vendor ships an official self-serve remote MCP, and Ramp's Sep 2026 vendor data puts Intercom at **#1 adopted in AI support bots at 49%**.

Why Figma: MCP write usage **up 75% in a single quarter** (Figma, via Snowflake), and it powers the already-shipped `product/product-design` team — value lands on an existing surface.

**Two non-obvious findings you should know before anyone writes a manifest:**

1. **Intercom publishes no RFC 9728 protected-resource metadata.** Its 401 omits `resource_metadata` and both `.well-known/oauth-protected-resource` paths return 404, while `.well-known/oauth-authorization-server` returns 200. Paperclip's `discoverOAuthEndpoints` chain **cannot resolve it**. The manifest must ship an explicit `defaults.metadataUrl` or a full endpoint pair. This is a supported pattern (Linear does it) — but it is a discovery failure someone will otherwise rediscover as a bug.
2. **Figma's rate limits punish wrong seat tiers silently.** Starter / View / Collab seats get **6 tool calls per month**. An operator on the wrong seat connects successfully, sees a healthy connection, and gets near-zero capability. Nothing errors. This must go in `setupPrerequisite` and `warnings`, with a per-connection rate limit.

**Validation gate for both, before any branding work:** probe the DCR registration redirect-URI constraint. If Intercom rejects loopback HTTP, every self-hosted non-TLS instance loses the connector. Do that first.

### Recommendation 2 — Fund Run Guard next (M, ~4–6 weeks). Highest score in the report.

Paperclip has monthly caps but not **per-run** caps, and the demand evidence is the sharpest in the whole study: named incumbents admitting the gap, five-plus independent buyer threads with dollar figures, and a pain that lands squarely in Paperclip's existing ICP.

The schema work is done — `heartbeat_runs → cost_events → issues → projects/goals` is a complete attribution chain that competitors have to build from traces. The kill path and the `budgetService.getInvocationBlock` enforcement point already exist. The two bespoke ceilings at `server/src/services/native-runtime/provider-profile.ts:397` and `:430` migrate onto the general mechanism as a cleanup, not a rewrite.

The genuine differentiator: on Paperclip a cap is scoped to **an agent, a team subtree, a project, or a goal**, and it is **bidirectional** — it stops the run *and* produces the evidence record that makes the stop auditable rather than mysterious. No competitor can express the scoping because none of them has an org chart.

**The risk that decides the schedule:** a hard mid-run `cancel` on a three-hour research task destroys work and generates exactly the "Paperclip stopped my agent" backlash that kills adoption. Mandatory `warn_percent`, escalating breach action, graceful checkpoint-and-report before cancel.

**Validation gate:** instrument 14 days of real `heartbeat_runs` and compute p50/p95/p99 `spend_used_cents`. Ship only if a cap set at p95 would have fired on **under 2% of runs**. If it fires on more, this is a product liability no matter how good the demand evidence looks.

### Recommendation 3 — Decide the monetization model, because nothing else converts without it

This is the decision that outranks all ten proposals. Not "which feature" but **"how does Paperclip make money."**

Three models, benchmarked:

| Model | Evidence | Read on Paperclip |
|---|---|---|
| **Host the OSS, charge for the cloud** | Temporal: MIT core → **>$250M ARR**, 43M self-hosted installs, +200% YoY, $12.55B valuation | Strongest fit. Paperclip already has `cloud-instance.ts`, a real multi-company model, and BYO-agent economics. |
| **Open core / feature gating** | GitLab >$1B, Grafana >$600M, ClickHouse >$250M, PostHog >$50M | Requires deciding what the OSS boundary is. Currently undefined. |
| **License-gate the self-host** | n8n: source-available (not OSS), self-host key that pings n8n's license server daily | **Do not do this.** n8n is not open source and had to accept that trade. Paperclip's moat is its 16k forks. |

**The reference pricing pattern across every credible entrant is consumption metering on a cheap base, with seats treated as an afterthought.** Agentforce $0.10/action; Datadog $1.30/AI credit; Devin Pro $20 / Max $200 / Teams $80 floor; LangSmith $39/seat; n8n and Zapier Agents both charge **zero per seat**. Open Core Atlas' median cloud entry price converges to **$25–99/mo**.

Paperclip's per-agent monthly budget is, uniquely, already an enforced first-class primitive — and `cost_events` is already the substrate a metering layer would sit on. **That is the asset nobody else has.**

**Concrete ask:** pick the entry price point and the metering unit (recommendation: one Paperclip unit = one agent run, target $0.10–0.30, anchored to Agentforce's $0.10/action) and decide whether self-hosting stays free and unlimited forever. Recommendation: yes, forever.

### Recommendation 4 — If you want one strategic new-customer segment, pick agencies. Highest ACV, cheapest unlock.

71,000 North American digital agencies (200,000+ globally), 87% under 50 people. 2,093 active AI consulting firms. The channel is real and already has a funded incumbent: **Lety.ai claims 1,000+ AI agencies, 2,000+ agents deployed, $2M+ billed through the platform**, with agencies charging clients **$300–$5,000/month**. WhitelabelAI publishes the unit economics: 85–95% margin, under 15 minutes per subsequent client, $500/$1,000/$2,000 per-client tiers.

Four verified blockers, all in the repo:

1. **No `POST /:companyId/clone`.** Confirmed — `server/src/routes/companies.ts` has export, import, archive, delete, branding, and no clone. An agency cannot "copy the dental template into 12 client companies."
2. **No `client_accounts` or `client_company_links` table.** Confirmed — 140 schema files, zero matches.
3. **No external read-only principal.** This is the hard one. It is a new authorization model, not a new page, and it is where a data-leak incident would kill the segment.
4. **Branding is one logo row.**

`doc/PRODUCT.md:121` already names the segment: *"Treat agency / internal team / startup as the same underlying abstraction with different templates and labels."*

**Sequencing matters more here than anywhere else in the report.** Build **clone + client-account grouping only** (~20% of the work), then run a design-partner program with 3 agencies from the existing Discord. Only after 3 agencies have each provisioned 5+ companies does the client portal get built. If agencies turn out not to want per-client agent *organizations* (Lety proves they want per-client agent *tenancy* — a different thing), you find out for two weeks of work instead of two months.

### Recommendation 5 — Protect the connector catalog: MCP has deprecated DCR, and 48 of your connectors depend on it

This one is not a customer-acquisition play. It is an asset-decay warning, and it is the highest-leverage platform change in the connector lane.

**48 of the 56 store-visible connections are `ownershipModes: ["dcr"]`** — dynamic client registration. The MCP spec's own client-registration page now states: *"Dynamic Client Registration is deprecated and retained for backwards compatibility with authorization servers that do not support Client ID Metadata Documents"* (2026-07-28 revision). The prescribed priority is pre-registration → **CIMD** → DCR → prompt the user.

Paperclip already implements all four tiers — `resolveOAuthClientMetadataDocumentUrl` and the `client_id_metadata_document_supported === true` checks exist at `packages/shared/.../tool-access.ts:428, 8822, 8894, 10104`. **The code is ready. The deployment is not.** CIMD requires a **public HTTPS URL per instance**. A self-hosted Paperclip on plain HTTP or a private LAN cannot use it and will silently fall back to DCR for every connector, forever.

**Fix:** make the CIMD client-metadata document a first-class always-served instance endpoint, and add an onboarding check that says *"your instance has no public HTTPS origin, so 48 catalog connectors will use the deprecated DCR path."*

Secondary: promote `defaults.metadataUrl` from a Linear-shaped workaround to a first-class generic capability, and add a lint that flags any definition with neither RFC 9728 reachability nor an explicit metadata hint.

### Recommendation 6 — Defer the SDK, but steal its best half

`@paperclipai/sdk` scores worst in the table (5.6) for a measurable reason: 440 untyped 2xx responses. And differentiation is only 6 — Temporal, Windmill, Trigger.dev, Restate and Dagger all ship SDKs.

But **the harness half is a different proposition.** `paperclipai test-drive` (`cli/src/commands/test-drive.ts`, 17.5 KB) already does isolated data-dir + harness selection; `runDatabaseRestore` exists at `packages/db/src/backup-lib.ts:1051`; embedded Postgres test helpers exist. None of it is packaged for a CI runner. That is an **M**, not an L.

It also closes a real gap: **the eval definitions live in a private repo.** `doc/evals.md:53` states definitions, rosters, case prompts and the report program live in `paperclipai/paperclip-evals`, and four CI workflows require `secrets.COMMITPERCLIP_KEY`. **An OSS contributor cannot run the eval suite.** A credential-free ephemeral instance plus a deterministic fake adapter is the missing public on-ramp.

Also worth noting while in the API: there is **no outbound webhook** surface. Inbound webhooks are extensive; third parties get nothing. Open issue #2897 is the canonical demand artifact, and its diagnosis is worth reading — *"the human operator has to poll the system too much... the biggest UX problem is not raw model quality, it's uncertainty."*

---

## 4. Enterprise lane (for completeness — a decision, not a build)

If enterprise procurement is a 2027 target rather than a 2026 one, the two unlocks are:

- **SSO + SCIM.** The single most frequently cited hard blocker, ahead of SOC 2. Evidence: *"SSO and SCIM are the two that block deals most often, because without them the customer cannot onboard or offboard users at their own scale."* Current posture is email/password only (`server/src/auth/better-auth.ts:273`), no MFA, one instance role (`instance_admin`). Better Auth's SAML/SCIM plugins under the pinned 1.7.2 are **UNVERIFIED** — check before committing.
- **Tamper-evident audit ledger.** Strongest differentiation in the report: `activity_log` already separates `actorType`/`actorId`, `responsibleUserId`, `runId`, and `agentId` as independent columns. CSA calls out that "agent actions blending into the human user's audit record" is a high-priority remediation item — **Paperclip's schema already models the fix.** One concrete defect to fix regardless: deleting an agent currently deletes its audit history (`server/src/services/agents.ts:1074-1079`), which is a control failure on its face.

Neither requires the other, but the same CISO usually asks both questions in the same meeting.

**One thing to schedule regardless of which proposal wins:** there is no SBOM and no CodeQL in `.github/workflows/`, `SECURITY.md` is eight lines, and there is no documented compliance posture anywhere in `doc/`. For a product whose pitch is governance and auditability, that is a live commercial gap.

---

## 5. What needs a decision from you

| # | Decision | Why it blocks |
|---|---|---|
| **D1** | **Monetization model and price point.** Self-host free forever, or gated? Metering unit = agent run? Entry price? | Nothing converts without it. Every revenue score in this report is conditional on this answer. |
| **D2** | **Am I moving `SPEC-implementation.md` §5.2?** It currently excludes "Revenue/expense accounting beyond model/token costs" while `doc/PRODUCT.md` promises company-level revenue tracking. | Company P&L cannot be built quietly against a spec that forbids it. Needs a board decision, recorded. |
| **D3** | **One new customer segment, or none?** Agencies (highest ACV $6k–$33k, cheapest unlock, proven channel) vs. non-technical founders (biggest volume, lowest ACV) vs. enterprise (highest ACV, longest cycle). | Determines which of Recommendations 4–6 get funded. |
| **D4** | **Is ClipHub in or out?** It is a named §5.2 non-goal, but the substrate is ~85% built and two abandoned plan docs already describe it. | Avoids a third round of planning it without building it. |
| **D5** | **Do we require public HTTPS on self-hosted instances?** | Determines whether CIMD ships and whether the DCR deprecation becomes a real problem for self-hosters. |

---

## 6. Suggested 90-day sequence

| Weeks | Work | Gate before proceeding |
|---|---|---|
| 1–2 | Intercom, Figma, Exa, Apify connectors. CIMD first-class endpoint + the no-HTTPS onboarding warning. | DCR redirect-URI probe passes for Intercom and Figma. |
| 2–4 | **Run Guard** — schema, enforcement point, UI. Shadow-mode instrumentation running first. | 14-day p95 cap fires on <2% of runs. |
| 3–4 | Decide D1–D5. Write the decisions down. | — |
| 5–8 | **Billing/metering layer** on `cost_events`, if D1 lands. Or **clone + client accounts**, if D3 lands on agencies. | 50 self-serve users have asked to pay. 3 design-partner agencies provisioned 5+ companies. |
| 9–12 | **Company P&L** revenue ingestion (read-only) — *only after* D2 resolves. **Or** SSO + SCIM, if enterprise is the 2027 target. | MRR definition signed off by 5 users running real revenue. Better Auth SAML verified against a real Okta org. |
| Backlog | `paperclipai harness` as a CI-runnable ephemeral instance. Outbound webhooks. Helm chart. Audit log delete-path fix. | — |

---

## Appendix — verified gaps in the current build

Confirmed directly against the repo during compilation:

| Claim | Status |
|---|---|
| 79 app definition JSONs, 56 store-visible | Verified |
| `POST /:companyId/clone` does not exist | Verified — no match in `server/src/routes/companies.ts` |
| `client_accounts` / `client_company_links` tables do not exist | Verified — no match in `packages/db/src/schema/` |
| `@paperclipai/sdk` package does not exist | Verified — not in `packages/` |
| Budget hard-stop already implemented | Verified — `hardStopEnabled` at `budgets.ts:601, 693, 770` |
| Onboarding seed creates a single CEO agent | Verified — `onboarding-seed.ts:27` `SEEDED_AGENT_ROLE = "ceo"` |
| `SPEC-implementation.md` §5.2 excludes revenue accounting and ClipHub | Verified — lines 86, 88 |
| No billing / subscription / entitlement code | Verified — no billing route, no billing tables |
