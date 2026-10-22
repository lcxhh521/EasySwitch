import type { CliTextBridgeConfig } from "./cli-text-source.ts";
import type { VertexConfig } from "./vertex-config.ts";

// Shared data shapes. The JSON Schemas in contracts/ are the language-neutral
// source of truth; these types mirror them for the TypeScript core.

/** How the gateway reaches a provider for Responses traffic (Codex). */
export type ProviderRoute = "responses-native" | "chat-translate";

/** How the gateway reaches a provider for Anthropic Messages traffic (Claude Code). */
export type MessagesRoute = "anthropic-native" | "chat-translate";

/** Agent-facing APIs; the source and model select the independent outbound protocol. */
export type ApiProtocol = "chat" | "responses" | "messages" | "gemini";

export interface Provider {
  /** Explicit metadata polling permission and proof bound to the current source configuration. */
  healthMonitor?: { enabled: boolean; verifiedFingerprint?: string };
  /** Explicit text-only CLI source. Never an ordinary HTTP endpoint. */
  cliTextBridge?: CliTextBridgeConfig;
  /** Explicit Vertex auth/protocol mode, or the legacy service-account shape; never contains a credential. */
  vertex?: VertexConfig;
  /** URL-safe slug; exposed model ids are `<id>/<upstream model>`. */
  id: string;
  name: string;
  /** OpenAI-compatible base URL, e.g. https://relay.example.com/v1 */
  baseUrl: string;
  /** Model used for probing and as the default binding. */
  defaultModel?: string;
  /** Model ids the provider listed the last time we asked. */
  models: string[];
  /** Supported upstream APIs in preference order; the incoming protocol wins when available. */
  protocols?: ApiProtocol[];
  /** Per-model capability override, keyed by the upstream model id (without context suffixes). */
  modelProtocols?: Record<string, ApiProtocol[]>;
  /** Chosen by the last probe unless the user pinned it. */
  route: ProviderRoute;
  routePinned: boolean;
  /** Chosen by the last probe: pass Claude Code's requests through, or translate. */
  messagesRoute?: MessagesRoute;
  /**
   * Where the provider serves the Anthropic Messages API, when it differs from
   * `baseUrl` (DeepSeek, for example, serves it under /anthropic).
   */
  anthropicBaseUrl?: string;
  /** Whether the provider accepts `stream_options.include_usage`. */
  streamUsage: boolean;
  /** Overrides the built-in guess about how this provider takes a thinking level (true: Chat's reasoning_effort, false: never send one). */
  reasoningEffort?: boolean;
  /** Thinking levels the user says a model on this provider has, by model id. Overrides what EasySwitch knows. */
  modelEfforts?: Record<string, string[]>;
  /** User-configured context tokens for this exact source/model; absent means unknown. */
  modelContextWindows?: Record<string, number>;
  /** This provider is Google Antigravity (Cloud Code Assist): the Google account that signed in and the project found for it (see antigravity.ts). */
  antigravity?: { accountId: string; email: string; projectId: string };
  /** This provider is a Kimi Code account signed in with a device code (see kimi.ts). */
  kimi?: { accountId: string; email?: string };
  /** This provider is a Cursor account: who signed in (the login itself is in the secret store; see cursor/auth.ts). */
  cursor?: { accountId: string; email?: string };
  /** This provider is Kiro: the user's own Kiro CLI login is read for each request (see kiro.ts). `loginPath` overrides where it is read from. */
  kiro?: { loginPath?: string };
  /** This provider is Xiaomi's MiMo Free endpoint: no key, a bootstrapped JWT and a required system marker (see mimo-free.ts). */
  mimoFree?: boolean;
  probe?: ProbeReport;

  /** A monthly budget in USD (the ledger's estimate at the vendor's prices); with `stop`, the source is used nowhere once it is gone, until the month turns. */
  budget?: { monthlyUsd: number; stop?: boolean };
  /**
   * The user has switched this subscription off: it is kept (login and settings stay) but used nowhere: not in
   * model menus or pools, and a request that names it is refused with a plain reason. New
   * subscriptions start switched off.
   */
  off?: boolean;
  /** This provider is a ChatGPT plan reached through "Sign in with ChatGPT": the key is a renewed OAuth token, not a stored key. */
  plan?: { kind: "chatgpt" | "codex" | "copilot"; accountId: string };
  /** How the user pays: per token (default) or a flat subscription, where per-call cost is not meaningful. */
  billing?: "usage" | "subscription";
  /** The user's own prices (USD per 1M tokens) by model id; they win over the built-in table. */
  prices?: Record<string, Rates>;
  /** Icon chosen when the provider was added (from its preset); otherwise derived from the address. */
  icon?: string;
  /**
   * Values for `{placeholders}` in the addresses (Azure resource name, Cloudflare
   * account id…). Filled in by the user when adding the provider.
   */
  urlParams?: Record<string, string>;
  /** How this provider differs from plain "Bearer key on /chat/completions". */
  wire?: WireConfig;
  /**
   * The key pool, tried in order. Absent on providers saved before pools:
   * those have one implicit key stored under the provider id (see keypool.ts).
   */
  keys?: ProviderKey[];
  createdAt: string;
}

/** A saved set of every agent's settings (main model, thinking level, other models), to switch back to in one click. */
export interface Profile {
  id: string;
  name: string;
  bindings: HarnessBinding[];
  prefs: Record<string, { effort?: string; tiers?: Record<string, string>; fallbackModel?: string }>;
  createdAt: string;
}

/** A model pool: one name for several places to get the model from (see pools.ts). */
export interface Pool {
  id: string;
  name: string;
  strategy: "order" | "rotate" | "automatic";
  /** `<provider>/<model>`, in the order they are tried under "order". */
  members: string[];
  /** Explicit finite source/credential grant. Seals are internal, never part of a public pool response. */
  automaticApproval?: AutomaticApproval;
  createdAt: string;
}

/** A content-bound authorization snapshot, not proof that different keys share an account. */
export interface AutomaticApproval {
  version: 1;
  /** Random domain separation; contains neither a credential nor an authentication capability. */
  salt: string;
  members: Array<{
    /** Exact `<provider>/<model>` in the user-confirmed order. */
    member: string;
    /** Absent only for the legacy single credential stored under the provider ID. */
    keyId?: string;
    credentialLabel: string;
    /** Private nonsecret configuration/generation digest; distinguishes config drift from credential replacement. */
    configurationSeal: string;
    /** Private one-way seal over current configuration, revision and credential contents. */
    seal: string;
  }>;
}

/** USD per million tokens. */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Wire-level differences a provider may have; all optional, all plain data. */
export interface WireConfig {
  /** Header that carries the key; default "authorization". */
  authHeader?: string;
  /** "bearer" sends `Bearer <key>`; "raw" sends the key as is (api-key, x-goog-api-key). */
  authScheme?: "bearer" | "raw";
  /** Extra fixed headers. */
  headers?: Record<string, string>;
  /** Extra query parameters on every call (Azure's api-version on older APIs). */
  query?: Record<string, string>;
  /** Path overrides per call kind, relative to the base address. */
  paths?: Partial<Record<"chat" | "responses" | "messages" | "gemini" | "models", string>>;
}

/** One key (one account, one subscription) of a provider. The secret itself lives in the Keychain. */
export interface ProviderKey {
  id: string;
  label: string;
  enabled: boolean;
  addedAt: string;
  lastUsedAt?: string;
  /** After an auth, quota or rate-limit failure the key rests until then; others go first. */
  restUntil?: string;
  lastError?: { at: string; status: number; reason: string };
}

export type ProbeStatus = "pass" | "fail" | "skip";

export interface ProbeCheck {
  id: "models" | "chat" | "chat-stream" | "tools" | "responses" | "messages";
  label: string;
  status: ProbeStatus;
  latencyMs?: number;
  detail: string;
}

export interface ProbeReport {
  at: string;
  model: string;
  checks: ProbeCheck[];
  recommendedRoute: ProviderRoute;
  recommendedMessagesRoute?: MessagesRoute;
}

/**
 * One of the user's own subscription logins for a harness. The login itself
 * lives in a directory EasySwitch created for it (CODEX_HOME / CLAUDE_CONFIG_DIR),
 * never in the harness's global config; starting a session with that directory
 * is the whole mechanism. Everything stays on this Mac.
 */
export interface Account {
  id: string;
  harness: "codex" | "claude";
  label: string;
  /** Absolute path of this account's isolated home. */
  home: string;
  enabled: boolean;
  addedAt: string;
  lastUsedAt?: string;
  /** Marked as out of quota until then; auto-pick skips it, and it comes back by itself. */
  restUntil?: string;
}

/** Switches that apply to every launch. */
export interface Settings {
  /** Claude Code sessions keep the user's own Claude login, so Claude's own models and ours share one menu. */
  claudeNative: boolean;
}

/** How money is shown: USD as priced, or converted at the user's own rate. */
export interface DisplaySettings {
  currency: "USD" | "CNY";
  /** CNY per USD, chosen by the user; there is no live exchange rate here. */
  usdToCny: number;
}

/** How "auto" picks an account. Off unless the user switched it on. */
export interface AccountSettings {
  /** The user turned on automatic account choice after reading the terms notice. */
  autoPick: boolean;
  /** How long a "hit the limit" mark lasts when the user gives no time, in hours. */
  defaultRestHours: number;
}

/** Which provider model a harness uses in an EasySwitch session. */
export type Harness = string;

export interface HarnessBinding {
  harness: Harness;
  providerId: string;
  model: string;
}

/** Evidence attached to a subsequent pool attempt, not a new billable log entry. */
export interface PoolRetryEvidence { member: string; attempt: number; status: number }

export interface GatewayLogEntry {
  fallback?: import("./agent-fallback.ts").AgentFallbackChange;
  /** Issued capability identity, never its token. */
  sessionId?: string;
  at: string;
  /** Exact server-owned task attribution; never accepted from inference request bodies. */
  taskId?: string;
  taskGroupId?: string;
  taskPhase?: "task" | "review";
  /** The exposed model id, `<provider>/<model>`. */
  model: string;
  providerId?: string;
  route: ProviderRoute | MessagesRoute;
  inboundProtocol?: ApiProtocol;
  outboundProtocol?: ApiProtocol;
  adapter?: string;
  /** The agent that made the call: "codex", "claude", or another agent's id; "chat" when unknown. */
  harness?: string;
  status: number;
  ms: number;
  /** Through a model pool: which pool, and which try this was out of how many. */
  pool?: string;
  attempt?: number;
  attempts?: number;
  /** The previous member's retryable pre-output refusal. Does not imply success or outbound I/O. */
  retryFrom?: PoolRetryEvidence;
  /** True only when reported usage and protocol termination are both complete. */
  usageComplete?: boolean;
  /** Bounded decoder observations, separate from normalized usage and pricing claims. */
  usageObservation?: import("./usage-observation.ts").UsageObservation;
  /** Token usage when the upstream reported it; absent on passthrough routes. */
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  /** What the translation could not carry (`tool:web_search`, ...). */
  dropped?: string[];
  /** Which key of the provider's pool answered. */
  keyId?: string;
  /** Log-time estimated USD from user rates or an unverified legacy reference, never a vendor bill. */
  costUsd?: number;
  /** New log-time evidence only. Absent means unknown provenance; never infer it from current config. */
  pricingProvenance?: import("./pricing/provenance.ts").PricingProvenance;
  /** Why there is no cost: the provider is a flat subscription, or no price is known for the model. */
  costNote?: "subscription" | "unpriced";
  /** Short failure or recovery description. */
  note?: string;
}

/** A running augmented session, read from the process table. */
export interface SessionInfo {
  pid: number;
  harness: Harness;
  model?: string;
  startedAt?: string;
}

/** A provider the user can add with one click. */
export interface ProviderPreset {
  /** New-add guard from official retirement guidance; absence is not a live availability claim. */
  unavailable?: { reason: string; sourceUrl: string };
  vertexMode?: "standard" | "express";
  protocols?: ApiProtocol[];
  id: string;
  name: string;
  icon: string;
  baseUrl: string;
  anthropicBaseUrl?: string;
  defaultModel?: string;
  keyUrl?: string;
  /** One line of guidance shown under the preset (where to get a key, etc.). */
  note?: string;
  /** Group heading in the picker. */
  category?: string;
  /** Placeholders in baseUrl / anthropicBaseUrl the user has to fill in. */
  urlParams?: Array<{ key: string; label: string; example?: string }>;
  wire?: WireConfig;
  /** Models this preset serves when none can be discovered (a keyless endpoint with a fixed list). */
  models?: string[];
}
