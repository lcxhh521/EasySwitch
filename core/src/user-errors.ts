/** Typed Node facade for the exact same pure dictionary loaded by the browser. */
import "../../web/errors.js";

export type UserErrorContext = "local" | "source" | "session" | "launch" | "budget" | "storage" | "keychain" | "request";
export type UserErrorTarget = "doctor" | "current" | "providers" | "usage" | "agents" | "sessions";
export interface UserErrorEntry { code: string; title: string; reason: string; action: { label: string; target: UserErrorTarget } }
export interface HumanError extends UserErrorEntry { message: string; details: { code: string; status?: number; technicalCode?: string; osStatus?: number } }
export interface UserErrorsApi {
  humanError(input: unknown, options?: { context?: UserErrorContext }): HumanError;
  registeredErrors(): UserErrorEntry[];
  requireRegisteredError(code: string): HumanError;
}
const api = (globalThis as typeof globalThis & { EasySwitchErrors: UserErrorsApi }).EasySwitchErrors;
export const humanError = api.humanError;
export const registeredErrors = api.registeredErrors;
export const requireRegisteredError = api.requireRegisteredError;
