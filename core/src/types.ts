// Shared data shapes. The JSON Schemas in contracts/ are the language-neutral
// source of truth; these types mirror them for the TypeScript core.

/** How the gateway reaches a provider for Responses traffic (Codex). */
export type ProviderRoute = "responses-native" | "chat-translate";

/** How the gateway reaches a provider for Anthropic Messages traffic (Claude Code). */
export type MessagesRoute = "anthropic-native" | "chat-translate";

export interface Provider {
  /** URL-safe slug; exposed model ids are `<id>/<upstream model>`. */
  id: string;
  name: string;
  /** OpenAI-compatible base URL, e.g. https://relay.example.com/v1 */
  baseUrl: string;
  /** Model used for probing and as the default binding. */
  defaultModel?: string;
  /** Model ids the provider listed the last time we asked. */
  models: string[];
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
  /** This provider is Kiro: the user's own Kiro CLI login is read for each request (see kiro.ts). `loginPath` overrides where it is read from. */
  kiro?: { loginPath?: string };
  /** This provider is Xiaomi's MiMo Free endpoint: no key, a bootstrapped JWT and a required system marker (see mimo-free.ts). */
  mimoFree?: boolean;
  probe?: ProbeReport;

  /**
   * The user has switched this subscription off: it is kept (login and settings stay) but used nowhere: not in
   * model menus, pools or dispatch, and a request that names it is refused with a plain reason. New
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
  prefs: Record<string, { effort?: string; tiers?: Record<string, string> }>;
  createdAt: string;
}

/** A model pool: one name for several places to get the model from (see pools.ts). */
export interface Pool {
  id: string;
  name: string;
  strategy: "order" | "rotate";
  /** `<provider>/<model>`, in the order they are tried under "order". */
  members: string[];
  createdAt: string;
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
  paths?: Partial<Record<"chat" | "responses" | "messages" | "models", string>>;
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
  /** Augmented sessions get the EasySwitch MCP server, so any agent can hand work to the others. */
  agentCalls: boolean;
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

export interface GatewayLogEntry {
  at: string;
  /** The exposed model id, `<provider>/<model>`. */
  model: string;
  providerId?: string;
  route: ProviderRoute | MessagesRoute;
  /** The agent that made the call: "codex", "claude", or another agent's id; "chat" when unknown. */
  harness?: string;
  status: number;
  ms: number;
  /** Through a model pool: which pool, and which try this was out of how many. */
  pool?: string;
  attempt?: number;
  attempts?: number;
  /** Token usage when the upstream reported it; absent on passthrough routes. */
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  /** What the translation could not carry (`tool:web_search`, ...). */
  dropped?: string[];
  /** Which key of the provider's pool answered. */
  keyId?: string;
  /** Estimated USD at the vendor's pay-as-you-go price when the call was made; absent when unpriced or on a subscription. */
  costUsd?: number;
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
