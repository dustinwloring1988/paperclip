import fs from "node:fs";
import path from "node:path";
const root = process.cwd();
// Provider definitions can be regenerated without the external research corpus.
// This mode preserves the checked-in ingestion report.
const definitionsOnly = process.argv.includes("--definitions-only");
const corpus =
  process.env.PAPERCLIP_CONTENT_TEMPLATES ??
  path.resolve(
    root,
    "../../paperclip-content/research/connections/vercel/templates",
  );
const out = path.join(root, "packages/shared/src/app-definitions");
const brandingManifest = JSON.parse(
  fs.readFileSync(
    path.join(root, "ui/public/brands/apps/manifest.json"),
    "utf8",
  ),
);
const brandingBySlug = new Map(
  brandingManifest.providers.map((entry) => [entry.slug, entry]),
);
const brandingFor = (slug) => {
  const entry = brandingBySlug.get(slug);
  if (entry)
    return {
      logoUrl: entry.localAsset,
      ...(entry.darkAsset ? { darkLogoUrl: entry.darkAsset } : {}),
    };
  if (slug === "oauth-generic" || slug === "api-key-generic")
    return { logoUrl: `/brands/apps/${slug}.svg` };
  throw new Error(`${slug}: missing local branding provenance`);
};
const field = (key, label, placeholder) => ({
  key,
  label,
  type: "password",
  required: true,
  placeholder,
  secret: true,
});
const method = (
  key,
  transport,
  auth,
  defaults,
  riskTier,
  guidanceMd,
  extra = {},
) => ({
  key,
  transport,
  auth,
  ownershipModes: auth === "oauth" ? ["customer", "dcr"] : ["customer"],
  whenToUse:
    transport === "mcp_remote"
      ? "Use the provider-hosted connection for the quickest setup."
      : "Use credentials from your provider account.",
  defaults,
  guidanceMd,
  riskTier,
  ...extra,
});
const chatProviderName = (provider) =>
  ({
    discord: "Discord",
    github: "GitHub",
    "microsoft-teams": "Microsoft Teams",
    slack: "Slack",
    telegram: "Telegram",
    "imessage-photon": "iMessage Photon",
  })[provider];
const channelMethod = (
  provider,
  credentialFields,
  requiredResourceFilters,
  guidanceMd,
  consoleLinks,
) => ({
  key: "chat-agent",
  label: "Chat with an agent",
  purpose: "channel",
  provider,
  transport: "chat_sdk",
  auth: "api_key",
  ownershipModes: ["customer"],
  whenToUse: `Let people in ${chatProviderName(provider)} start and continue work with one Paperclip agent.`,
  credentialFields,
  guidanceMd,
  consoleLinks,
  riskTier: "S3",
  requiredResourceFilters,
});
const vercelConnect = (
  serviceOrServices,
  principalMode,
  scopes,
  header = { name: "Authorization", prefix: "Bearer " },
) => ({
  credentialSources: {
    vercelConnect: {
      services: Array.isArray(serviceOrServices)
        ? serviceOrServices
        : [serviceOrServices],
      principalModes: [principalMode],
      scopes,
      header,
    },
  },
});
const posthogConfigFields = () => [
  {
    key: "projectId",
    label: "Pin to project ID",
    type: "text",
    advanced: true,
    placeholder: "Optional numeric project ID",
    helperMd:
      "Optional. Pin this connection to one project and remove PostHog's project-switching tool.",
    validation: { pattern: "^[0-9]+$", maxLength: 32 },
    transport: { location: "header", name: "x-posthog-project-id" },
  },
  {
    key: "readOnly",
    label: "Read-only mode",
    type: "checkbox",
    advanced: true,
    defaultValue: false,
    helperMd: "Turn on to hide tools that can change PostHog data.",
    transport: {
      location: "query",
      name: "readonly",
      format: "boolean",
      omitFalse: true,
    },
  },
  {
    key: "features",
    label: "Feature groups",
    type: "textarea",
    advanced: true,
    placeholder: "Optional comma-separated feature groups",
    helperMd:
      "Leave blank to expose every feature group, or enter a comma-separated list to narrow access.",
    validation: { maxLength: 500 },
    transport: { location: "query", name: "features", format: "csv" },
  },
  {
    key: "tools",
    label: "Individual tools",
    type: "textarea",
    advanced: true,
    placeholder: "Optional comma-separated tool names",
    helperMd:
      "Leave blank to expose all tools. Exact names here are combined with any feature groups.",
    validation: { maxLength: 2000 },
    transport: { location: "query", name: "tools", format: "csv" },
  },
  {
    key: "mode",
    label: "Tool response mode",
    type: "select",
    hidden: true,
    required: true,
    placeholder: "Individual tools",
    defaultValue: "tools",
    options: [{ value: "tools", label: "Individual tools" }],
    helperMd:
      "Paperclip uses individual tools so every action can be governed. CLI mode remains unavailable until nested execution is governed.",
    transport: { location: "query", name: "mode" },
  },
];
const posthogMethod = (key, auth, extra = {}) =>
  method(
    key,
    "mcp_remote",
    auth,
    { serverUrl: "https://mcp.posthog.com/mcp" },
    "S3",
    "Connect with PostHog's recommended defaults. Project pinning, read-only access, and catalog filters are optional advanced controls.",
    { tenantFields: posthogConfigFields(), ...extra },
  );
const apps = [
  ["agentmail", "AgentMail", "Give agents email inboxes and handle each conversation as a task.", "communication", "agentmail.to", ["https://console.agentmail.to/*"], {
    key: "email-agent", label: "Email with an agent", purpose: "channel", provider: "agentmail", transport: "rest_api", auth: "api_key", ownershipModes: ["customer"],
    whenToUse: "Assign an inbox to an agent and manage email conversations in tasks.", credentialFields: [{ key: "apiKey", label: "AgentMail API key", type: "password", placeholder: "am_…", required: true, secret: true }],
    guidanceMd: "Connect an AgentMail API key, then create or select an inbox for your agent. WebSocket receiving works without a public URL.",
    consoleLinks: { keys: "https://console.agentmail.to", docs: "https://docs.agentmail.to/inboxes" }, riskTier: "S3", requiredResourceFilters: ["inbox"]
  }],
  [
    "zapier",
    "Zapier",
    "Reach thousands of apps through your Zapier account.",
    "productivity",
    "zapier.com",
    ["https://mcp.zapier.com/*"],
    method(
      "generated-url",
      "mcp_remote",
      "none",
      {},
      "S3",
      "Create a Zapier MCP server, then paste the complete generated connection URL. The token remains embedded in that URL.",
      {
        label: "Paste generated MCP URL",
        whenToUse: "Use the complete provider-generated MCP URL from Zapier.",
      },
    ),
  ],
  ...[
    ["arcade", "Arcade", "https://api.arcade.dev/*", "https://docs.arcade.dev/en/operate/governance/mcp-gateways"],
    ["executor", "Executor", "https://executor.sh/*", "https://executor.sh/docs/mcp-proxy"],
  ].map(([slug, name, pattern, docsUrl]) => [
    slug, name, `Use the tools exposed by your ${name} MCP connection.`, "productivity", new URL(pattern).hostname, [pattern],
    method("mcp", "mcp_remote", "none", {}, "S3", `Paste your ${name} MCP URL. Sign in if required, or add a token or headers under Advanced authentication.`, {
      label: "Connect MCP server", ownershipModes: ["dcr", "customer"], consoleLinks: { docs: docsUrl },
    }),
    { featured: true, docsUrl },
  ]),
  [
    "railway",
    "Railway",
    "Inspect services and logs, deploy applications, and run commands in your Railway containers.",
    "developer",
    "railway.com",
    ["https://mcp.railway.com/"],
    method(
      "mcp-oauth",
      "mcp_remote",
      "oauth",
      {
        serverUrl: "https://mcp.railway.com",
        scopesHint: ["openid", "offline_access", "workspace:member"],
        oauthAuthorizationParams: { prompt: "consent" },
      },
      "S4",
      "Sign in to Railway and select the workspaces your agents may use. Paperclip adds direct service, deployment, and bounded log tools when Railway accepts the connection for API access. Container commands require the separate SSH setup on the connection. Project tokens are not supported by Railway's hosted connection.",
      {
        label: "Connect Railway",
        ownershipModes: ["dcr", "customer"],
        whenToUse: "Authorize your Railway account in the browser.",
        consoleLinks: {
          docs: "https://docs.railway.com/ai/mcp-server",
          register: "https://docs.railway.com/integrations/oauth/creating-an-app",
          settings: "https://railway.com/account",
        },
        warnings: [
          "Railway enforces the workspaces selected at consent. Selected actions start Allowed; choose Ask first for operations you want to approve.",
          "Logs and container commands can expose application data and secrets. Grant access only to agents trusted with the selected services.",
          "The general Railway agent and committing staged changes are unavailable because their internal changes cannot be individually reviewed in Paperclip.",
          "Live Railway qualification is pending. If Railway rejects API access, reconnect with the required permissions; Paperclip never falls back to another credential.",
        ],
        requiredResourceFilters: ["workspace", "project", "environment", "service"],
      },
    ),
    { redirectConstraints: "https-or-loopback-http" },
  ],
  [
    "github",
    "GitHub",
    "Give agents repository tools or let people work with an agent from GitHub issues and pull requests.",
    "developer",
    "github.com",
    ["https://api.githubcopilot.com/mcp/*", "https://github.com/*"],
    [
      method(
        "managed",
        "mcp_remote",
        "oauth",
        { serverUrl: "https://api.githubcopilot.com/mcp/" },
        "S3",
        "Authorize Paperclip, then choose selected repositories in GitHub. You can edit repository access later from GitHub's installation settings.",
        {
          label: "Use this connection as an agent tool",
          purpose: "tool",
          oauthStrategy: "paperclip_cloud_connector",
          connectorProfile: "github.code",
          grantKinds: ["user", "agent"],
          ownershipModes: ["platform_shared"],
          whenToUse:
            "Connect your GitHub account for durable MCP, shell Git, gh, and repository access.",
          warnings: [
            "Shell Git and gh receive this identity for the run and are not constrained by per-tool Ask-first controls.",
          ],
          requiredResourceFilters: ["organization", "repository"],
        },
      ),
      method(
        "mcp-key",
        "mcp_remote",
        "api_key",
        { serverUrl: "https://api.githubcopilot.com/mcp/" },
        "S3",
        "Create a fine-grained token limited to the repositories agents should use.",
        {
          label: "Personal access token (advanced)",
          purpose: "tool",
          credentialFields: [
            field("authorization", "GitHub token", "github_pat_..."),
          ],
          keyPlacement: {
            location: "header",
            name: "Authorization",
            prefix: "Bearer ",
          },
          requiredResourceFilters: ["organization", "repository"],
        },
      ),
      channelMethod(
        "github",
        [
          {
            ...field("appId", "GitHub App ID", "123456"),
            type: "text",
            secret: false,
          },
          {
            ...field(
              "privateKey",
              "Private key (PEM)",
              "-----BEGIN RSA PRIVATE KEY-----",
            ),
            type: "textarea",
          },
        ],
        ["organization", "repository"],
        "Generate the webhook secret in Paperclip, then create one private GitHub App with active SSL-verified webhooks, Issues and Pull requests read/write permission, and the selectable issue_comment and pull_request_review_comment events. GitHub sends installation and installation_repositories automatically. Install the App only on repositories where people may mention the agent.",
        {
          register: "https://github.com/settings/apps/new",
          docs: "https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app",
        },
      ),
    ],
  ],
  [
    "slack",
    "Slack",
    "Give agents Slack tools or let people start and continue Paperclip work from Slack.",
    "communication",
    "slack.com",
    ["https://mcp.slack.com/*", "https://app.slack.com/client/*"],
    [
      method(
        "mcp-oauth",
        "mcp_remote",
        "oauth",
        {
          serverUrl: "https://mcp.slack.com/mcp",
          authorizationEndpoint: "https://slack.com/oauth/v2/authorize",
          tokenEndpoint: "https://slack.com/api/oauth.v2.access",
          scopesHint: ["channels:read", "chat:write", "search:read"],
        },
        "S3",
        "Connect a Slack workspace and limit access to the channels agents need.",
        {
          label: "Use this connection as an agent tool",
          purpose: "tool",
          ownershipModes: ["customer"],
          requiredResourceFilters: ["workspace", "channel"],
        },
      ),
      channelMethod(
        "slack",
        [
          field("botToken", "Bot User OAuth Token", "xoxb-..."),
          field(
            "signingSecret",
            "Signing Secret",
            "Paste the Slack App signing secret",
          ),
        ],
        ["workspace", "channel"],
        "Create and install one Slack App for this agent. Paperclip receives verified Events API requests and interactive callbacks, acknowledges with reactions, responds in direct messages, and starts one Paperclip task per new mentioned channel thread.",
        {
          register: "https://api.slack.com/apps",
          docs: "https://api.slack.com/start/quickstart",
        },
      ),
    ],
  ],
  [
    "microsoft-teams",
    "Microsoft Teams",
    "Let people start and continue Paperclip work with an agent from Microsoft Teams.",
    "communication",
    "teams.microsoft.com",
    ["https://teams.microsoft.com/*"],
    channelMethod(
      "microsoft-teams",
      [
        {
          ...field(
            "clientId",
            "Application / Client ID",
            "00000000-0000-0000-0000-000000000000",
          ),
          type: "text",
          secret: false,
        },
        {
          ...field(
            "tenantId",
            "Directory / Tenant ID",
            "00000000-0000-0000-0000-000000000000",
          ),
          type: "text",
          secret: false,
        },
        field("clientSecret", "Client secret", "Paste the client-secret value"),
      ],
      ["team", "channel", "chat"],
      "Use a Microsoft 365 work or school organization where you can register an Entra app, create a single-tenant Azure Bot, and upload or install a Teams app. Personal or free Teams accounts at teams.live.com cannot complete this setup. Enable personal, team, and groupChat bot scopes and the ChannelMessage.Read.Group and ChatMessage.Read.Chat resource-specific application permissions. Those RSC grants let an installed app receive every message in a team or group chat without an @mention, so explain that access to installers. One team install covers its standard channels; private and shared channels require a separate installation and are not supported by this release.",
      {
        register: "https://dev.teams.microsoft.com/apps",
        docs: "https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/create-a-bot-for-teams",
      },
    ),
  ],
  [
    "imessage-photon", "iMessage Photon",
    "Message a Paperclip agent from Apple Messages using Photon Cloud. Pro supports DMs; dedicated lines also support groups.",
    "communication", "photon.codes", ["https://photon.codes/*"],
    channelMethod("imessage-photon", [field("projectSecret", "Project secret", "Photon project secret")], ["direct_message", "group_chat"],
      "Connect a Photon Cloud project. Pro shared lines support DMs after sender enrollment in Photon and identity linking in Paperclip. Dedicated lines also support individually enabled groups.",
      { register: "https://photon.codes/", docs: "https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing" }),
  ],
  [
    "telegram",
    "Telegram",
    "Let people start and continue Paperclip work with an agent from Telegram.",
    "communication",
    "telegram.org",
    ["https://t.me/*", "https://telegram.me/*", "https://api.telegram.org/*"],
    channelMethod(
      "telegram",
      [field("botToken", "Bot token", "123456789:AA...")],
      ["chat", "group", "topic"],
      "Create one dedicated bot with BotFather, then connect its token to the public Paperclip webhook endpoint.",
      {
        register: "https://t.me/BotFather",
        docs: "https://core.telegram.org/bots/tutorial",
      },
    ),
  ],
  [
    "discord",
    "Discord",
    "Let people start and continue Paperclip work with an agent from Discord.",
    "communication",
    "discord.com",
    ["https://discord.com/*"],
    channelMethod(
      "discord",
      [
        field("botToken", "Bot token", "Paste the Discord bot token"),
        {
          ...field("applicationId", "Application ID", "123456789012345678"),
          type: "text",
          secret: false,
        },
        {
          ...field("guildId", "Server ID", "123456789012345678"),
          type: "text",
          secret: false,
        },
      ],
      ["channel"],
      "Create one dedicated Discord application and bot, enable the Message Content intent, install it in one server with the documented bot permissions, then connect its bot token, Application ID, and server ID. Paperclip starts one Discord thread per root bot mention and keeps the linked Paperclip task authoritative.",
      {
        register: "https://discord.com/developers/applications",
        docs: "https://discord.com/developers/docs/quick-start/getting-started",
      },
    ),
  ],
  [
    "notion",
    "Notion",
    "Read and update pages in your Notion workspace.",
    "content",
    "notion.so",
    ["https://mcp.notion.com/*"],
    method(
      "mcp-oauth",
      "mcp_remote",
      "oauth",
      { serverUrl: "https://mcp.notion.com/mcp" },
      "S3",
      "Connect Notion for workspace content. Share only the pages and databases agents should use.",
      {
        requiredResourceFilters: ["workspace", "page", "database"],
        ...vercelConnect("notion", "user", ["*"]),
      },
    ),
    { redirectConstraints: "https-or-loopback-http" },
  ],
  [
    "posthog",
    "PostHog",
    "Analyze product usage, errors, feature flags, and experiments with PostHog's hosted MCP server.",
    "analytics",
    "posthog.com",
    ["https://mcp.posthog.com/*"],
    [
      posthogMethod("mcp-oauth", "oauth", {
        label: "Sign in with PostHog",
        ownershipModes: ["customer", "dcr"],
        whenToUse:
          "Sign in with PostHog in the browser. Recommended for hosted PostHog accounts.",
        consoleLinks: {
          docs: "https://posthog.com/docs/model-context-protocol",
        },
        ...vercelConnect(["posthog", "mcp.posthog.com/mcp"], "user", ["*"]),
      }),
      posthogMethod("mcp-api-key", "api_key", {
        label: "Use a personal API key",
        whenToUse:
          "Use a PostHog personal API key when browser sign-in is not suitable.",
        credentialFields: [
          field("authorization", "PostHog personal API key", "phx_..."),
        ],
        keyPlacement: {
          location: "header",
          name: "Authorization",
          prefix: "Bearer ",
        },
        consoleLinks: {
          keys: "https://posthog.com/docs/model-context-protocol/faq",
          docs: "https://posthog.com/docs/model-context-protocol/faq",
        },
        ...vercelConnect(["posthog", "mcp.posthog.com/mcp"], "app", ["*"]),
      }),
    ],
    { featured: true },
  ],
  [
    "linear",
    "Linear",
    "Create, update, and read Linear issues.",
    "productivity",
    "linear.app",
    ["https://mcp.linear.app/*"],
    method(
      "mcp-oauth",
      "mcp_remote",
      "oauth",
      {
        serverUrl: "https://mcp.linear.app/mcp",
        authorizationEndpoint: "https://linear.app/oauth/authorize",
        tokenEndpoint: "https://api.linear.app/oauth/token",
        scopesHint: ["read", "write"],
      },
      "S2",
      "Register a Linear OAuth app and add Paperclip's redirect URI before connecting.",
      {
        ownershipModes: ["customer"],
        requiredResourceFilters: ["workspace", "team", "project"],
        ...vercelConnect("linear", "user", ["read", "write"]),
      },
    ),
  ],
  [
    "google-sheets",
    "Google Sheets",
    "Read and update selected spreadsheets.",
    "data",
    "sheets.google.com",
    ["https://docs.google.com/spreadsheets/*", "https://sheets.google.com/*"],
    method(
      "local",
      "local_stdio",
      "none",
      { templateKey: "paperclip.google-sheets" },
      "S3",
      "Share each spreadsheet with the Paperclip robot email, then paste the sheet links.",
      { requiredResourceFilters: ["spreadsheet"] },
    ),
  ],
  [
    "context7",
    "Context7",
    "Look up current documentation for software libraries.",
    "developer",
    "context7.com",
    ["https://mcp.context7.com/*"],
    method(
      "mcp",
      "mcp_remote",
      "none",
      { serverUrl: "https://mcp.context7.com/mcp" },
      "S1",
      "Connect Context7 to give agents current library documentation.",
    ),
  ],
  [
    "shopify",
    "Shopify",
    "Search a store's products and policies, and manage shopping carts.",
    "commerce",
    "shopify.com",
    ["https://*.myshopify.com/api/ucp/mcp", "https://*.myshopify.com/api/mcp"],
    [
      method(
        "ucp-commerce",
        "mcp_remote",
        "none",
        {
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
        "S3",
        "Connect Shopify's current UCP server for shopper-facing catalog and commerce tools. Paperclip supplies the required agent profile automatically.",
        {
          label: "Shopify UCP commerce",
          whenToUse:
            "Recommended for Shopify's current UCP catalog, cart, and checkout tools.",
          tenantFields: [
            {
              key: "storeDomain",
              label: "Store domain",
              type: "text",
              required: true,
              placeholder: "your-store.myshopify.com",
              helperMd:
                "Enter the permanent myshopify.com domain without https://. Custom storefront domains are not the MCP endpoint.",
              validation: {
                pattern: "^[A-Za-z0-9][A-Za-z0-9-]*\\.myshopify\\.com$",
                maxLength: 255,
              },
            },
          ],
          consoleLinks: {
            docs: "https://shopify.dev/docs/agents/catalog/storefront-catalog",
          },
          warnings: [
            "This is Shopify's shopper-facing UCP server, not Admin API access. It does not manage merchant products or customers.",
            "The storefront must be public. A private or password-protected storefront returns HTTP 401 even when the merchant is signed in to Shopify Admin.",
            "Paperclip currently uses Shopify's documented hosted agent-profile fixture while Paperclip's production UCP profile is being established.",
          ],
          requiredResourceFilters: ["store"],
        },
      ),
      method(
        "storefront-mcp",
        "mcp_remote",
        "none",
        { serverUrlTemplate: "https://{storeDomain}/api/mcp" },
        "S3",
        "Connect Shopify's official Storefront MCP server for shopper-facing catalog, policy, and cart tools.",
        {
          label: "Storefront policies and compatibility tools",
          whenToUse:
            "Use Shopify's compatibility server when agents need storefront policy and FAQ search.",
          tenantFields: [
            {
              key: "storeDomain",
              label: "Store domain",
              type: "text",
              required: true,
              placeholder: "your-store.myshopify.com",
              helperMd:
                "Enter the permanent myshopify.com domain without https://. Custom storefront domains are not the MCP endpoint.",
              validation: {
                pattern: "^[A-Za-z0-9][A-Za-z0-9-]*\\.myshopify\\.com$",
                maxLength: 255,
              },
            },
          ],
          consoleLinks: {
            docs: "https://shopify.dev/docs/apps/build/storefront-mcp/servers/storefront",
          },
          warnings: [
            "This is Shopify's Storefront MCP, not Admin API access. It does not manage merchant products, orders, or customers.",
            "The storefront must be public. A private or password-protected storefront returns HTTP 401 even when the merchant is signed in to Shopify Admin.",
          ],
          requiredResourceFilters: ["store"],
        },
      ),
    ],
    {
      docsUrl:
        "https://shopify.dev/docs/apps/build/storefront-mcp/servers/storefront",
      setupPrerequisite: {
        title: "Launch the storefront before connecting",
        description:
          "Shopify's Storefront MCP is a public, no-auth endpoint. Paperclip cannot use the merchant's Shopify Admin session to bypass a private storefront.",
        steps: [
          "Select a Shopify plan; Shopify keeps trial storefronts private until a plan is selected.",
          "In Shopify Admin, open Online Store → Preferences and set Storefront visibility to Public (remove password protection).",
          "Use the permanent <store>.myshopify.com domain in Paperclip, even if the store also has a custom domain.",
        ],
        actionLabel: "Open Shopify Admin",
        actionUrl: "https://admin.shopify.com/",
      },
    },
  ],
  [
    "composio",
    "Composio",
    "Discover and use connected apps through Composio Connect.",
    "productivity",
    "composio.dev",
    ["https://backend.composio.dev/*", "https://connect.composio.dev/*", "https://mcp.composio.dev/*", "https://*.composio.dev/*"],
    [method("mcp", "mcp_remote", "none", { serverUrl: "https://connect.composio.dev/mcp" }, "S3", "Sign in to Composio Connect, or paste an externally configured MCP session URL and headers.", { label: "Composio Connect", ownershipModes: ["dcr", "customer"] })],
    { featured: true, docsUrl: "https://docs.composio.dev/docs/composio-connect" },
  ],
  [
    "oauth-generic",
    "OAuth app",
    "Connect a provider using your own OAuth client.",
    "other",
    "oauth.net",
    [],
    method(
      "oauth",
      "rest_api",
      "oauth",
      {},
      "S3",
      "Register an OAuth client with the provider and add Paperclip's redirect URI.",
      {
        credentialFields: [
          {
            ...field("clientId", "Client ID", "Paste the client ID"),
            type: "text",
            secret: false,
          },
          field("clientSecret", "Client secret", "Paste the client secret"),
        ],
      },
    ),
  ],
  [
    "api-key-generic",
    "API key app",
    "Connect an API using a key from your provider.",
    "other",
    "openapis.org",
    [],
    method(
      "api-key",
      "rest_api",
      "api_key",
      {},
      "S3",
      "Create a restricted API key and paste it here.",
      {
        credentialFields: [field("apiKey", "API key", "Paste the API key")],
        keyPlacement: {
          location: "header",
          name: "Authorization",
          prefix: "Bearer ",
        },
      },
    ),
  ],
  [
    "sentry",
    "Sentry",
    "Investigate errors, releases, and production issues.",
    "developer",
    "sentry.io",
    ["https://mcp.sentry.dev/*"],
    method(
      "mcp-oauth",
      "mcp_remote",
      "oauth",
      {
        serverUrl: "https://mcp.sentry.dev/mcp",
        discoveryUrl:
          "https://sentry.io/.well-known/oauth-authorization-server",
      },
      "S2",
      "Connect the Sentry organization and projects agents need for incident work.",
      { requiredResourceFilters: ["organization", "project", "environment"] },
    ),
  ],
  [
    "vercel",
    "Vercel",
    "Inspect projects, deployments, and runtime logs.",
    "developer",
    "vercel.com",
    ["https://mcp.vercel.com/*"],
    method(
      "mcp-oauth",
      "mcp_remote",
      "oauth",
      { serverUrl: "https://mcp.vercel.com/mcp" },
      "S3",
      "Connect the Vercel team and projects agents should operate.",
      { requiredResourceFilters: ["team", "project", "environment"] },
    ),
  ],
  [
    "anthropic",
    "Anthropic",
    "Use Anthropic APIs with a restricted key.",
    "ai",
    "anthropic.com",
    ["https://api.anthropic.com/*"],
    method(
      "api-key",
      "rest_api",
      "api_key",
      { serviceHost: "api.anthropic.com" },
      "S3",
      "Create a key in the Anthropic Console and rotate it if it has been exposed.",
      {
        credentialFields: [field("apiKey", "API key", "sk-ant-api03-...")],
        keyPlacement: { location: "header", name: "x-api-key" },
      },
    ),
  ],
].map(
  ([
    slug,
    name,
    description,
    category,
    _domain,
    urlPatterns,
    m,
    extra = {},
  ]) => ({
    schemaVersion: 1,
    slug,
    name,
    description,
    categories: [category],
    featured: [
      "zapier",
      "github",
      "slack",
      "notion",
      "posthog",
      "linear",
    ].includes(slug),
    branding: brandingFor(slug),
    urlPatterns,
    methods: Array.isArray(m) ? m : [m],
    ...extra,
  }),
);
apps.push({
  schemaVersion: 1,
  slug: "gmail",
  name: "Gmail",
  description:
    "Search and read Gmail messages and create drafts without enabling mail sending.",
  categories: ["communication", "productivity"],
  featured: true,
  branding: brandingFor("gmail"),
  urlPatterns: ["https://gmailmcp.googleapis.com/*"],
  docsUrl:
    "https://developers.google.com/workspace/guides/configure-mcp-servers",
  redirectConstraints: "https-or-loopback-http",
  methods: [
    {
      key: "paperclip-id-oauth",
      label: "Connect Gmail",
      transport: "mcp_remote",
      auth: "oauth",
      oauthStrategy: "paperclip_id_connector",
      grantKinds: ["user"],
      ownershipModes: ["customer"],
      whenToUse:
        "Use Paperclip ID for a personal Gmail connection with centrally registered Google OAuth.",
      defaults: {
        serverUrl: "https://gmailmcp.googleapis.com/mcp/v1",
        scopesHint: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.compose",
        ],
      },
      guidanceMd:
        "Connect your Gmail identity. Paperclip can search and read mail and create drafts. Sending mail is not enabled.",
      warnings: [
        "This connection is personal. Agents need an explicit install, profile, and delegation before they can use it.",
      ],
      riskTier: "S3",
    },
  ],
});

// The reviewed MCP program is a durable input, not another hand-maintained
// allowlist. Runtime definitions are generated from the same 46-row evidence
// ledger that the tests and implementation checklist validate.
const researchManifest = JSON.parse(
  fs.readFileSync(
    path.join(root, "packages/shared/src/self-serve-mcp-research.json"),
    "utf8",
  ),
);
const categoryBySlug = {
  airtable: "data",
  apify: "developer",
  asana: "productivity",
  beehiiv: "content",
  bitly: "analytics",
  box: "content",
  brex: "commerce",
  candid: "data",
  clickhouse: "data",
  cloudflare: "developer",
  cloudinary: "content",
  coda: "productivity",
  egnyte: "content",
  embat: "commerce",
  exa: "ai",
  figma: "content",
  fireflies: "productivity",
  "hugging-face": "ai",
  intercom: "communication",
  jira: "productivity",
  kernel: "developer",
  "local-falcon": "analytics",
  make: "productivity",
  manufact: "productivity",
  mem0: "ai",
  zep: "ai",
  supermemory: "ai",
  honcho: "ai",
  miro: "productivity",
  mixpanel: "analytics",
  netlify: "developer",
  notion: "content",
  oreilly: "content",
  pagerduty: "developer",
  planetscale: "data",
  posthog: "analytics",
  postman: "developer",
  razorpay: "commerce",
  resend: "communication",
  sanity: "content",
  sentry: "developer",
  similarweb: "analytics",
  stripe: "commerce",
  supabase: "data",
  "ticket-tailor": "commerce",
  ticktick: "productivity",
  todoist: "productivity",
  webflow: "content",
  wix: "content",
  xero: "commerce",
  youcom: "ai",
  zapier: "productivity",
};
// App-level review data the per-slug maps above cannot express: a prerequisite an
// operator must clear before consent, more than one recognized host, and the
// store description. Kept as data so the ledger stays the single reviewed input.
const descriptionBySlug = {
  apify: "Run web scraping and data extraction Actors and read their results.",
  exa: "Search the web and fetch page content for agents.",
  figma: "Read Figma files, comments, and design data.",
  fireflies:
    "Search meeting transcripts, read summaries and action items, and connect meeting-ready routines.",
  honcho: "Remember conversations and retrieve context about peers.",
  intercom:
    "Search Intercom conversations, users, and Help Center articles.",
  mem0: "Remember preferences, conversations, events, and agent state.",
  supermemory:
    "Search and save shared memories, documents, and profiles.",
  zep: "Retrieve temporal graph memory and authorized business context.",
};
const appExtrasBySlug = {
  figma: {
    setupPrerequisite: {
      title: "A seat that can actually use MCP",
      // Source: Figma's developer page "Rate limits & access"
      // (https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/),
      // read 2026-09-30. Two of Figma's own published sources disagree on the
      // View/Collab figure, so the copy follows the developer page and says so
      // instead of picking a number silently:
      //   developer page table — Starter up to 20/month, Professional /
      //     Organization / Enterprise up to 6/month
      //   the same page's "What if I'm rate-limited?" list repeats 20 for
      //     Starter, but attributes 200/day to Organization and 600/day to
      //     Enterprise while the table prints 600/day under Organization and
      //     leaves Enterprise blank
      //   Figma's mcp-server-guide README says Starter, or View/Collab seats on
      //     paid plans, get "up to 6 tool calls per month"
      description:
        "Figma caps MCP by seat and plan, not by plan alone, and the numbers come from Figma's own rate-limits page (developers.figma.com/docs/figma-mcp-server/rate-limits-access/): a View or Collab seat gets up to 20 tool calls a month on Starter and up to 6 a month on Professional, Organization, and Enterprise, while a Dev or Full seat gets 200/day and 10/min on Starter, 200/day and 15/min on Professional, and 600/day and 20/min on Organization (the page leaves the Enterprise cell blank). Figma's two published sources disagree about Starter: this page says 20 a month, while Figma's mcp-server-guide README says 6 a month, and this copy follows the developer page. Limits apply to tools that read from Figma, so writes are exempt. A connection on the wrong seat connects cleanly, reports healthy, and then delivers almost nothing.",
      steps: [
        "Check the seat type on the person signing in: Figma → Settings → Seat type.",
        "Move to a Dev or Full seat before connecting if agents need more than a handful of calls.",
        "Confirm the files and projects agents need are reachable by that person, not only by an admin.",
      ],
      actionLabel: "Open Figma MCP docs",
      actionUrl: "https://developers.figma.com/docs/figma-mcp-server/",
    },
  },
  intercom: {
    // Two hosts, one provider. Intercom serves a separate MCP endpoint per data
    // region, so recognition has to cover both or a pasted EU URL falls through
    // to the generic connector.
    urlPatterns: ["https://mcp.intercom.com/*", "https://mcp.eu.intercom.com/*"],
    setupPrerequisite: {
      title: "A US or EU hosted Intercom workspace",
      description:
        "Intercom hosts workspaces in three regions and serves one MCP endpoint per region. AU hosted workspaces are not supported by the MCP server at all. Pick the region from the workspace URL: app.intercom.com is US, app.eu.intercom.com is EU. EU requests are processed inside the EU under Intercom's regional data hosting commitment.",
      steps: [
        "Open your Intercom workspace URL and confirm it is app.intercom.com or app.eu.intercom.com.",
        "Sign in with an admin who can see the inboxes, teams, and articles agents should work with.",
        "Connect the matching region; an EU workspace cannot be reached through the US endpoint.",
      ],
      actionLabel: "Open the Intercom MCP guide",
      actionUrl: "https://developers.intercom.com/docs/guides/mcp",
    },
  },
};
const oauthMethodFor = (
  entry,
  key = "mcp-oauth",
  serverUrl = entry.serverUrl,
  extra = {},
) =>
  method(
    key,
    "mcp_remote",
    "oauth",
    { serverUrl },
    entry.riskTier,
    `Connect ${entry.name} in the browser. ${entry.prerequisite}`,
    {
      label: `Sign in with ${entry.name}`,
      ownershipModes: ["dcr"],
      whenToUse: "Use browser sign-in for the provider-hosted MCP server.",
      consoleLinks: { docs: entry.docsUrl },
      warnings: [entry.prerequisite],
      ...extra,
    },
  );
const customerOAuthMethodFor = (entry) =>
  oauthMethodFor(entry, "mcp-own-oauth", entry.serverUrl, {
    label: "Use your own OAuth app",
    ownershipModes: ["customer"],
    whenToUse: `Register an OAuth app with ${entry.name}, then enter its client ID and secret.`,
    consoleLinks: { register: entry.docsUrl, docs: entry.docsUrl },
  });
const apiKeySpec = {
  apify: {
    name: "Authorization",
    prefix: "Bearer ",
    placeholder: "Paste your Apify API token",
  },
  bitly: {
    name: "Authorization",
    prefix: "Bearer ",
    placeholder: "Paste your Bitly API token",
  },
  cloudflare: {
    name: "Authorization",
    prefix: "Bearer ",
    placeholder: "Paste your Cloudflare API token",
  },
  coda: {
    name: "Authorization",
    prefix: "Bearer ",
    placeholder: "Paste your Coda API token",
  },
  // Exa's hosted MCP server documents `x-api-key` for developer keys and OAuth
  // for everyone else. Its REST API also accepts Authorization: Bearer, but the
  // MCP server does not, so the placement must match its own documentation.
  exa: {
    name: "x-api-key",
    prefix: null,
    placeholder: "Paste your Exa API key",
  },
  kernel: {
    name: "X-API-Key",
    prefix: null,
    placeholder: "Paste your Kernel API key",
  },
  mem0: { name: "Authorization", prefix: "Bearer ", placeholder: "Paste your Mem0 API key" },
  oreilly: {
    name: "Authorization",
    prefix: "Bearer ",
    placeholder: "Paste your O'Reilly API token",
  },
  pagerduty: {
    name: "Authorization",
    prefix: "Token token=",
    placeholder: "Paste your PagerDuty user API token",
  },
  // Postman's general REST API examples use X-API-Key, but its hosted MCP
  // server explicitly expects the key as an Authorization bearer token.
  postman: {
    name: "Authorization",
    prefix: "Bearer ",
    placeholder: "PMAK-...",
  },
  razorpay: {
    name: "Authorization",
    prefix: "Basic ",
    placeholder: "Paste the base64-encoded key ID and secret",
  },
  sanity: { name: "Authorization", prefix: "Bearer ", placeholder: "sk..." },
  similarweb: {
    name: "api-key",
    prefix: null,
    placeholder: "Paste your Similarweb API key",
  },
  stripe: { name: "Authorization", prefix: "Bearer ", placeholder: "sk_..." },
  supabase: {
    name: "Authorization",
    prefix: "Bearer ",
    placeholder: "sbp_...",
  },
  youcom: {
    name: "Authorization",
    prefix: "Bearer ",
    placeholder: "Paste your You.com API key",
  },
};
const apiKeyMethodFor = (
  entry,
  key = "mcp-api-key",
  serverUrl = entry.serverUrl,
  extra = {},
) => {
  const spec = apiKeySpec[entry.slug] ?? {
    name: "Authorization",
    prefix: "Bearer ",
    placeholder: `Paste your ${entry.name} API key`,
  };
  return method(
    key,
    "mcp_remote",
    "api_key",
    { serverUrl },
    entry.riskTier,
    `Use a customer-created ${entry.name} key. ${entry.prerequisite}`,
    {
      label: "Use an API key",
      whenToUse:
        "Use a restricted customer-owned key when browser sign-in is not suitable.",
      credentialFields: [
        field("authorization", `${entry.name} API key`, spec.placeholder),
      ],
      keyPlacement: {
        location: "header",
        name: spec.name,
        prefix: spec.prefix,
      },
      consoleLinks: { keys: entry.docsUrl, docs: entry.docsUrl },
      warnings: [entry.prerequisite],
      ...extra,
    },
  );
};
// Intercom serves one MCP host per data region, and each host publishes
// authorization-server metadata only at the origin form
// `https://<host>/.well-known/oauth-authorization-server`. It publishes no
// RFC 9728 protected-resource metadata: `GET /mcp` answers 401 with
// `Bearer realm="OAuth", error="invalid_token", error_description="Missing or
// invalid access token"` and no `resource_metadata` parameter, and both
// `/.well-known/oauth-protected-resource/mcp` and
// `/.well-known/oauth-protected-resource` answer 404. So there is no
// authorization-server URL to follow out of protected-resource metadata, and the
// chain has to reach the origin form on its own.
//
// Name that document explicitly instead. It is the same URL the discovery chain
// would eventually probe (`wellKnownMetadataUrls` in tool-access.ts, appended
// after the protected-resource candidates), so nothing is bypassed — but naming
// it is what makes the preflight honest and the gallery fallback usable:
// `preflightGalleryAppMetadata` queues `defaults.metadataUrl` ahead of the derived
// candidates, and `oauthProviderEndpoints` can only read endpoints at all when
// this key is present, because it throws when it is not.
//
// A fixed authorization/token *pair* would be worse than nothing here:
// `oauthEndpointsForConnection` skips discovery entirely when a gallery method
// carries both endpoints, and that skips the discovery result's
// `registration_endpoint` too, leaving DCR with nothing to register against. So
// both regions ship the metadata URL and neither ships the pair.
// Paperclip sends `scopesHint` verbatim as the OAuth `scope` parameter, and
// Intercom's AS metadata advertises no `scopes_supported` at all (verified on
// both hosts 2026-09-30), so nothing validates these strings on the wire. They
// are therefore copied from Intercom's own OAuth Scopes page
// (https://developers.intercom.com/docs/build-an-integration/learn-more/authentication/oauth-scopes),
// which is the list of scope strings Intercom itself offers as Developer Hub
// checkboxes — not reworded, because a shortened or recased scope is not the same
// permission. Note that Intercom's MCP guide writes the articles scope with a
// lowercase "write"; the OAuth Scopes page writes it "Read and Write Articles",
// and this list follows the OAuth Scopes page. A live token is still needed to
// confirm the exact wire form.
const intercomScopesHint = [
  "Read and list users and companies",
  "Read conversations",
  "Write conversations",
  "Read and Write Articles",
];
const intercomMethodDefaults = (host) => ({
  serverUrl: `https://${host}/mcp`,
  metadataUrl: `https://${host}/.well-known/oauth-authorization-server`,
  scopesHint: intercomScopesHint,
});
const specialMethodsFor = (entry) => {
  if (entry.slug === "intercom")
    return [
      oauthMethodFor(entry, "mcp-oauth-us", entry.serverUrl, {
        label: "US hosted workspace",
        whenToUse:
          "Use the US endpoint for a workspace at app.intercom.com.",
        defaults: intercomMethodDefaults("mcp.intercom.com"),
        requiredResourceFilters: ["workspace", "inbox", "team"],
      }),
      oauthMethodFor(
        entry,
        "mcp-oauth-eu",
        "https://mcp.eu.intercom.com/mcp",
        {
          label: "EU hosted workspace",
          whenToUse:
            "Use the EU endpoint for a workspace at app.eu.intercom.com, so requests stay inside the EU.",
          defaults: intercomMethodDefaults("mcp.eu.intercom.com"),
          requiredResourceFilters: ["workspace", "inbox", "team"],
        },
      ),
    ];
  // Figma's remote MCP authorizes as the signed-in Figma user and publishes a
  // single `mcp:connect` scope. Figma refuses RFC 7591 dynamic registration for
  // clients outside its MCP catalog — measured 2026-09-30:
  // `POST https://api.figma.com/v1/oauth/mcp/register` (the advertised
  // `registration_endpoint`) answers 403 Forbidden for every payload shape tried,
  // and `POST https://api.figma.com/v1/oauth/register` answers 404. So the
  // operative ownership mode is `customer`: the operator signs in with a
  // Figma-reviewed client ID and secret, or a deployment preconfigures
  // `PAPERCLIP_TOOL_OAUTH_FIGMA_CLIENT_ID` / `_SECRET`. Shipping `dcr` here would
  // send a default operator down a path that ends in
  // `502 oauth_dynamic_client_registration_failed`.
  //
  // The token endpoint advertises no public-client method, so whichever client is
  // used is confidential and Paperclip stores the secret as an
  // `oauth.client_secret` ref. Whether a customer-registered app can actually
  // obtain a token is still UNVERIFIED — it needs a Figma-reviewed client.
  if (entry.slug === "figma")
    return [
      oauthMethodFor(entry, "mcp-oauth", entry.serverUrl, {
        grantKinds: ["user"],
        ownershipModes: ["customer"],
        defaults: { serverUrl: entry.serverUrl, scopesHint: ["mcp:connect"] },
        guidanceMd: "Sign in with the Figma account whose files agents should read, using a client Figma has reviewed. The connection can only see what that person can already open in Figma.",
        consoleLinks: {
          register: "https://developers.figma.com/docs/rest-api/oauth-apps/",
          settings: "https://www.figma.com/settings",
          docs: entry.docsUrl,
        },
        warnings: [
          entry.prerequisite,
          "Figma refuses RFC 7591 dynamic client registration: POST https://api.figma.com/v1/oauth/mcp/register answers 403 for clients outside the Figma MCP catalog, so this connection signs in with a Figma-reviewed client ID and secret instead of registering one.",
        ],
        requiredResourceFilters: ["team", "project", "file"],
      }),
    ];
  // Exa's hosted server answers anonymously, so sign-in is only about plan
  // limits and Exa Agent, not about access. Exa documents three modes with three
  // URLs: keyless is the bare endpoint, an API key is the bare endpoint plus
  // `x-api-key`, and interactive OAuth is the bare endpoint plus `?login`. The
  // anonymous profile is also the only one without Exa Agent — measured
  // 2026-09-30, `tools/list` returns `web_search_exa` and `web_fetch_exa` with no
  // credential and the same two plus `agent_run` with a bearer token. So the
  // OAuth method has to carry `?login` or it would silently connect to the
  // keyless profile and never expose `agent_run`. `agent_run` is billed usage,
  // which is the one capability worth calling out before a connection starts
  // spending it. `parseRemoteHttpEndpoint` accepts the query and both
  // `protectedResourceMetadataUrls` and `canonicalResourceIndicator` read only
  // the path, so discovery and the RFC 8707 `resource` are unchanged.
  if (entry.slug === "exa")
    return [
      oauthMethodFor(entry, "mcp-oauth", "https://mcp.exa.ai/mcp?login", {
        defaults: { serverUrl: "https://mcp.exa.ai/mcp?login", scopesHint: ["mcp:tools"] },
        guidanceMd: "Sign in to Exa so searches use your team's rate limits instead of the free anonymous profile, and so Exa Agent is available.",
        consoleLinks: {
          keys: "https://dashboard.exa.ai/api-keys",
          settings: "https://dashboard.exa.ai",
          docs: entry.docsUrl,
        },
        warnings: [
          entry.prerequisite,
          "Exa Agent runs are billed usage on your Exa plan. Approve or disable agent_run before letting an agent use it unattended.",
        ],
      }),
      apiKeyMethodFor(entry, "mcp-api-key", entry.serverUrl, {
        guidanceMd: "Create a key in the Exa dashboard and paste it below. A key raises rate limits and enables Exa Agent; the keyless server still works without one. Exa's own instruction for API-key mode is the bare URL without ?login.",
        consoleLinks: {
          keys: "https://dashboard.exa.ai/api-keys",
          docs: entry.docsUrl,
        },
        warnings: [
          entry.prerequisite,
          "Exa Agent runs are billed usage on your Exa plan. Approve or disable agent_run before letting an agent use it unattended.",
        ],
      }),
    ];
  // Apify's MCP server is one hosted endpoint, not one endpoint per Actor.
  // Actors are selected through the `tools` query parameter and run against the
  // authenticated account, so the boundary Paperclip can review is the account.
  //
  // Apify states that its own MCP telemetry is enabled by default for all tool
  // calls, and that the remote opt-out is the `telemetry-enabled=false` query
  // parameter. Both methods therefore default to the opt-out URL. The trailing
  // slash stays because `protectedResourceMetadataUrls` reads only the path: an
  // empty path derives the origin-form RFC 9728 candidate, which is the only
  // form Apify serves (measured 2026-09-30: the origin form answers 200 and the
  // path-aware form 404). Apify's documentation writes the same opt-out URL
  // without the trailing slash; both reach the same endpoint.
  const apifyServerUrl = "https://mcp.apify.com/?telemetry-enabled=false";
  const apifyTelemetryWarning =
    "Apify's MCP server collects telemetry about tool calls and MCP clients, and it is enabled by default. This connection opts out with telemetry-enabled=false on the server URL; that is Apify's opt-out, not a Paperclip telemetry setting.";
  if (entry.slug === "apify")
    return [
      oauthMethodFor(entry, "mcp-oauth", apifyServerUrl, {
        defaults: { serverUrl: apifyServerUrl, scopesHint: ["full_api_access"] },
        guidanceMd: "Sign in to Apify so runs use the account's Actors, datasets, and plan usage. Paperclip records the intended account boundary; the provider enforces what the signed-in account can run.",
        consoleLinks: {
          keys: "https://console.apify.com/account/integrations",
          settings: "https://console.apify.com/actors",
          docs: entry.docsUrl,
        },
        warnings: [
          entry.prerequisite,
          apifyTelemetryWarning,
          "Running an Actor spends the account's plan usage and can incur charges on metered plans.",
        ],
        requiredResourceFilters: ["account", "actor", "dataset"],
      }),
      apiKeyMethodFor(entry, "mcp-api-key", apifyServerUrl, {
        defaults: { serverUrl: apifyServerUrl },
        guidanceMd: "Open Apify Console → Integrations, copy an API token, and paste it below. Runs made through this connection spend that account's plan usage.",
        consoleLinks: {
          keys: "https://console.apify.com/account/integrations",
          docs: entry.docsUrl,
        },
        warnings: [
          entry.prerequisite,
          apifyTelemetryWarning,
          "Running an Actor spends the account's plan usage and can incur charges on metered plans.",
        ],
        requiredResourceFilters: ["account", "actor", "dataset"],
      }),
    ];
  if (entry.slug === "mem0" || entry.slug === "honcho") return [
    apiKeyMethodFor(entry, "mcp-api-key", entry.serverUrl, {
      guidanceMd: `Open the ${entry.name} dashboard, create an API key for the account agents should use, and paste it below.`,
      consoleLinks: { keys: entry.slug === "mem0" ? "https://app.mem0.ai/dashboard/api-keys" : "https://app.honcho.dev", docs: entry.docsUrl },
    }),
  ];
  if (entry.slug === "zep") return [oauthMethodFor(entry, "mcp-oauth", entry.serverUrl, {
    grantKinds: ["user"],
    defaults: { serverUrl: entry.serverUrl, scopesHint: ["graph:read", "graph:write"] },
    guidanceMd: "Sign in with the work identity configured for your Zep project's Memory MCP server. Zep restricts access to that identity's memory and authorized shared graphs.",
    consoleLinks: { settings: "https://app.getzep.com", docs: entry.docsUrl },
  })];
  if (entry.slug === "supermemory") return [oauthMethodFor(entry, "mcp-oauth", entry.serverUrl, {
    grantKinds: ["user"],
    defaults: { serverUrl: entry.serverUrl, scopesHint: ["openid", "profile", "email", "offline_access"] },
    guidanceMd: "Sign in to Supermemory, then choose a workspace, read or write access, and optional tags. Use a separate space for unrelated work.",
  })];
  if (entry.slug === "fireflies")
    return [
      oauthMethodFor(entry, "mcp-oauth", entry.serverUrl, {
        defaults: { serverUrl: entry.serverUrl, scopesHint: ["email", "profile"] },
        guidanceMd: "Sign in to Fireflies to use meeting transcripts, summaries, and action items. Configure optional summary-ready webhooks separately in a routine's Triggers tab.",
      }),
      apiKeyMethodFor(entry, "mcp-api-key", entry.serverUrl, {
        whenToUse: "Use your Fireflies API key instead of browser sign-in.",
        guidanceMd: "Open Fireflies Settings → Developer Settings, copy your API key, and paste it below. This key accesses your meeting data; routine webhooks use a separate signing secret.",
        consoleLinks: {
          keys: "https://app.fireflies.ai/settings",
          docs: entry.docsUrl,
        },
      }),
    ];
  // Atlassian's /authv2 rollout only issues GA-tool-compatible tokens when the
  // authorization request includes this reviewed protected-resource scope set.
  // Omitting scope currently yields agent-interface scopes that its own Jira
  // tools reject with HTTP 401. Users can still deselect write toolsets in the
  // provider consent screen; never replace this allowlist with live discovery.
  if (entry.slug === "jira")
    return [
      oauthMethodFor(entry, "mcp-oauth", entry.serverUrl, {
        defaults: {
          serverUrl: entry.serverUrl,
          scopesHint: [
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
          ],
        },
      }),
    ];
  if (entry.slug === "hugging-face")
    return [
      oauthMethodFor(entry, "mcp-oauth", entry.serverUrl, {
        defaults: { serverUrl: entry.serverUrl, scopesHint: ["read-mcp"] },
      }),
    ];
  if (entry.slug === "xero")
    return [
      oauthMethodFor(entry, "mcp-own-oauth", entry.serverUrl, {
        label: "Use your own OAuth app",
        ownershipModes: ["customer"],
        whenToUse: `Register an OAuth app with ${entry.name}, then enter its client ID and secret.`,
        consoleLinks: { register: entry.docsUrl, docs: entry.docsUrl },
        defaults: {
          serverUrl: entry.serverUrl,
          scopesHint: [
            "openid",
            "profile",
            "email",
            "offline_access",
            "accounting.settings",
            "accounting.invoices.read",
            "accounting.reports.aged.read",
            "accounting.reports.balancesheet.read",
            "accounting.reports.profitandloss.read",
          ],
        },
      }),
    ];
  if (entry.slug === "clickhouse")
    return [
      oauthMethodFor(entry, "mcp-oauth", entry.serverUrl, {
        tenantFields: [
          {
            key: "serviceId",
            label: "ClickHouse Cloud service ID",
            type: "text",
            required: true,
            placeholder: "11e1031f-9a13-4cac-9bc7-d4ec9286ec17",
            helperMd:
              "Copy the service ID from ClickStack → Team Settings → API & Agents.",
            transport: { location: "header", name: "x-service-id" },
          },
        ],
        requiredResourceFilters: ["service"],
      }),
    ];
  if (entry.slug === "planetscale")
    return [
      oauthMethodFor(entry, "mcp-oauth", entry.serverUrl, {
        label: "Database access",
        tenantFields: [
          {
            key: "project",
            label: "Project or database",
            type: "text",
            advanced: true,
            placeholder: "Optional project or database name",
            helperMd:
              "Records the intended database boundary; final access is selected during PlanetScale authorization.",
          },
          {
            key: "branch",
            label: "Branch",
            type: "text",
            advanced: true,
            placeholder: "Optional branch name",
            helperMd:
              "Records the intended branch boundary; final access is selected during PlanetScale authorization.",
          },
        ],
        requiredResourceFilters: ["organization", "database", "branch"],
      }),
      oauthMethodFor(
        entry,
        "mcp-insights-only",
        "https://mcp.pscale.dev/mcp/planetscale-insights-only",
        {
          label: "Insights only",
          whenToUse:
            "Use query insights and schema recommendations without query execution tools.",
          requiredResourceFilters: ["organization", "database", "branch"],
        },
      ),
    ];
  if (entry.slug === "postman")
    return [
      oauthMethodFor(
        entry,
        "mcp-oauth-minimal",
        "https://mcp.postman.com/minimal",
        {
          label: "US · Browser sign-in",
          capabilityProfile: {
            key: "minimal",
            label: "Minimal",
            description:
              "Essential workspace, collection, and environment tools with the smallest tool catalog.",
          },
        },
      ),
      oauthMethodFor(entry, "mcp-oauth-code", "https://mcp.postman.com/code", {
        label: "US · Browser sign-in",
        capabilityProfile: {
          key: "code",
          label: "Code",
          description: "Tools for generating client code from API definitions.",
        },
      }),
      oauthMethodFor(entry, "mcp-oauth-full", "https://mcp.postman.com/mcp", {
        label: "US · Browser sign-in",
        capabilityProfile: {
          key: "write",
          label: "Full",
          description:
            "All Postman API tools, including write-capable collaboration and advanced features.",
        },
      }),
      apiKeyMethodFor(
        entry,
        "mcp-eu-key-minimal",
        "https://mcp.eu.postman.com/minimal",
        {
          label: "EU · API key",
          capabilityProfile: {
            key: "minimal",
            label: "Minimal",
            description:
              "Essential workspace, collection, and environment tools with the smallest tool catalog.",
          },
        },
      ),
      apiKeyMethodFor(
        entry,
        "mcp-eu-key-code",
        "https://mcp.eu.postman.com/code",
        {
          label: "EU · API key",
          capabilityProfile: {
            key: "code",
            label: "Code",
            description:
              "Tools for generating client code from API definitions.",
          },
        },
      ),
      apiKeyMethodFor(
        entry,
        "mcp-eu-key-full",
        "https://mcp.eu.postman.com/mcp",
        {
          label: "EU · API key",
          capabilityProfile: {
            key: "write",
            label: "Full",
            description:
              "All Postman API tools, including write-capable collaboration and advanced features.",
          },
        },
      ),
    ];
  if (entry.slug === "pagerduty")
    return [
      apiKeyMethodFor(
        entry,
        "mcp-api-key-us",
        "https://mcp.pagerduty.com/mcp",
        { label: "US service region" },
      ),
      apiKeyMethodFor(
        entry,
        "mcp-api-key-eu",
        "https://mcp.eu.pagerduty.com/mcp",
        { label: "EU service region" },
      ),
    ];
  if (entry.slug === "supabase") {
    const tenantFields = [
      {
        key: "projectRef",
        label: "Project reference",
        type: "text",
        required: true,
        placeholder: "abcdefghijklmnopqrst",
        helperMd: "Scope the connection to one development project.",
        transport: { location: "query", name: "project_ref" },
      },
      {
        key: "readOnly",
        label: "Read-only mode",
        type: "checkbox",
        defaultValue: false,
        helperMd:
          "Enable this to prevent the connection from changing the database.",
        transport: { location: "query", name: "read_only", format: "boolean" },
      },
      {
        key: "features",
        label: "Feature groups",
        type: "textarea",
        advanced: true,
        placeholder: "database,docs",
        helperMd: "Optional comma-separated feature groups.",
        transport: { location: "query", name: "features", format: "csv" },
      },
    ];
    const warning =
      "Do not connect production data unless you have reviewed Supabase's MCP security guidance.";
    return [
      oauthMethodFor(entry, "mcp-oauth", entry.serverUrl, {
        guidanceMd:
          "Connect Supabase in the browser and scope the connection to one development project. Write tools start enabled and remain governed by Paperclip's action policies.",
        tenantFields,
        warnings: [entry.prerequisite, warning],
        requiredResourceFilters: ["project"],
      }),
      apiKeyMethodFor(entry, "mcp-api-key", entry.serverUrl, {
        guidanceMd:
          "Use a customer-created Supabase key scoped to one development project. Write tools start enabled and remain governed by Paperclip's action policies.",
        tenantFields,
        warnings: [entry.prerequisite, warning],
        requiredResourceFilters: ["project"],
      }),
    ];
  }
  if (entry.slug === "youcom") {
    // You.com also serves a documented keyless profile at ?profile=free with a
    // reduced read-only tool set. That is a real user choice: try web search
    // with no account, or connect the full authenticated server.
    return [
      oauthMethodFor(entry),
      apiKeyMethodFor(entry),
      method(
        "mcp-free",
        "mcp_remote",
        "none",
        { serverUrl: "https://api.you.com/mcp?profile=free" },
        entry.riskTier,
        "Use the keyless free profile. You.com limits the free profile to a reduced read-only tool set.",
        {
          label: "Use the free profile",
          whenToUse:
            "Connect without an account for limited, rate-capped web search.",
          consoleLinks: { docs: entry.docsUrl },
          warnings: [
            "The free profile is keyless and exposes a reduced read-only tool set with You.com rate limits.",
          ],
        },
      ),
    ];
  }
  return null;
};

// Cognee Cloud publishes a local MCP client, not a hosted remote MCP endpoint.
// This approved, pinned template uses the ordinary vault and stdio gateway.
apps.push({
  schemaVersion: 1, slug: "cognee", name: "Cognee",
  description: "Build and recall shared graph memory from documents and conversations.",
  categories: ["ai"], branding: brandingFor("cognee"),
  urlPatterns: ["https://*.aws.cognee.ai/*"],
  docsUrl: "https://docs.cognee.ai/cognee-cloud/connections/cloud-mcp",
  setupPrerequisite: {
    title: "Cognee Cloud and a local runtime",
    description: "Use your Cognee Cloud tenant API URL and key. Paperclip's runtime host needs uv installed to run the official Cognee MCP client. Public deployments require a trusted MCP runtime host.",
    actionLabel: "Open Cognee API keys", actionUrl: "https://platform.cognee.ai/api-keys",
  },
  methods: [method("cloud-local", "local_stdio", "api_key", { templateKey: "paperclip.cognee-cloud" }, "S3",
    "Copy the API Base URL and create an API key on Cognee's API Keys page. Use a Cloud workspace with an active subscription. Paperclip uses its bundled Cloud client; no extra runtime installation is required.", {
      label: "Connect Cognee Cloud", whenToUse: "Connect your Cloud tenant through the official Cognee MCP client.",
      credentialFields: [
        { key: "COGNEE_BASE_URL", label: "API Base URL", type: "text", required: true, secret: false, placeholder: "https://your-tenant.aws.cognee.ai", validation: { pattern: "^https://[a-zA-Z0-9-]+\\.aws\\.cognee\\.ai/?$", maxLength: 255 }, helperMd: "Copy API Base URL from Cognee's API Keys page." },
        { ...field("COGNEE_API_KEY", "Cognee API key", "Paste your Cognee API key"), helperMd: "Create a key in Cognee → API Keys. The key is shown once." },
      ],
      keyPlacement: { location: "env", name: "COGNEE_API_KEY" },
      consoleLinks: { keys: "https://platform.cognee.ai/api-keys", docs: "https://docs.cognee.ai/cognee-cloud/connections/cloud-mcp" },
    })],
});

for (const entry of researchManifest.entries) {
  const existing = apps.find((app) => app.slug === entry.slug);
  if (entry.status === "blocked") {
    if (existing)
      existing.availability = { available: false, reason: entry.prerequisite };
    continue;
  }
  if (existing) {
    existing.docsUrl = entry.docsUrl;
    existing.redirectConstraints = existing.methods.some(
      (entryMethod) => entryMethod.auth === "oauth",
    )
      ? "https-or-loopback-http"
      : existing.redirectConstraints;
    if (entry.slug !== "zapier")
      for (const entryMethod of existing.methods)
        if (
          entryMethod.transport === "mcp_remote" &&
          entryMethod.defaults?.serverUrl
        )
          entryMethod.defaults.serverUrl = entry.serverUrl;
    continue;
  }
  let methods = specialMethodsFor(entry);
  if (!methods) {
    if (entry.authMode === "customer_oauth")
      methods = [customerOAuthMethodFor(entry)];
    else if (entry.authMode === "api_key") methods = [apiKeyMethodFor(entry)];
    else {
      methods = [oauthMethodFor(entry)];
      if (entry.authMode === "dcr_or_api_key")
        methods.push(apiKeyMethodFor(entry));
    }
  }
  const warnings = [];
  if (["coda", "mixpanel"].includes(entry.slug))
    warnings.push(
      "This provider's hosted MCP server is currently beta or preview.",
    );
  if (["brex", "razorpay", "stripe"].includes(entry.slug))
    warnings.push(
      "Financial or destructive actions must be explicitly approved before execution.",
    );
  apps.push({
    schemaVersion: 1,
    slug: entry.slug,
    name: entry.name,
    description:
      descriptionBySlug[entry.slug] ??
      `Connect ${entry.name}'s provider-hosted MCP server.`,
    categories: [categoryBySlug[entry.slug] ?? "other"],
    featured: entry.slug === "jira",
    branding: brandingFor(entry.slug),
    urlPatterns: [`${new URL(entry.serverUrl).origin}/*`],
    docsUrl: entry.docsUrl,
    ...(appExtrasBySlug[entry.slug] ?? {}),
    redirectConstraints: methods.some(
      (entryMethod) => entryMethod.auth === "oauth",
    )
      ? "https-or-loopback-http"
      : undefined,
    methods: methods.map((entryMethod) =>
      warnings.length > 0
        ? {
            ...entryMethod,
            warnings: [...(entryMethod.warnings ?? []), ...warnings],
          }
        : entryMethod,
    ),
  });
}
// Google Workspace definitions are reviewed, first-class app entries rather
// than rows synthesized from the generic connection corpus. Keep each product
// independent in the generated manifest while sharing only backend OAuth
// infrastructure.
const reviewedGoogleSlugs = [
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
for (const slug of reviewedGoogleSlugs) {
  const existingIndex = apps.findIndex((app) => app.slug === slug);
  if (existingIndex >= 0) apps.splice(existingIndex, 1);
  apps.push(
    JSON.parse(fs.readFileSync(path.join(out, `${slug}.json`), "utf8")),
  );
}
const parseTableRow = (line) =>
  line
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
const parseCapture = (fileName) => {
  const markdown = fs.readFileSync(path.join(corpus, fileName), "utf8");
  const stateMatches = [...markdown.matchAll(/^## State: (.+)$/gm)];
  if (stateMatches.length === 0)
    throw new Error(`${fileName}: no captured states`);
  return stateMatches.map((match, index) => {
    const body = markdown.slice(
      match.index + match[0].length,
      stateMatches[index + 1]?.index ?? markdown.length,
    );
    const inputsBlock =
      body.match(/### Inputs\n([\s\S]*?)(?=\n### |$)/)?.[1] ?? "";
    const inputRows = inputsBlock
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .slice(2)
      .map(parseTableRow);
    const fields = inputRows.map(
      ([label, tagType, required, placeholder, prefilledValue, checked]) => ({
        label,
        tagType,
        required: required.toLowerCase() === "yes",
        placeholder: placeholder || null,
        prefilledValue: prefilledValue || null,
        checked: checked.toLowerCase() === "true",
      }),
    );
    const linksBlock =
      body.match(/### Links\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? "";
    const links = linksBlock
      .split("\n")
      .map((line) => line.match(/^(.+?) → (https?:\/\/\S+)$/))
      .filter(Boolean)
      .map((link) => ({ label: link[1].trim(), href: link[2] }));
    return { label: match[1].trim(), fields, links };
  });
};
const inferState = (slug, state) => {
  const label = state.label.toLowerCase();
  const fieldText = state.fields
    .map((field) => field.label.toLowerCase())
    .join(" ");
  const transport =
    slug === "oauth-generic" ||
    slug === "api-key-generic" ||
    label.includes("path: api") ||
    label.includes("api key form")
      ? "rest_api"
      : "mcp_remote";
  const auth =
    slug === "oauth-generic" ||
    label.includes("oauth") ||
    fieldText.includes("client id")
      ? "oauth"
      : slug === "api-key-generic" ||
          label.includes("api key") ||
          fieldText.includes("api key")
        ? "api_key"
        : null;
  const ownershipModes = [];
  // A "Managed" state in Vercel describes credential custody, not ownership of
  // a Paperclip connection. Keep those concepts separate: importing this review
  // evidence must never silently turn an operator-owned connector into
  // `platform_shared`.
  const externalCredentialCustody =
    label.includes("managed") && !label.includes("no managed")
      ? "vercel_connect"
      : null;
  if (
    label.includes("your own credentials") ||
    label.includes("manual") ||
    label.includes("api key")
  )
    ownershipModes.push("customer");
  if (slug === "oauth-generic" && !label.includes("manually"))
    ownershipModes.push("dcr");
  return {
    label: state.label,
    transport,
    auth,
    ownershipModes: [...new Set(ownershipModes)],
    externalCredentialCustody,
    fieldCount: state.fields.length,
    linkCount: state.links.length,
  };
};
// Runtime credentials share the provider catalog, but never expose tool actions.
for (const [slug, name, subscription, envKey] of [["anthropic", "Claude", true, "ANTHROPIC_API_KEY"], ["openai", "OpenAI", true, "OPENAI_API_KEY"], ["openrouter", "OpenRouter", false, "OPENROUTER_API_KEY"], ["xai", "Grok", true, "XAI_API_KEY"]]) {
 let app=apps.find(a=>a.slug===slug);
 if(!app){app={schemaVersion:1,slug,name,description:`Connect ${name} accounts for your agents.`,categories:["ai"],branding:brandingFor(slug),urlPatterns:[{"openai":"https://api.openai.com/*","openrouter":"https://openrouter.ai/api/*","xai":"https://api.x.ai/*"}[slug]],methods:[]};apps.push(app);}
 const methods=(subscription?["subscription","api_key"]:["api_key"]).map(authMethod=>({key:`ai-${authMethod}`,label:authMethod==="subscription"?`${name} subscription`:`${name} API key`,purpose:"ai",transport:"runtime_auth",auth:authMethod==="subscription"?"oauth":"api_key",ai:{provider:slug,method:authMethod},grantKinds:["user","organization"],ownershipModes:["customer"],whenToUse:"Authenticate an agent with this account.",guidanceMd:"Use your personal account or an explicitly shared company account.",riskTier:"S3",...(authMethod==="api_key"?{credentialFields:[field("apiKey","API key","Enter API key")],keyPlacement:{location:"env",name:envKey}}:{})}));
 // Legacy REST entries have no tool execution adapter. Only offer the supported
 // AI account flow; saved REST connections remain removable through Connections.
 app.methods = [...methods, ...app.methods.filter(method => method.transport !== "rest_api")];
}
// Curated picks carry a `developerChoice` flag and a catalog `accentColor` the
// connector card's brand badge reads. Both are curation, not corpus evidence, so
// they live here rather than in a per-provider row — and they have to live
// *somewhere* the generator owns. They used to be set by editing the emitted JSON
// by hand, which meant every regeneration silently dropped them from all seven
// entries. Set them in one pass so `ingest` is idempotent again.
const developerChoiceAccentBySlug = {
  cloudflare: "#F38020",
  github: "#24292F",
  netlify: "#00C7B7",
  notion: "#000000",
  posthog: "#F54E00",
  stripe: "#635BFF",
  supabase: "#3ECF8E",
};
for (const app of apps) {
  const accentColor = developerChoiceAccentBySlug[app.slug];
  if (!accentColor) continue;
  app.branding = { ...app.branding, accentColor };
  // Rebuild in place so `developerChoice` lands next to `featured` and
  // regenerating does not churn key order in the emitted JSON.
  const reordered = {};
  for (const [key, value] of Object.entries(app)) {
    reordered[key] = value;
    if (key === "featured") reordered.developerChoice = true;
  }
  if (reordered.developerChoice !== true) reordered.developerChoice = true;
  for (const key of Object.keys(app)) delete app[key];
  Object.assign(app, reordered);
}
const validateApp = (app) => {
  if (
    app.schemaVersion !== 1 ||
    !app.slug ||
    !app.name ||
    !Array.isArray(app.methods) ||
    app.methods.length === 0
  )
    throw new Error(`${app.slug || "unknown"}: invalid AppDefinition`);
  for (const connectionMethod of app.methods) {
    if (
      connectionMethod.auth === "api_key" &&
      !connectionMethod.keyPlacement &&
      (connectionMethod.purpose ?? "tool") !== "channel"
    )
      throw new Error(
        `${app.slug}/${connectionMethod.key}: tool api_key requires keyPlacement`,
      );
    if (
      connectionMethod.auth === "oauth" &&
      connectionMethod.ownershipModes.length === 0
    )
      throw new Error(
        `${app.slug}/${connectionMethod.key}: oauth requires ownershipModes`,
      );
    for (const connectionField of [
      ...(connectionMethod.tenantFields ?? []),
      ...(connectionMethod.extensionFields ?? []),
      ...(connectionMethod.credentialFields ?? []),
    ])
      if (
        connectionField.required &&
        connectionField.type !== "checkbox" &&
        !connectionField.placeholder
      )
        throw new Error(
          `${app.slug}/${connectionMethod.key}/${connectionField.key}: required field needs placeholder`,
        );
  }
};
const captureFiles = definitionsOnly ? [] : fs
  .readdirSync(corpus)
  .filter((fileName) => fileName.endsWith(".md") && fileName !== "INDEX.md")
  .sort();
if (!definitionsOnly && captureFiles.length !== 99)
  throw new Error(`Expected 99 captures, found ${captureFiles.length}`);
const parsedCaptures = Object.fromEntries(
  captureFiles.map((fileName) => [
    path.basename(fileName, ".md"),
    parseCapture(fileName),
  ]),
);
const reviewReport = {
  schemaVersion: 1,
  corpusSize: captureFiles.length,
  providers: captureFiles.map((fileName) => {
    const slug = path.basename(fileName, ".md");
    const states = parsedCaptures[slug].map((state) => inferState(slug, state));
    return {
      slug,
      stateCount: states.length,
      states,
      ambiguities: states
        .filter((state) => !state.auth)
        .map(
          (state) => `Auth is not explicit in capture state: ${state.label}`,
        ),
    };
  }),
};
for (const app of apps) {
  validateApp(app);
  if (parsedCaptures[app.slug] && parsedCaptures[app.slug].length === 0)
    throw new Error(`${app.slug}: capture has no states`);
}
fs.mkdirSync(out, { recursive: true });
for (const app of apps)
  fs.writeFileSync(
    path.join(out, `${app.slug}.json`),
    JSON.stringify(app, null, 2) + "\n",
  );
if (!definitionsOnly) fs.writeFileSync(
  path.join(root, "packages/shared/src/app-definitions.ingestion-report.json"),
  JSON.stringify(reviewReport, null, 2) + "\n",
);
const imports = apps
  .map(
    (a, i) =>
      `import a${i} from "./app-definitions/${a.slug}.json" with { type: "json" };`,
  )
  .join("\n");
fs.writeFileSync(
  path.join(root, "packages/shared/src/app-definitions.generated.ts"),
  `${imports}\nimport type { AppDefinition } from "./types/app-definition.js";\nexport const APP_DEFINITIONS=[${apps.map((_, i) => `a${i}`).join(",")}] as AppDefinition[];\n`,
);
const ambiguityCount = reviewReport.providers.reduce(
  (total, provider) => total + provider.ambiguities.length,
  0,
);
console.log(
  `Parsed ${captureFiles.length} captures and ${reviewReport.providers.reduce((total, provider) => total + provider.stateCount, 0)} states; emitted ${apps.length} Wave 1 definitions and flagged ${ambiguityCount} states for review.`,
);
