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
  probe?: ProbeReport;
  /**
   * The key pool, tried in order. Absent on providers saved before pools:
   * those have one implicit key stored under the provider id (see keypool.ts).
   */
  keys?: ProviderKey[];
  createdAt: string;
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

/** How "auto" picks an account. Off unless the user switched it on. */
export interface AccountSettings {
  /** The user turned on automatic account choice after reading the terms notice. */
  autoPick: boolean;
  /** How long a "hit the limit" mark lasts when the user gives no time, in hours. */
  defaultRestHours: number;
}

/** Which provider model a harness uses in an EasySwitch session. */
export type Harness = "codex" | "claude";

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
  harness?: Harness;
  status: number;
  ms: number;
  /** Token usage when the upstream reported it; absent on passthrough routes. */
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  /** What the translation could not carry (`tool:web_search`, ...). */
  dropped?: string[];
  /** Which key of the provider's pool answered. */
  keyId?: string;
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
}
