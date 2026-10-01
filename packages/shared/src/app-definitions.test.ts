import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_DEFINITIONS } from "./app-definitions.generated.js";
import {
  APP_STORE_DEFINITIONS,
  APP_STORE_HIDDEN_SLUGS,
  CONNECTABLE_APP_DEFINITIONS,
  appSupportsCatalogSetup,
  getAvailableConnectionMethod,
  getAppDefinitionForUrl,
  getRecommendedConnectionMethod,
  recommendedDefaultsForApp,
  resolveConnectionMethodServerUrl,
} from "./app-definitions.js";
import {
  GOOGLE_WORKSPACE_CONNECTOR_PROFILE_IDS,
  GOOGLE_WORKSPACE_CONNECTOR_PROFILES,
  type GoogleWorkspaceConnectorProfileId,
} from "./google-workspace-connectors.js";
import {
  BLOCKED_MCP_PROVIDERS,
  SELF_SERVE_MCP_CANDIDATES,
  SELF_SERVE_MCP_RESEARCH,
} from "./self-serve-mcp-research.js";
import { appDefinitionsSchema } from "./validators/app-definition.js";

const googleScope = (scope: string) =>
  `https://www.googleapis.com/auth/${scope}`;
const GOOGLE_WORKSPACE_PROFILE_EXPECTATIONS = [
  {
    profile: "gmail.read",
    appSlug: "gmail",
    serverUrl: "https://gmailmcp.googleapis.com/mcp/v1",
    capability: "read",
    riskTier: "S3",
    scopes: [googleScope("gmail.readonly")],
    writeTools: [],
  },
  {
    profile: "gmail.draft",
    appSlug: "gmail",
    serverUrl: "https://gmailmcp.googleapis.com/mcp/v1",
    capability: "draft",
    riskTier: "S4",
    scopes: [googleScope("gmail.readonly"), googleScope("gmail.compose")],
    writeTools: ["create_draft"],
  },
  {
    profile: "drive.read",
    appSlug: "google-drive",
    serverUrl: "https://drivemcp.googleapis.com/mcp/v1",
    capability: "read",
    riskTier: "S3",
    scopes: [googleScope("drive.readonly")],
    writeTools: [],
  },
  {
    profile: "drive.write",
    appSlug: "google-drive",
    serverUrl: "https://drivemcp.googleapis.com/mcp/v1",
    capability: "write",
    riskTier: "S4",
    scopes: [googleScope("drive.readonly"), googleScope("drive.file")],
    writeTools: ["copy_file", "create_file"],
  },
  {
    profile: "docs.read",
    appSlug: "google-docs",
    serverUrl: "https://docsmcp.googleapis.com/mcp/v1",
    capability: "read",
    riskTier: "S3",
    scopes: [googleScope("drive.readonly"), googleScope("documents.readonly")],
    writeTools: [],
  },
  {
    profile: "docs.write",
    appSlug: "google-docs",
    serverUrl: "https://docsmcp.googleapis.com/mcp/v1",
    capability: "write",
    riskTier: "S4",
    scopes: [
      googleScope("drive.readonly"),
      googleScope("drive.file"),
      googleScope("documents"),
    ],
    writeTools: ["update_doc"],
  },
  {
    profile: "sheets.read",
    appSlug: "google-sheets",
    serverUrl: "https://sheetsmcp.googleapis.com/mcp/v1",
    capability: "read",
    riskTier: "S3",
    scopes: [
      googleScope("drive.readonly"),
      googleScope("spreadsheets.readonly"),
    ],
    writeTools: [],
  },
  {
    profile: "sheets.write",
    appSlug: "google-sheets",
    serverUrl: "https://sheetsmcp.googleapis.com/mcp/v1",
    capability: "write",
    riskTier: "S4",
    scopes: [
      googleScope("drive.readonly"),
      googleScope("drive.file"),
      googleScope("spreadsheets"),
    ],
    writeTools: [
      "update_spreadsheet",
      "update_values",
      "update_formulas",
      "insert_dimension",
    ],
  },
  {
    profile: "slides.read",
    appSlug: "google-slides",
    serverUrl: "https://slidesmcp.googleapis.com/mcp/v1",
    capability: "read",
    riskTier: "S3",
    scopes: [
      googleScope("drive.readonly"),
      googleScope("presentations.readonly"),
    ],
    writeTools: [],
  },
  {
    profile: "slides.write",
    appSlug: "google-slides",
    serverUrl: "https://slidesmcp.googleapis.com/mcp/v1",
    capability: "write",
    riskTier: "S4",
    scopes: [
      googleScope("drive.readonly"),
      googleScope("drive.file"),
      googleScope("presentations"),
    ],
    writeTools: ["update_presentation"],
  },
  {
    profile: "calendar.read",
    appSlug: "google-calendar",
    serverUrl: "https://calendarmcp.googleapis.com/mcp/v1",
    capability: "read",
    riskTier: "S3",
    scopes: [
      googleScope("calendar.calendarlist.readonly"),
      googleScope("calendar.events.freebusy"),
      googleScope("calendar.events.readonly"),
    ],
    writeTools: [],
  },
  {
    profile: "calendar.write",
    appSlug: "google-calendar",
    serverUrl: "https://calendarmcp.googleapis.com/mcp/v1",
    capability: "write",
    riskTier: "S4",
    scopes: [
      googleScope("calendar.calendarlist.readonly"),
      googleScope("calendar.events.freebusy"),
      googleScope("calendar.events"),
    ],
    writeTools: [
      "create_event",
      "update_event",
      "delete_event",
      "respond_to_event",
    ],
  },
  {
    profile: "chat.read",
    appSlug: "google-chat",
    serverUrl: "https://chatmcp.googleapis.com/mcp/v1",
    capability: "read",
    riskTier: "S3",
    scopes: [
      googleScope("chat.spaces.readonly"),
      googleScope("chat.messages.readonly"),
    ],
    writeTools: [],
  },
  {
    profile: "chat.write",
    appSlug: "google-chat",
    serverUrl: "https://chatmcp.googleapis.com/mcp/v1",
    capability: "write",
    riskTier: "S4",
    scopes: [
      googleScope("chat.spaces.readonly"),
      googleScope("chat.messages.readonly"),
      googleScope("chat.messages.create"),
    ],
    writeTools: ["send_message"],
  },
  {
    profile: "people.read",
    appSlug: "google-people",
    serverUrl: "https://people.googleapis.com/mcp/v1",
    capability: "read",
    riskTier: "S3",
    scopes: [
      googleScope("directory.readonly"),
      googleScope("userinfo.profile"),
      googleScope("contacts.readonly"),
    ],
    writeTools: [],
  },
  {
    profile: "workspace-search.read",
    appSlug: "google-workspace-search",
    serverUrl: "https://workspacemcp.googleapis.com/mcp/v1",
    capability: "read",
    riskTier: "S3",
    scopes: [
      googleScope("gmail.readonly"),
      googleScope("drive.readonly"),
      googleScope("calendar.readonly"),
      googleScope("chat.messages.readonly"),
    ],
    writeTools: [],
  },
] as const satisfies ReadonlyArray<{
  profile: GoogleWorkspaceConnectorProfileId;
  appSlug: string;
  serverUrl: string;
  capability: "read" | "write" | "draft";
  riskTier: "S3" | "S4";
  scopes: readonly string[];
  writeTools: readonly string[];
}>;
describe("AppDefinition catalog", () => {
  it("offers Anthropic runtime authentication without the unsupported REST tool method", () => {
    const anthropic = APP_DEFINITIONS.find((app) => app.slug === "anthropic")!;
    expect(anthropic.methods.map((method) => method.key)).toEqual(["ai-subscription", "ai-api_key"]);
    expect(anthropic.methods.every((method) => method.purpose === "ai" && method.transport === "runtime_auth")).toBe(true);
    expect(getAvailableConnectionMethod(anthropic, "api-key")).toBeNull();
  });

  it("validates all Wave 1 definitions", () =>
    expect(() => appDefinitionsSchema.parse(APP_DEFINITIONS)).not.toThrow());
  it("contains every established provider plus the reviewed self-serve catalog", () => {
    expect(APP_DEFINITIONS.map((app) => app.slug)).toEqual(
      expect.arrayContaining([
        "zapier",
        "github",
        "discord",
        "slack",
        "microsoft-teams",
        "telegram",
        "notion",
        "posthog",
        "linear",
        "google-sheets",
        "context7",
        "composio",
        "oauth-generic",
        "api-key-generic",
        "sentry",
        "vercel",
        "anthropic",
        "gmail",
        "google-drive",
        "google-docs",
        "google-slides",
        "google-calendar",
        "google-chat",
        "google-people",
        "google-workspace-search",
      ]),
    );
    expect(SELF_SERVE_MCP_CANDIDATES).toHaveLength(52);
    expect(BLOCKED_MCP_PROVIDERS.map((entry) => entry.slug)).toEqual([
      "g2",
      "vercel",
      "zomato",
    ]);
    const definitionSlugs = new Set(APP_DEFINITIONS.map((app) => app.slug));
    const connectableSlugs = new Set(
      CONNECTABLE_APP_DEFINITIONS.map((app) => app.slug),
    );
    expect(
      SELF_SERVE_MCP_CANDIDATES.filter(
        (entry) => !definitionSlugs.has(entry.slug),
      ),
    ).toEqual([]);
    expect(
      SELF_SERVE_MCP_CANDIDATES.filter(
        (entry) => !connectableSlugs.has(entry.slug),
      ),
    ).toEqual([]);
    for (const entry of BLOCKED_MCP_PROVIDERS)
      expect(connectableSlugs.has(entry.slug)).toBe(false);
  });
  it("registers the five native chat providers with only required setup credentials", () => {
    const expected = {
      slack: {
        credentials: ["botToken", "signingSecret"],
        publicFields: [],
        resources: ["workspace", "channel"],
        tool: true,
      },
      github: {
        credentials: ["appId", "privateKey"],
        publicFields: ["appId"],
        resources: ["organization", "repository"],
        tool: true,
      },
      discord: {
        credentials: ["botToken", "applicationId", "guildId"],
        publicFields: ["applicationId", "guildId"],
        resources: ["channel"],
        tool: false,
      },
      "microsoft-teams": {
        credentials: ["clientId", "tenantId", "clientSecret"],
        publicFields: ["clientId", "tenantId"],
        resources: ["team", "channel", "chat"],
        tool: false,
      },
      telegram: {
        credentials: ["botToken"],
        publicFields: [],
        resources: ["chat", "group", "topic"],
        tool: false,
      },
    } as const;
    for (const [slug, contract] of Object.entries(expected)) {
      const app = CONNECTABLE_APP_DEFINITIONS.find(
        (candidate) => candidate.slug === slug,
      );
      const channel = app?.methods.find(
        (candidate) => candidate.purpose === "channel",
      );
      expect(app, slug).toBeTruthy();
      expect(channel, slug).toMatchObject({
        key: "chat-agent",
        label: "Chat with an agent",
        purpose: "channel",
        provider: slug,
        transport: "chat_sdk",
        auth: "api_key",
        ownershipModes: ["customer"],
        requiredResourceFilters: contract.resources,
      });
      expect(
        channel?.credentialFields?.map((field) => field.key),
        slug,
      ).toEqual(contract.credentials);
      expect(
        channel?.credentialFields?.every((field) => field.required),
        slug,
      ).toBe(true);
      for (const field of channel?.credentialFields ?? []) {
        if ((contract.publicFields as readonly string[]).includes(field.key))
          expect(field, `${slug}/${field.key}`).toMatchObject({
            type: "text",
            secret: false,
          });
        else expect(field.secret, `${slug}/${field.key}`).toBe(true);
      }
      expect(channel?.keyPlacement, slug).toBeUndefined();
      const toolMethods =
        app?.methods.filter(
          (candidate) => (candidate.purpose ?? "tool") === "tool",
        ) ?? [];
      expect(toolMethods.length > 0, `${slug}: tool surface`).toBe(
        contract.tool,
      );
      if (contract.tool)
        expect(
          toolMethods.some(
            (candidate) =>
              candidate.label === "Use this connection as an agent tool",
          ),
          slug,
        ).toBe(true);
    }
  });
  it("documents the minimum provider-owned chat app setup without broader permissions", () => {
    const channel = (slug: string) =>
      APP_DEFINITIONS.find((app) => app.slug === slug)?.methods.find(
        (method) => method.purpose === "channel",
      );
    expect(channel("github")?.guidanceMd).toContain("issue_comment");
    expect(channel("discord")?.guidanceMd).toContain("Message Content intent");
    expect(channel("discord")?.guidanceMd).toContain("Discord thread");
    expect(channel("github")?.guidanceMd).toContain("pull_request");
    expect(channel("github")?.guidanceMd).toContain(
      "pull_request_review_comment",
    );
    expect(channel("github")?.guidanceMd).toContain(
      "installation_repositories",
    );
    expect(channel("github")?.guidanceMd).toContain(
      "Generate the webhook secret in Paperclip",
    );
    expect(channel("github")?.guidanceMd).toContain("SSL-verified");
    expect(channel("microsoft-teams")?.guidanceMd).toContain(
      "resource-specific",
    );
    expect(channel("microsoft-teams")?.guidanceMd).toContain(
      "ChannelMessage.Read.Group",
    );
    expect(channel("microsoft-teams")?.guidanceMd).toContain(
      "ChatMessage.Read.Chat",
    );
    expect(channel("microsoft-teams")?.guidanceMd).toContain(
      "work or school organization",
    );
    expect(channel("microsoft-teams")?.guidanceMd).toContain("teams.live.com");
    expect(channel("microsoft-teams")?.guidanceMd).toContain("groupChat");
    expect(channel("microsoft-teams")?.guidanceMd).toContain(
      "receive every message",
    );
    expect(channel("microsoft-teams")?.guidanceMd).toContain(
      "One team install covers its standard channels",
    );
    expect(channel("telegram")?.guidanceMd).toContain(
      "public Paperclip webhook endpoint",
    );
    expect(channel("slack")?.guidanceMd).toContain("reactions");
    expect(channel("slack")?.guidanceMd).toContain("direct messages");
  });
  it("keeps a complete, unique, dated evidence ledger for all 55 researched MCP providers", () => {
    // The date is the most recent verification pass, not a per-entry claim. The
    // 2026-08-26 pass covered the first 51 providers; Intercom, Figma, Exa, and
    // Apify were re-probed against live metadata on 2026-09-30. Do not read the
    // shared date as saying every entry was re-checked that day — each provider
    // doc records its own probe evidence and open questions.
    expect(SELF_SERVE_MCP_RESEARCH.verifiedAt).toBe("2026-09-30");
    // The caveat now travels with the data, not only with this comment.
    expect(SELF_SERVE_MCP_RESEARCH.verifiedAtNote).toContain("2026-09-30");
    for (const slug of ["intercom", "figma", "exa", "apify"])
      expect(SELF_SERVE_MCP_RESEARCH.verifiedAtNote).toContain(slug);
    expect(SELF_SERVE_MCP_RESEARCH.entries).toHaveLength(55);
    expect(
      new Set(SELF_SERVE_MCP_RESEARCH.entries.map((entry) => entry.slug)),
    ).toHaveProperty("size", 55);
    for (const entry of SELF_SERVE_MCP_RESEARCH.entries) {
      expect(new URL(entry.docsUrl).protocol).toBe("https:");
      expect(new URL(entry.serverUrl).protocol).toBe("https:");
      expect(entry.authMode).toBeTruthy();
      expect(entry.prerequisite.length).toBeGreaterThan(10);
      expect(["S1", "S2", "S3", "S4"]).toContain(entry.riskTier);
    }
  });
  it("offers Fireflies browser sign-in and a vaulted bearer key on the same official MCP endpoint", () => {
    const app = APP_STORE_DEFINITIONS.find((entry) => entry.slug === "fireflies")!;
    expect(getAppDefinitionForUrl("https://api.fireflies.ai/mcp")?.slug).toBe("fireflies");
    expect(app.methods.map((method) => method.key)).toEqual(["mcp-oauth", "mcp-api-key"]);
    expect(app.methods[0]).toMatchObject({
      transport: "mcp_remote", auth: "oauth", ownershipModes: ["dcr"],
      defaults: { serverUrl: "https://api.fireflies.ai/mcp", scopesHint: ["email", "profile"] },
    });
    expect(app.methods[1]).toMatchObject({
      auth: "api_key", defaults: { serverUrl: "https://api.fireflies.ai/mcp" },
      credentialFields: [{ key: "authorization", secret: true, type: "password", required: true }],
      keyPlacement: { location: "header", name: "Authorization", prefix: "Bearer " },
    });
  });

  it("routes both Intercom regions to the right host and leaves OAuth to discovery", () => {
    const app = APP_STORE_DEFINITIONS.find((entry) => entry.slug === "intercom")!;
    // Both hosts have to be recognized or a pasted EU URL drops into the
    // generic connector instead of this curated definition.
    expect(getAppDefinitionForUrl("https://mcp.intercom.com/mcp")?.slug).toBe("intercom");
    expect(getAppDefinitionForUrl("https://mcp.eu.intercom.com/mcp")?.slug).toBe("intercom");
    expect(getAppDefinitionForUrl("https://mcp.intercom.com/sse")?.slug).toBe("intercom");
    expect(getAppDefinitionForUrl("https://mcp.eu.intercom.com/sse")?.slug).toBe("intercom");
    expect(getAppDefinitionForUrl("https://mcp.au.intercom.com/mcp")).toBeNull();
    expect(app.urlPatterns).toEqual([
      "https://mcp.intercom.com/*",
      "https://mcp.eu.intercom.com/*",
    ]);
    expect(app.categories).toEqual(["communication"]);
    expect(app.docsUrl).toBe("https://developers.intercom.com/docs/guides/mcp");
    expect(app.setupPrerequisite?.description).toContain("AU hosted workspaces");
    expect(app.setupPrerequisite?.actionUrl).toBe(
      "https://developers.intercom.com/docs/guides/mcp",
    );
    expect(
      app.methods.map((method) => ({
        key: method.key,
        label: method.label,
        serverUrl: method.defaults?.serverUrl,
        metadataUrl: method.defaults?.metadataUrl,
      })),
    ).toEqual([
      {
        key: "mcp-oauth-us",
        label: "US hosted workspace",
        serverUrl: "https://mcp.intercom.com/mcp",
        // Intercom's US host publishes authorization-server metadata only at
        // the origin form of RFC 8414. See the RFC 9728 note below.
        metadataUrl:
          "https://mcp.intercom.com/.well-known/oauth-authorization-server",
      },
      {
        key: "mcp-oauth-eu",
        label: "EU hosted workspace",
        serverUrl: "https://mcp.eu.intercom.com/mcp",
        // The EU host is a separate deployment with its own issuer, so the hint
        // has to be region-specific. Reusing the US document would point an EU
        // workspace's token exchange at the US region.
        metadataUrl:
          "https://mcp.eu.intercom.com/.well-known/oauth-authorization-server",
      },
    ]);
    for (const method of app.methods) {
      expect(method).toMatchObject({
        transport: "mcp_remote",
        auth: "oauth",
        ownershipModes: ["dcr"],
        riskTier: "S3",
        requiredResourceFilters: ["workspace", "inbox", "team"],
      });
      // Paperclip sends `scopesHint` verbatim as the OAuth `scope` parameter and
      // Intercom's AS metadata advertises no `scopes_supported` at all (verified
      // on both hosts 2026-09-30), so nothing on the wire checks these. They are
      // Intercom's own strings from its OAuth Scopes page, not shortened or
      // recased: "Read users and companies" is missing "and list", and the
      // articles scope is capitalised differently there than on the MCP guide.
      expect(method.defaults?.scopesHint).toEqual([
        "Read and list users and companies",
        "Read conversations",
        "Write conversations",
        "Read and Write Articles",
      ]);
      expect(method.warnings?.join(" ")).toContain("AU hosted workspaces are not supported");
      // Every Intercom endpoint lives on the method's own regional host. A hint
      // that crosses regions silently sends a workspace's data to the wrong one.
      const host = new URL(method.defaults!.serverUrl!).host;
      expect(new URL(method.defaults!.metadataUrl!).host).toBe(host);
    }
    // Intercom publishes no RFC 9728 protected-resource metadata, so the hint is
    // the origin-form RFC 8414 document, named rather than left to discovery.
    // Shipping a fixed authorization/token *pair* instead would switch discovery
    // off entirely (see `oauthEndpointsForConnection`), which also drops the
    // discovery result's `registration_endpoint` and leaves DCR with nothing to
    // register against. Pin the reviewed shape so nobody "fixes" this the wrong
    // way.
    for (const method of app.methods) {
      expect(method.defaults?.authorizationEndpoint).toBeUndefined();
      expect(method.defaults?.tokenEndpoint).toBeUndefined();
    }
    expect(getRecommendedConnectionMethod(app.methods)?.key).toBe("mcp-oauth-us");
  });
  it("documents why Intercom needs an OAuth metadata hint and Figma does not", () => {
    const intercom = APP_STORE_DEFINITIONS.find((entry) => entry.slug === "intercom")!;
    const figma = APP_STORE_DEFINITIONS.find((entry) => entry.slug === "figma")!;
    // The negative case, pinned so the reason survives. Intercom serves no
    // RFC 9728 document at all: `GET /mcp` answers 401 with
    // `Bearer realm="OAuth", error="invalid_token", error_description="Missing
    // or invalid access token"` and no `resource_metadata` parameter, so
    // `challengeOAuthHints` yields nothing, and both
    // `/.well-known/oauth-protected-resource/mcp` and
    // `/.well-known/oauth-protected-resource` answer 404. There is therefore no
    // advertised authorization server to follow — the only RFC 9728 route to an
    // issuer is broken. `defaults.metadataUrl` is what names the working
    // origin-form RFC 8414 document instead, and it is honored in two places:
    // `preflightGalleryAppMetadata` queues it ahead of the derived candidates,
    // and `oauthProviderEndpoints` refuses to resolve any endpoint at all
    // without it. Both are load-bearing, so the key is asserted here rather than
    // left to a comment.
    for (const method of intercom.methods) {
      expect(method.defaults?.metadataUrl).toMatch(
        /^https:\/\/mcp(\.eu)?\.intercom\.com\/\.well-known\/oauth-authorization-server$/,
      );
    }
    // Figma is the control case and proves the hint is not cargo-culted. Its
    // RFC 9728 chain resolves on the *first* candidate:
    // `https://mcp.figma.com/.well-known/oauth-protected-resource/mcp` answers
    // 200 with `authorization_servers: ["https://api.figma.com"]`, and
    // `https://api.figma.com/.well-known/oauth-authorization-server` then
    // supplies authorization, token and registration endpoints. Nothing is
    // wasted probing, so a hint would only add a second source of truth to keep
    // in step with Figma's own documents.
    expect(figma.methods[0]?.defaults?.metadataUrl).toBeUndefined();
    expect(figma.methods[0]?.defaults?.discoveryUrl).toBeUndefined();
  });
  it("scopes Figma to one user, one reviewed scope, and a customer-owned client", () => {
    const app = APP_STORE_DEFINITIONS.find((entry) => entry.slug === "figma")!;
    expect(getAppDefinitionForUrl("https://mcp.figma.com/mcp")?.slug).toBe("figma");
    expect(app.categories).toEqual(["content"]);
    expect(app.docsUrl).toBe("https://developers.figma.com/docs/figma-mcp-server/");
    expect(app.methods.map((method) => method.key)).toEqual(["mcp-oauth"]);
    const method = app.methods[0]!;
    expect(method).toMatchObject({
      transport: "mcp_remote",
      auth: "oauth",
      // `dcr` is deliberately absent. Figma advertises
      // `registration_endpoint: https://api.figma.com/v1/oauth/mcp/register` but
      // that endpoint answers 403 Forbidden for every payload shape tried
      // (measured 2026-09-30), and Figma documents that only clients in its MCP
      // catalog may connect. `customer` is the only mode that can work: the
      // operator signs in with a Figma-reviewed client ID and secret, or the
      // deployment preconfigures them. Shipping `dcr` sends a default operator
      // into `502 oauth_dynamic_client_registration_failed`.
      ownershipModes: ["customer"],
      grantKinds: ["user"],
      riskTier: "S3",
      defaults: {
        serverUrl: "https://mcp.figma.com/mcp",
        scopesHint: ["mcp:connect"],
      },
      requiredResourceFilters: ["team", "project", "file"],
    });
    // Discovery works on Figma, so the manifest must not pin the endpoints.
    expect(method.defaults?.authorizationEndpoint).toBeUndefined();
    expect(method.defaults?.tokenEndpoint).toBeUndefined();
    // The refused registration and the seat-limit table have to be visible before
    // credentials: a wrong-seat connection connects cleanly and then delivers
    // nothing, and a DCR-shaped attempt fails at registration.
    const warnings = method.warnings?.join(" ") ?? "";
    expect(warnings).toContain("v1/oauth/mcp/register");
    expect(warnings).toContain("403");
    expect(warnings).toContain("Figma-reviewed");
    expect(app.setupPrerequisite?.title).toBe("A seat that can actually use MCP");
    expect(app.setupPrerequisite?.steps?.join(" ")).toContain("Seat type");
    // The seat numbers are quoted from Figma's rate-limits page, which is also
    // where the copy says the source lives, and the Starter disagreement between
    // that page and Figma's mcp-server-guide is stated rather than smoothed over.
    const prerequisite = app.setupPrerequisite?.description ?? "";
    expect(prerequisite).toContain(
      "developers.figma.com/docs/figma-mcp-server/rate-limits-access/",
    );
    expect(prerequisite).toContain("up to 20 tool calls a month on Starter");
    expect(prerequisite).toContain("up to 6 a month on Professional");
    expect(prerequisite).toContain("mcp-server-guide");
    expect(prerequisite).not.toContain("6 read tool calls per month");
  });
  it("offers Exa browser sign-in or a vaulted x-api-key on the hosted server", () => {
    const app = APP_STORE_DEFINITIONS.find((entry) => entry.slug === "exa")!;
    expect(getAppDefinitionForUrl("https://mcp.exa.ai/mcp")?.slug).toBe("exa");
    expect(getAppDefinitionForUrl("https://mcp.exa.ai/mcp?login")?.slug).toBe("exa");
    expect(app.categories).toEqual(["ai"]);
    expect(app.docsUrl).toBe("https://exa.ai/docs/get-started/exa-mcp");
    expect(app.methods.map((method) => method.key)).toEqual(["mcp-oauth", "mcp-api-key"]);
    expect(app.methods[0]).toMatchObject({
      transport: "mcp_remote",
      auth: "oauth",
      ownershipModes: ["dcr"],
      // S1 reads: public web search and page fetches, no customer data.
      riskTier: "S1",
      // Exa documents interactive OAuth at `?login` and API-key mode at the bare
      // URL. The bare URL answers anonymously, and the anonymous profile is the
      // one without `agent_run` (measured 2026-09-30: two tools keyless, three
      // with a bearer token), so the OAuth method must carry the query.
      defaults: {
        serverUrl: "https://mcp.exa.ai/mcp?login",
        scopesHint: ["mcp:tools"],
      },
    });
    expect(app.methods[1]).toMatchObject({
      auth: "api_key",
      ownershipModes: ["customer"],
      riskTier: "S1",
      defaults: { serverUrl: "https://mcp.exa.ai/mcp" },
      credentialFields: [
        { key: "authorization", secret: true, type: "password", required: true },
      ],
      // Exa's hosted server documents `x-api-key`. Its REST API also accepts
      // Authorization: Bearer, so the default placement would be wrong here.
      keyPlacement: { location: "header", name: "x-api-key", prefix: null },
    });
    // Exa Agent is billed usage, which is the one thing an operator must see
    // before an agent can spend it unattended — and it needs OAuth *or* an API
    // key, so the warning must not tell an operator that only a key works.
    for (const method of app.methods) {
      const warnings = method.warnings?.join(" ") ?? "";
      expect(warnings).toContain("billed usage");
      expect(warnings).toContain("requires OAuth or an API key");
      expect(warnings).not.toContain("an Exa API key is required");
    }
  });
  it("offers Apify browser sign-in or a vaulted bearer token on one hosted endpoint", () => {
    const app = APP_STORE_DEFINITIONS.find((entry) => entry.slug === "apify")!;
    // Apify's MCP server is one endpoint, not one per Actor. Actors are selected
    // through the tools query parameter and run against the signed-in account.
    expect(getAppDefinitionForUrl("https://mcp.apify.com/")?.slug).toBe("apify");
    expect(getAppDefinitionForUrl("https://mcp.apify.com/sse")?.slug).toBe("apify");
    expect(app.categories).toEqual(["developer"]);
    expect(app.docsUrl).toBe("https://docs.apify.com/platform/integrations/mcp");
    expect(app.methods.map((method) => method.key)).toEqual(["mcp-oauth", "mcp-api-key"]);
    // Apify's own MCP telemetry is enabled by default for every tool call and the
    // documented remote opt-out is the `telemetry-enabled=false` query parameter,
    // so both methods ship the opt-out URL. The path stays `/` because
    // `protectedResourceMetadataUrls` reads only the path: an empty path derives
    // the origin-form RFC 9728 candidate, which is the only form Apify serves.
    const TELEMETRY_OFF = "https://mcp.apify.com/?telemetry-enabled=false";
    expect(app.methods[0]).toMatchObject({
      transport: "mcp_remote",
      auth: "oauth",
      ownershipModes: ["dcr"],
      riskTier: "S2",
      defaults: { serverUrl: TELEMETRY_OFF, scopesHint: ["full_api_access"] },
      requiredResourceFilters: ["account", "actor", "dataset"],
    });
    expect(app.methods[1]).toMatchObject({
      auth: "api_key",
      riskTier: "S2",
      defaults: { serverUrl: TELEMETRY_OFF },
      credentialFields: [
        { key: "authorization", secret: true, type: "password", required: true },
      ],
      keyPlacement: { location: "header", name: "Authorization", prefix: "Bearer " },
      consoleLinks: { keys: "https://console.apify.com/account/integrations" },
      requiredResourceFilters: ["account", "actor", "dataset"],
    });
    for (const method of app.methods) {
      const warnings = method.warnings?.join(" ") ?? "";
      expect(warnings).toContain("plan usage");
      // The default-on telemetry collection has to be named, with the opt-out.
      expect(warnings).toContain("collects telemetry");
      expect(warnings).toContain("enabled by default");
      expect(warnings).toContain("telemetry-enabled=false");
    }
  });

  it("uses the reviewed current endpoints and configuration modes", () => {
    const method = (slug: string, key?: string) =>
      APP_DEFINITIONS.find((app) => app.slug === slug)?.methods.find(
        (candidate) => !key || candidate.key === key,
      );
    expect(method("jira")?.defaults?.serverUrl).toBe(
      "https://mcp.atlassian.com/v1/mcp/authv2",
    );
    expect(method("jira")?.defaults?.scopesHint).toEqual([
      "read:me",
      "read:account",
      "offline_access",
      "email",
      "read:jira-work",
      "write:jira-work",
      "search:confluence",
      "read:confluence-user",
      "read:page:confluence",
      "write:page:confluence",
      "read:comment:confluence",
      "write:comment:confluence",
      "read:space:confluence",
      "read:hierarchical-content:confluence",
      "write:component:compass",
      "read:component:compass",
      "read:scorecard:compass",
      "write:scorecard:compass",
      "read:event:compass",
      "read:metric:compass",
      "read:all:twg",
      "write:all:twg",
    ]);
    expect(method("cloudinary")?.defaults?.serverUrl).toBe(
      "https://asset-management.mcp.cloudinary.com/mcp",
    );
    expect(method("kernel")?.defaults?.serverUrl).toBe(
      "https://mcp.onkernel.com/mcp",
    );
    expect(method("resend")?.defaults?.serverUrl).toBe(
      "https://mcp.resend.com/mcp",
    );
    expect(method("clickhouse")?.defaults?.serverUrl).toBe(
      "https://mcp.clickhouse.cloud/clickstack",
    );
    expect(method("clickhouse")?.tenantFields?.[0]?.transport).toEqual({
      location: "header",
      name: "x-service-id",
    });
    expect(method("mem0")).toMatchObject({
      auth: "api_key",
      keyPlacement: {
        location: "header",
        name: "Authorization",
        prefix: "Bearer ",
      },
    });
    expect(method("mem0")?.defaults?.serverUrl).toBe(
      "https://mcp.mem0.ai/mcp/",
    );
    expect(method("xero")?.defaults?.scopesHint).toEqual([
      "openid",
      "profile",
      "email",
      "offline_access",
      "accounting.settings",
      "accounting.invoices.read",
      "accounting.reports.aged.read",
      "accounting.reports.balancesheet.read",
      "accounting.reports.profitandloss.read",
    ]);
    expect(
      APP_DEFINITIONS.find((app) => app.slug === "pagerduty")?.methods.map(
        (candidate) => ({
          key: candidate.key,
          serverUrl: candidate.defaults?.serverUrl,
        }),
      ),
    ).toEqual([
      { key: "mcp-api-key-us", serverUrl: "https://mcp.pagerduty.com/mcp" },
      { key: "mcp-api-key-eu", serverUrl: "https://mcp.eu.pagerduty.com/mcp" },
    ]);
    expect(method("context7")).toMatchObject({
      auth: "none",
      defaults: { serverUrl: "https://mcp.context7.com/mcp" },
    });
    expect(
      APP_DEFINITIONS.find((app) => app.slug === "planetscale")?.methods.map(
        (candidate) => candidate.key,
      ),
    ).toEqual(["mcp-oauth", "mcp-insights-only"]);
    const postman = APP_DEFINITIONS.find((app) => app.slug === "postman");
    expect(postman?.methods.map((candidate) => candidate.key)).toEqual([
      "mcp-oauth-minimal",
      "mcp-oauth-code",
      "mcp-oauth-full",
      "mcp-eu-key-minimal",
      "mcp-eu-key-code",
      "mcp-eu-key-full",
    ]);
    expect(getAvailableConnectionMethod(postman!)?.key).toBe("mcp-oauth-full");
    expect(
      postman?.methods
        .filter((candidate) => candidate.auth === "api_key")
        .every(
          (candidate) =>
            candidate.keyPlacement?.name === "Authorization" &&
            candidate.keyPlacement.prefix === "Bearer ",
        ),
    ).toBe(true);
    expect(
      method("supabase")?.tenantFields?.find(
        (field) => field.key === "readOnly",
      )?.defaultValue,
    ).toBe(false);
    expect(method("asana")?.ownershipModes).toEqual(["customer"]);
    expect(method("zapier")).toMatchObject({
      key: "generated-url",
      auth: "none",
      defaults: {},
    });
    expect(method("zapier")?.credentialFields).toBeUndefined();
    expect(
      APP_DEFINITIONS.find((app) => app.slug === "youcom")?.methods.map(
        (candidate) => candidate.key,
      ),
    ).toEqual(["mcp-oauth", "mcp-api-key", "mcp-free"]);
    expect(method("youcom")?.defaults?.serverUrl).toBe("https://api.you.com/mcp");
    expect(method("youcom", "mcp-api-key")).toMatchObject({
      auth: "api_key",
      keyPlacement: {
        location: "header",
        name: "Authorization",
        prefix: "Bearer ",
      },
    });
    expect(method("youcom", "mcp-free")).toMatchObject({
      auth: "none",
      defaults: { serverUrl: "https://api.you.com/mcp?profile=free" },
    });
    expect(method("youcom", "mcp-free")?.credentialFields).toBeUndefined();
  });
  it("uses discovery-first Notion MCP OAuth metadata", () => {
    const notion = APP_DEFINITIONS.find((app) => app.slug === "notion");
    expect(notion?.redirectConstraints).toBe("https-or-loopback-http");
    expect(notion?.methods[0]?.defaults).toEqual({
      serverUrl: "https://mcp.notion.com/mcp",
    });
  });
  it("preserves required Linear OAuth scopes", () =>
    expect(
      APP_DEFINITIONS.find((app) => app.slug === "linear")?.methods[0]?.defaults
        ?.scopesHint,
    ).toEqual(["read", "write"]));
  it("requests only Hugging Face's MCP read scope", () =>
    expect(
      APP_DEFINITIONS.find((app) => app.slug === "hugging-face")?.methods[0]
        ?.defaults?.scopesHint,
    ).toEqual(["read-mcp"]));
  it("defaults every new connection action to allowed", () => {
    for (const app of APP_DEFINITIONS)
      for (const method of app.methods)
        expect(recommendedDefaultsForApp(app, method.key)).toEqual({
          access: "all_agents",
          askFirstRiskLevels: [],
        });
  });
  it("defaults explicit read/write capability groups to their write-capable method", () => {
    const drive = APP_DEFINITIONS.find((app) => app.slug === "google-drive")!;
    const gmail = APP_DEFINITIONS.find((app) => app.slug === "gmail")!;
    expect(getAvailableConnectionMethod(drive)?.key).toBe(
      "customer-write-oauth",
    );
    expect(getAvailableConnectionMethod(gmail)?.key).toBe(
      "customer-draft-oauth",
    );
    expect(
      getRecommendedConnectionMethod(
        drive.methods.filter((candidate) =>
          candidate.ownershipModes.includes("customer"),
        ),
      )?.key,
    ).toBe("customer-write-oauth");
    expect(
      getRecommendedConnectionMethod(
        gmail.methods.filter((candidate) =>
          [
            "paperclip-read",
            "customer-read-oauth",
            "customer-draft-oauth",
          ].includes(candidate.key),
        ),
      )?.key,
    ).toBe("paperclip-read");
    expect(
      getRecommendedConnectionMethod(
        gmail.methods.filter(
          (candidate) => candidate.capabilityProfile?.key === "draft",
        ),
      )?.key,
    ).toBe("paperclip-draft");
    expect(
      getRecommendedConnectionMethod(
        gmail.methods.filter(
          (candidate) =>
            candidate.capabilityProfile?.key === "draft" &&
            candidate.ownershipModes.includes("customer"),
        ),
      )?.key,
    ).toBe("customer-draft-oauth");
  });
  it("explains Google Workspace Developer Preview enrollment before connection", () => {
    const googleWorkspaceMcpSlugs = [
      "gmail",
      "google-drive",
      "google-docs",
      "google-sheets",
      "google-slides",
      "google-calendar",
      "google-chat",
      "google-people",
      "google-workspace-search",
    ];
    for (const slug of googleWorkspaceMcpSlugs) {
      const prerequisite = APP_DEFINITIONS.find(
        (app) => app.slug === slug,
      )?.setupPrerequisite;
      expect(prerequisite?.actionUrl, slug).toBe(
        "https://developers.google.com/workspace/preview",
      );
      expect(prerequisite?.description, slug).toContain(
        "does not enable unrelated Paperclip customers",
      );
      expect(prerequisite?.steps?.join(" "), slug).toContain(
        "final project-registration email",
      );
    }
  });
  it("withholds unverified and reserved providers from the app store without deleting their definitions", () => {
    expect([...APP_STORE_HIDDEN_SLUGS].sort()).toEqual([
      "beehiiv",
      "bitly",
      "brex",
      "candid",
      "coda",
      "context7",
      "egnyte",
      "embat",
      "kernel",
      "local-falcon",
      "make",
      "manufact",
      "oreilly",
      "planetscale",
      "razorpay",
      "sanity",
      "similarweb",
      "ticket-tailor",
      "ticktick",
      "xero",
    ]);
    expect(APP_STORE_DEFINITIONS).toHaveLength(60);
    const connectableSlugs = new Set(
      CONNECTABLE_APP_DEFINITIONS.map((entry) => entry.slug),
    );
    const storeSlugs = new Set(
      APP_STORE_DEFINITIONS.map((entry) => entry.slug),
    );
    for (const slug of APP_STORE_HIDDEN_SLUGS) {
      expect(connectableSlugs.has(slug), slug).toBe(true);
      expect(storeSlugs.has(slug), slug).toBe(false);
    }
  });
  it("ships matching local artwork for every store-visible provider", () => {
    const uiPublic = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../ui/public",
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(uiPublic, "brands/apps/manifest.json"), "utf8"),
    ) as {
      providers: Array<{
        slug: string;
        catalogVisible: boolean;
        localAsset: string;
        darkAsset?: string;
      }>;
    };
    const visible = manifest.providers.filter((entry) => entry.catalogVisible);
    expect(visible).toHaveLength(APP_STORE_DEFINITIONS.length);
    expect(new Set(visible.map((entry) => entry.slug))).toHaveProperty(
      "size",
      visible.length,
    );
    expect(new Set(APP_STORE_DEFINITIONS.map((entry) => entry.slug))).toEqual(
      new Set(visible.map((entry) => entry.slug)),
    );
    for (const app of APP_STORE_DEFINITIONS) {
      const provenance = visible.find((entry) => entry.slug === app.slug)!;
      expect(provenance).toBeTruthy();
      expect(provenance.localAsset).toBe(app.branding.logoUrl);
      expect(provenance.darkAsset).toBe(app.branding.darkLogoUrl);
      expect(provenance.localAsset).toMatch(/^\/brands\/apps\/.+\.(svg|png)$/);
      expect(provenance.localAsset).not.toContain("google.com/s2/favicons");
      const asset = fs.readFileSync(path.join(uiPublic, provenance.localAsset));
      if (provenance.localAsset.endsWith(".png")) {
        expect(asset.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
        expect(asset.readUInt32BE(16)).toBeGreaterThanOrEqual(128);
        expect(asset.readUInt32BE(20)).toBeGreaterThanOrEqual(128);
      } else {
        const svg = asset.toString("utf8");
        expect(svg.trimStart()).toMatch(/^(?:<\?xml[^?]*\?>\s*)?<svg\b/);
        expect(svg).not.toMatch(/<script|<foreignObject|\son[a-z]+\s*=/i);
      }
      if (provenance.darkAsset)
        expect(fs.existsSync(path.join(uiPublic, provenance.darkAsset))).toBe(
          true,
        );
    }
  });
  it("keeps every researched self-serve candidate implemented while blocked providers stay absent", () => {
    const definitions = new Map(
      CONNECTABLE_APP_DEFINITIONS.map((entry) => [entry.slug, entry]),
    );
    for (const candidate of SELF_SERVE_MCP_CANDIDATES)
      expect(appSupportsCatalogSetup(definitions.get(candidate.slug))).toBe(
        true,
      );
    for (const blocked of BLOCKED_MCP_PROVIDERS)
      expect(definitions.has(blocked.slug)).toBe(false);
  });
  it("keeps all Google Workspace profiles aligned with their app, endpoint, scopes, ownership, risk, and write policy", () => {
    expect(GOOGLE_WORKSPACE_CONNECTOR_PROFILE_IDS).toEqual(
      GOOGLE_WORKSPACE_PROFILE_EXPECTATIONS.map((entry) => entry.profile),
    );
    expect(Object.keys(GOOGLE_WORKSPACE_CONNECTOR_PROFILES)).toEqual([
      ...GOOGLE_WORKSPACE_CONNECTOR_PROFILE_IDS,
    ]);
    for (const expected of GOOGLE_WORKSPACE_PROFILE_EXPECTATIONS) {
      expect(
        GOOGLE_WORKSPACE_CONNECTOR_PROFILES[expected.profile],
        expected.profile,
      ).toEqual({
        appSlug: expected.appSlug,
        serverUrl: expected.serverUrl,
        scopes: expected.scopes,
        writeTools: expected.writeTools,
      });
      const app = APP_DEFINITIONS.find(
        (candidate) => candidate.slug === expected.appSlug,
      );
      const managed = app?.methods.find(
        (method) => method.connectorProfile === expected.profile,
      );
      expect(managed, expected.profile).toMatchObject({
        auth: "oauth",
        oauthStrategy: "paperclip_cloud_connector",
        connectorProfile: expected.profile,
        capabilityProfile: { key: expected.capability },
        grantKinds: ["user", "organization"],
        ownershipModes: ["platform_shared"],
        defaults: {
          serverUrl: expected.serverUrl,
          scopesHint: expected.scopes,
        },
        riskTier: expected.riskTier,
      });
      expect(managed?.riskTier, `${expected.profile}:write-risk`).toBe(
        expected.writeTools.length > 0 ? "S4" : "S3",
      );
      const customer = app?.methods.find(
        (method) =>
          method.auth === "oauth" &&
          method.oauthStrategy === undefined &&
          method.capabilityProfile?.key === expected.capability,
      );
      expect(customer, `${expected.profile}:customer-fallback`).toMatchObject({
        grantKinds: ["user", "organization"],
        ownershipModes: ["customer"],
        defaults: {
          serverUrl: expected.serverUrl,
          scopesHint: expected.scopes,
        },
        riskTier: expected.riskTier,
      });
    }
  });
  it("configures Shopify's current UCP and compatibility MCP methods without OAuth", () => {
    const shopify = APP_DEFINITIONS.find((app) => app.slug === "shopify");
    expect(shopify?.methods.map((method) => method.key)).toEqual([
      "ucp-commerce",
      "storefront-mcp",
    ]);
    const ucp = shopify?.methods[0];
    const compatibility = shopify?.methods[1];
    expect(ucp).toMatchObject({
      auth: "none",
      defaults: {
        serverUrlTemplate: "https://{storeDomain}/api/ucp/mcp",
        toolArgumentDefaults: {
          meta: {
            "ucp-agent": {
              profile:
                "https://shopify.dev/ucp/agent-profiles/examples/2026-04-08/valid-with-capabilities.json",
            },
          },
        },
      },
      tenantFields: [
        expect.objectContaining({ key: "storeDomain", required: true }),
      ],
    });
    expect(compatibility).toMatchObject({
      auth: "none",
      defaults: { serverUrlTemplate: "https://{storeDomain}/api/mcp" },
    });
    expect(
      resolveConnectionMethodServerUrl(ucp!, {
        storeDomain: "paperclip-demo.myshopify.com",
      }),
    ).toBe("https://paperclip-demo.myshopify.com/api/ucp/mcp");
    expect(
      resolveConnectionMethodServerUrl(compatibility!, {
        storeDomain: "paperclip-demo.myshopify.com",
      }),
    ).toBe("https://paperclip-demo.myshopify.com/api/mcp");
    expect(resolveConnectionMethodServerUrl(ucp!, {})).toBeNull();
    expect(shopify?.setupPrerequisite).toMatchObject({
      title: "Launch the storefront before connecting",
      actionUrl: "https://admin.shopify.com/",
    });
    expect(shopify?.setupPrerequisite?.steps?.join(" ")).toContain(
      "Storefront visibility to Public",
    );
  });
  it("offers PostHog OAuth and API-key methods with zero-config defaults and advanced narrowing", () => {
    const posthog = APP_DEFINITIONS.find((app) => app.slug === "posthog");
    expect(posthog?.methods.map((method) => method.key)).toEqual([
      "mcp-oauth",
      "mcp-api-key",
    ]);
    for (const method of posthog?.methods ?? []) {
      const projectField = method.tenantFields?.find(
        (field) => field.key === "projectId",
      );
      expect(method.riskTier).toBe("S3");
      expect(
        method.tenantFields?.find((field) => field.key === "readOnly"),
      ).toMatchObject({ defaultValue: false, advanced: true });
      expect(projectField).toMatchObject({
        advanced: true,
        transport: { location: "header", name: "x-posthog-project-id" },
      });
      expect(projectField?.required).not.toBe(true);
      expect(
        method.tenantFields
          ?.filter((field) => field.advanced)
          .map((field) => field.key),
      ).toEqual(["projectId", "readOnly", "features", "tools"]);
      expect(
        method.tenantFields?.find((field) => field.key === "mode"),
      ).toMatchObject({
        hidden: true,
        defaultValue: "tools",
        transport: { location: "query", name: "mode" },
      });
      expect(method.configRequirements).toBeUndefined();
      expect(method.requiredResourceFilters).toBeUndefined();
      expect(method.guidanceMd).toContain("optional advanced controls");
    }
  });
  it("requires only reviewed provider or safety-boundary configuration on the default path", () => {
    const required = APP_DEFINITIONS.flatMap((app) =>
      app.methods.flatMap((method) =>
        [...(method.tenantFields ?? []), ...(method.extensionFields ?? [])]
          .filter(
            (field) =>
              field.required && field.advanced !== true && !field.hidden,
          )
          .map((field) => `${app.slug}:${method.key}:${field.key}`),
      ),
    ).sort();
    expect(required).toEqual([
      "clickhouse:mcp-oauth:serviceId",
      "shopify:storefront-mcp:storeDomain",
      "shopify:ucp-commerce:storeDomain",
      "supabase:mcp-api-key:projectRef",
      "supabase:mcp-oauth:projectRef",
    ]);
  });
  it("limits Vercel Connect setup to the reviewed pilot methods", () => {
    const reviewed = APP_DEFINITIONS.flatMap((app) =>
      app.methods.flatMap((method) =>
        method.credentialSources?.vercelConnect
          ? [
              {
                slug: app.slug,
                key: method.key,
                review: method.credentialSources.vercelConnect,
              },
            ]
          : [],
      ),
    );
    expect(reviewed.map(({ slug, key }) => `${slug}:${key}`).sort()).toEqual([
      "linear:mcp-oauth",
      "notion:mcp-oauth",
      "posthog:mcp-api-key",
      "posthog:mcp-oauth",
    ]);
    expect(
      reviewed.find(({ slug }) => slug === "linear")?.review,
    ).toMatchObject({
      services: ["linear"],
      principalModes: ["user"],
      scopes: ["read", "write"],
      header: { name: "Authorization", prefix: "Bearer " },
    });
    expect(
      reviewed.find(
        ({ slug, key }) => slug === "posthog" && key === "mcp-oauth",
      )?.review.services,
    ).toEqual(["posthog", "mcp.posthog.com/mcp"]);
    expect(
      reviewed.find(
        ({ slug, key }) => slug === "posthog" && key === "mcp-api-key",
      )?.review.principalModes,
    ).toEqual(["app"]);
    expect(
      APP_DEFINITIONS.find((app) => app.slug === "vercel")?.availability
        ?.available,
    ).toBe(false);
  });
  it("enforces method and field invariants", () => {
    for (const app of APP_DEFINITIONS)
      for (const method of app.methods) {
        if (
          method.auth === "api_key" &&
          (method.purpose ?? "tool") !== "channel"
        )
          expect(method.keyPlacement).toBeTruthy();
        if (method.auth === "oauth")
          expect(method.ownershipModes.length).toBeGreaterThan(0);
        for (const field of method.credentialFields ?? [])
          if (field.required && field.type !== "checkbox")
            expect(field.placeholder).toBeTruthy();
      }
  });
});


describe("Railway provider", () => {
  it("matches only the hosted endpoint and exposes one vault-backed OAuth method", () => {
    const app = APP_STORE_DEFINITIONS.find((entry) => entry.slug === "railway")!;
    expect(getAppDefinitionForUrl("https://mcp.railway.com")?.slug).toBe("railway");
    for (const url of ["https://mcp.railway.com/path", "https://mcp.railway.com.evil.test", "http://mcp.railway.com"]) expect(getAppDefinitionForUrl(url)?.slug).not.toBe("railway");
    expect(app.methods).toHaveLength(1);
    expect(app.methods[0]).toMatchObject({ key: "mcp-oauth", auth: "oauth", transport: "mcp_remote", ownershipModes: ["dcr", "customer"], riskTier: "S4", defaults: { serverUrl: "https://mcp.railway.com", scopesHint: ["openid", "offline_access", "workspace:member"], oauthAuthorizationParams: { prompt: "consent" } } });
    expect(JSON.stringify(app.methods)).toContain("Live Railway qualification is pending");
  });
});
