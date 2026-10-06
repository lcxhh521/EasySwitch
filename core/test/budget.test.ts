import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { addSpend, budgetStatus, clearSpend, isBudgetStopped, loadMonth, monthStart, spentThisMonth } from "../src/budget.ts";
import { catalogModels } from "../src/catalog.ts";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { GatewayLogEntry, Provider } from "../src/types.ts";
import { startMockRelay } from "./mock-relay.ts";

process.env.EASYSWITCH_SECRETS = "memory";
type Json = Record<string, any>;
beforeEach(() => clearSpend());

const NOW = new Date();
const p = (budget?: Provider["budget"]): Pick<Provider, "id" | "budget"> => ({ id: "x", ...(budget ? { budget } : {}) });

test("the month's cost is added up per source, reaches 'near' at 80% and 'over' at 100%, and a source with no budget has no status", () => {
  assert.equal(budgetStatus(p()), undefined);
  assert.equal(budgetStatus(p({ monthlyUsd: 0 })), undefined);
  addSpend("x", 3.9); addSpend("x", 0.2); addSpend("other", 99);
  assert.equal(spentThisMonth("x"), 4.1);
  assert.equal(budgetStatus(p({ monthlyUsd: 10 }))!.level, "ok");
  addSpend("x", 4);
  assert.equal(budgetStatus(p({ monthlyUsd: 10 }))!.level, "near");
  addSpend("x", 2);
  const over = budgetStatus(p({ monthlyUsd: 10 }))!;
  assert.equal(over.level, "over");
  assert.ok(Math.abs(over.spent - 10.1) < 1e-9 && over.ratio > 1);
  addSpend("x", -5); addSpend("x", NaN as number);
  assert.ok(Math.abs(spentThisMonth("x") - 10.1) < 1e-9, "a negative or missing cost adds nothing");
});

test("only a source set to stop is stopped, and only once the month's budget is gone", () => {
  addSpend("x", 20);
  assert.equal(isBudgetStopped(p({ monthlyUsd: 10 })), false, "a budget that only warns never stops anything");
  assert.equal(isBudgetStopped(p({ monthlyUsd: 10, stop: true })), true);
  assert.equal(isBudgetStopped(p({ monthlyUsd: 30, stop: true })), false, "not yet");
  assert.equal(isBudgetStopped(p()), false);
});

test("a new month starts again from nothing, and costs from last month never count", () => {
  const lastMonth = new Date(NOW.getFullYear(), NOW.getMonth() - 1, 15);
  addSpend("x", 50, lastMonth);
  assert.equal(spentThisMonth("x"), 0, "last month's cost is not this month's");
  const entries = [
    { at: lastMonth.toISOString(), providerId: "x", costUsd: 7 }, { at: NOW.toISOString(), providerId: "x", costUsd: 2 },
    { at: NOW.toISOString(), providerId: "y", costUsd: 1 }, { at: NOW.toISOString(), providerId: "x" },
  ] as GatewayLogEntry[];
  loadMonth(entries, NOW);
  assert.equal(spentThisMonth("x", NOW), 2, "rebuilt from the ledger: this month only");
  assert.equal(spentThisMonth("y", NOW), 1);
  const nextMonth = new Date(NOW.getFullYear(), NOW.getMonth() + 1, 2);
  assert.equal(spentThisMonth("x", nextMonth), 0, "when the month turns the totals start over");
  assert.equal(monthStart(NOW).getDate(), 1);
});

test("a source that has used its budget and is set to stop leaves the model catalog, like a switched-off one", () => {
  const prov = { id: "x", name: "X", baseUrl: "http://x", models: ["m"], budget: { monthlyUsd: 1, stop: true } } as Provider;
  assert.equal(catalogModels([prov]).length, 1);
  addSpend("x", 2);
  assert.equal(catalogModels([prov]).length, 0);
});

let relay: Awaited<ReturnType<typeof startMockRelay>>;
let server: Server;
let port: number;
let store: Store;
const dir = mkdtempSync(join(tmpdir(), "es-budget-"));
const H = { "content-type": "application/json", "x-easyswitch": "1" };
const api = (m: string, path: string, b?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { method: m, headers: H, ...(b ? { body: JSON.stringify(b) } : {}) });

before(async () => {
  relay = await startMockRelay(0, { apiKey: "k1" });
  port = await new Promise<number>(resolve => { const s = createServer().listen(0, "127.0.0.1", () => { const n = (s.address() as { port: number }).port; s.close(() => resolve(n)); }); });
  store = new Store(join(dir, "store"));
  server = createEasySwitchServer({ store, secrets: createSecretStore(), port });
  await new Promise<void>(r => server.listen(port, "127.0.0.1", r));
});
after(() => { server.closeAllConnections(); server.close(); relay.server.closeAllConnections(); relay.server.close(); rmSync(dir, { recursive: true, force: true }); });

test("through the gateway: a budget is set and shown, a source over it that is set to stop is refused with a plain reason, and lifting the budget brings it back", async () => {
  const made = await api("POST", "/api/providers", { name: "relay", baseUrl: relay.baseUrl, apiKey: "k1" });
  const id = ((await made.json()) as { id: string }).id;
  const provider = store.provider(id)!; provider.models = ["mock-coder"]; store.upsertProvider(provider);
  const ask = () => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer es-session-aider-x" }, body: JSON.stringify({ model: `${id}/mock-coder`, messages: [{ role: "user", content: "hi" }] }) });

  assert.equal((await api("PUT", `/api/providers/${id}/budget`, { monthlyUsd: -3 })).status, 400);
  assert.equal((await api("PUT", `/api/providers/nope/budget`, { monthlyUsd: 3 })).status, 404);
  const set = await api("PUT", `/api/providers/${id}/budget`, { monthlyUsd: 5, stop: true });
  assert.equal(set.status, 200);
  assert.equal(((await set.json()) as Json).status.level, "ok");
  assert.equal((await ask()).status, 200);
  const shown = ((await (await api("GET", "/api/state")).json()) as Json).providers.find((x: Json) => x.id === id);
  assert.equal(shown.budget.monthlyUsd, 5);
  assert.equal(shown.budgetStatus.level, "ok", "the console is told how much of the budget is used");

  addSpend(id, 6);
  const refused = await ask();
  assert.equal(refused.status, 404);
  assert.match(((await refused.json()) as Json).error.message, /monthly budget .* used up/);
  assert.equal(((await (await api("GET", "/api/state")).json()) as Json).providers.find((x: Json) => x.id === id).budgetStatus.level, "over");

  const warnOnly = await api("PUT", `/api/providers/${id}/budget`, { monthlyUsd: 5, stop: false });
  assert.equal(warnOnly.status, 200);
  assert.equal((await ask()).status, 200, "a budget that only warns never refuses a request");
  assert.equal(((await (await api("PUT", `/api/providers/${id}/budget`, { monthlyUsd: null })).json()) as Json).budget, null, "the budget can be removed");
});
