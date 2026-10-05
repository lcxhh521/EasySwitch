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
  createdAt: string;
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

/** Which provider model a harness uses in an EasySwitch session. */
export type Harness = "codex" | "claude";

export interface HarnessBinding {
  harness: Harness;
  providerId: string;
  model: string;
}

export interface GatewayLogEntry {
  at: string;
  model: string;
  route: ProviderRoute | MessagesRoute;
  harness?: Harness;
  status: number;
  ms: number;
  note?: string;
}
