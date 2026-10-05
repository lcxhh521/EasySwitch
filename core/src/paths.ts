import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where EasySwitch keeps its own state. Never inside another tool's config
 * directory: the whole point is to leave those untouched.
 * EASYSWITCH_HOME relocates everything (tests use a temp dir).
 */
export function dataDir(): string {
  return process.env.EASYSWITCH_HOME ?? join(homedir(), "Library", "Application Support", "EasySwitch");
}

export function logDir(): string {
  return process.env.EASYSWITCH_HOME
    ? join(process.env.EASYSWITCH_HOME, "logs")
    : join(homedir(), "Library", "Logs", "EasySwitch");
}

export const DEFAULT_PORT = 18765;

export function gatewayPort(): number {
  const raw = process.env.EASYSWITCH_PORT;
  const port = raw ? Number(raw) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`invalid EASYSWITCH_PORT: ${raw}`);
  return port;
}
