/** Explicit source configuration; never starts a CLI or discovers credentials. */
import type { Provider } from "./types.ts";
import { qoderTextBridgeIssue, type QoderTextBridgeConfig } from "./qoder-text-bridge.ts";
import { codeBuddyTextBridgeIssue, type CodeBuddyTextBridgeConfig } from "./codebuddy-text-bridge.ts";
export type CliTextBridgeConfig = ({ kind: "qoder" } & QoderTextBridgeConfig) | ({ kind: "codebuddy" } & CodeBuddyTextBridgeConfig) | { kind: "droid" };
export function cliTextSourceIssue(provider: Pick<Provider, "cliTextBridge"> & Partial<Provider>): string | undefined {
  const value: unknown = provider.cliTextBridge;
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "CLI文字来源配置无效。";
  if (provider.plan || provider.kiro || provider.antigravity || provider.cursor || provider.kimi || provider.vertex || provider.mimoFree) return "CLI文字来源不能混用其他来源鉴权。";
  const { kind, ...config } = value as Record<string, unknown>;
  if (kind === "qoder") return qoderTextBridgeIssue(config);
  if (kind === "codebuddy") return codeBuddyTextBridgeIssue(config);
  if (kind === "droid" && !Object.keys(config).length) return undefined;
  return "请选择明确支持的CLI文字来源，不接受额外字段。";
}
