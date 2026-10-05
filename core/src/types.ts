// Shared data shapes. The JSON Schemas in contracts/ are the language-neutral
// source of truth; these types mirror them for the TypeScript core.

/** How the gateway reaches a provider for Responses traffic. */
export type ProviderRoute = "responses-native" | "chat-translate";

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
  /** Whether the provider accepts `stream_options.include_usage`. */
  streamUsage: boolean;
  probe?: ProbeReport;
  createdAt: string;
}

export type ProbeStatus = "pass" | "fail" | "skip";

export interface ProbeCheck {
  id: "models" | "chat" | "chat-stream" | "tools" | "responses";
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
}

/** Which provider model a harness uses in an EasySwitch session. */
export interface HarnessBinding {
  harness: "codex";
  providerId: string;
  model: string;
}

export interface GatewayLogEntry {
  at: string;
  model: string;
  route: ProviderRoute;
  status: number;
  ms: number;
  note?: string;
}
