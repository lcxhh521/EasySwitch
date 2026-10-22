import { AsyncLocalStorage } from "node:async_hooks";
import { ProtocolError } from "./protocol.ts";
import type { Provider } from "./types.ts";

/** The caller owns authorization and identity validation; this layer never chooses a source or key. */
export interface AutomaticAttempt {
  providerId: string;
  keyId?: string;
  readKey(signal: AbortSignal): Promise<string>;
  beforeDispatch(signal: AbortSignal): Promise<void>;
  /** Recheck revocation/configuration stamps synchronously after the last await, immediately before dispatch. */
  assertDispatch?(): void;
  /** Only a returned HTTP response is an observation, never a local guard or transport error. */
  observe(status: number): void;
}

/** Shared by every member and nested adapter retry of one logical request. */
export interface AutomaticDispatchBudget { used: number; limit: 2 }

const context = new AsyncLocalStorage<{ attempt: AutomaticAttempt; budget: AutomaticDispatchBudget }>();

export function withAutomaticAttempt<T>(attempt: AutomaticAttempt, budget: AutomaticDispatchBudget, run: () => Promise<T>): Promise<T> {
  const outer = context.getStore();
  if (outer && outer.budget !== budget) throw new ProtocolError("自动选择不能重置本次请求的尝试次数。", 409);
  // Keep this attempt's identity fixed even if its caller later updates an object.
  return context.run({ attempt: Object.freeze({ ...attempt }), budget }, run);
}

export function currentAutomaticAttempt(): AutomaticAttempt | undefined { return context.getStore()?.attempt; }

/** Defense in depth: dedicated adapters can refresh credentials or dispatch outside ordinary fetch. */
export function assertAutomaticProvider(provider: Provider): AutomaticAttempt | undefined {
  const attempt = currentAutomaticAttempt();
  if (!attempt) return undefined;
  if (attempt.providerId !== provider.id) throw new ProtocolError("自动选择的固定来源已改变，请重新确认来源名单。", 409);
  if ([provider.plan, provider.kiro, provider.antigravity, provider.cursor, provider.kimi, provider.vertex, provider.cliTextBridge].some(value => value !== undefined) || provider.mimoFree) {
    throw new ProtocolError("这个专用来源暂不支持自动选择，请使用明确选择的固定来源。", 400);
  }
  return attempt;
}

/** The sole ordinary HTTP dispatch boundary, including nested request-shape repairs. */
export async function dispatchInference(provider: Provider, signal: AbortSignal, dispatch: () => Promise<Response>): Promise<Response> {
  const state = context.getStore();
  if (!state) return dispatch();
  const attempt = assertAutomaticProvider(provider)!;
  signal.throwIfAborted();
  await attempt.beforeDispatch(signal);
  signal.throwIfAborted();
  attempt.assertDispatch?.();
  signal.throwIfAborted();
  const budget = state.budget;
  if (budget.limit !== 2 || !Number.isSafeInteger(budget.used) || budget.used < 0 || budget.used >= budget.limit) {
    throw new ProtocolError("本次自动选择最多尝试两次，已停止重试。请检查来源后重新发起请求。", 409);
  }
  // No await between the final check, increment and call: concurrent completions cannot overrun it.
  budget.used += 1;
  const response = await dispatch();
  attempt.observe(response.status);
  return response;
}
