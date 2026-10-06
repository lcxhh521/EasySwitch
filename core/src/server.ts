import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, isAbsolute } from "node:path";
import { antigravityAccessToken, AntigravityError, beginAntigravitySignIn, forgetAntigravityAccount, listAntigravityModels, type AntigravityAccount } from "./antigravity.ts";
import { antigravityEndpoints } from "./antigravity-client.ts";
import { beginCursorSignIn, cursorAccessToken, forgetCursorAccount, type CursorAccount } from "./cursor/auth.ts";
import { CursorError } from "./cursor/errors.ts";
import { listCursorModels } from "./cursor/models.ts";
import { CURSOR_API } from "./cursor/transport.ts";
import { listKiroModels } from "./kiro.ts";
import { GUIDE_IDS, setupGuide } from "./setup-guides.ts";
import { KiroError } from "./kiro-login.ts";
import { fileURLToPath } from "node:url";
import { writeCodexCatalog } from "./catalog.ts";
import { handleChatgpt, handleChatgptUpgrade, isChatgptPath } from "./chatgpt-gateway.ts";
import { handleChatCompletions } from "./gateway-chat.ts";
import { GEMINI_PATH, handleGemini, listGeminiModels } from "./gateway-gemini.ts";
import { handleMcp, mcpEndpoint, type McpDeps } from "./mcp.ts";
import { handleResponses, listExposedModels, resolveModel } from "./gateway.ts";
import { handleCountTokens, handleMessages } from "./gateway-messages.ts";
import { augmentedSessions, claudeCapabilities, claudeLoggedIn, findClaude, findCodex, launchInTerminal, sessionDetails } from "./launch.ts";
import { rangeStart, summarize, type Ledger, type UsageRange } from "./ledger.ts";
import { iconForBaseUrl, PRESETS } from "./presets.ts";
import { nameFromUrl, parsePaste } from "./import-parse.ts";
import { importFromOpencodex, opencodexCandidates } from "./opencodex-import.ts";
import { AGENTS, detectAgents, type DetectedAgent } from "./agents.ts";
import { commandLine, effortsOf, hasLauncher, LAUNCHERS, materialize, newSessionDir, runHeadless, type LaunchSpec } from "./agent-launch.ts";
import { catalogModels } from "./catalog.ts";
import { accessToken, apiBase, beginCodexSignIn, beginCopilotSignIn, beginSignIn, codexBase, copilotDefaultBase, copilotHeaders, listCopilotModels, listModels as listPlanModels, signOut, type SiwcAccount } from "./siwc.ts";
import { setAntigravityToken, setCursorToken, setPlanToken, setVertexToken } from "./keypool.ts";
import { isGatewayPath, loadGatewayKey, requestHasValidToken } from "./gateway-auth.ts";
import { addSpend, budgetStatus, loadMonth, monthStart } from "./budget.ts";
import { DEFAULT_VERTEX_MODELS, forgetServiceAccount, mintAccessToken, parseServiceAccount, storeServiceAccount, VertexError, vertexAccessToken, vertexBaseUrl } from "./vertex.ts";
import { nativeModels } from "./claude-native.ts";
import { capabilityMatrix, coverage, FEATURES } from "./capabilities.ts";
import { describeQuota, exhaustedUntil, quotaOf } from "./quota.ts";
import { AUTO_AGENT, describeWhen, matchingRules, parseRule, type TaskFacts } from "./dispatch.ts";
import { isMimoFree } from "./mimo-free.ts";
import { discoverEfforts } from "./efforts.ts";
import { levelsForAgentAndModel, modelEfforts } from "./model-efforts.ts";
import { liveMembers, modelOfBody, poolEfforts, poolOf, runWithPool, withModel } from "./pools.ts";
import { TaskBook, type Task } from "./tasks.ts";
import { sessionToken } from "./gateway-chat.ts";
import { chatgptStatus, gatewayBase, prepareLauncher, restartChatgpt } from "./chatgpt.ts";
import { costOf, ratesFor } from "./pricing/cost.ts";
import { accountCommandLine, clearResting, createAccount, isResting, markResting, pickAccount, touch as touchAccount } from "./accounts.ts";
import { keySecretId, newKeyId, pickKey } from "./keypool.ts";
import { hasPlanUsage, refreshPlanUsage } from "./plan-usage.ts";
import { nativeFiles } from "./native.ts";
import { listModels, probeProvider } from "./probe.ts";
import type { SecretStore } from "./secrets.ts";
import { slugify, type Store } from "./store.ts";
import { expandUrl, UnresolvedPlaceholder } from "./upstream.ts";
import type { Account, DisplaySettings, GatewayLogEntry, Harness, Provider, ProviderRoute } from "./types.ts";

type Json = Record<string, unknown>;

const VERSION = "0.0.1";
const MAX_BODY = 32 * 1024 * 1024;
const WEB_DIR = fileURLToPath(new URL("../../web/", import.meta.url));
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

export interface ServerDeps {
  /** How a sign-in page is shown to the user (default: the system browser). Tests play the browser themselves. */
  openUrl?: (url: string) => Promise<void>;
  store: Store;
  secrets: SecretStore;
  port: number;
  /** Durable usage ledger; tests leave it out and usage comes from memory. */
  ledger?: Ledger;
  /** Only requests that carry a token EasySwitch signed may use the gateway (see gateway-auth.ts). The real service turns it on. */
  gatewayAuth?: boolean;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Stamps an estimated cost on a finished call, using the price in force right now. */
export function priceEntry(store: Store, entry: GatewayLogEntry): void {
  const provider = entry.providerId ? store.provider(entry.providerId) : undefined;
  if (!provider || entry.inputTokens === undefined || entry.outputTokens === undefined) return;
  if (provider.billing === "subscription") {
    entry.costNote = "subscription";
    return;
  }
  const model = entry.model.slice(entry.model.indexOf("/") + 1);
  const priced = ratesFor(provider, model);
  if (!priced) {
    entry.costNote = "unpriced";
    return;
  }
  entry.costUsd = costOf(priced.rates, { input: entry.inputTokens, output: entry.outputTokens, cached: entry.cachedTokens ?? 0 });
}

let agentCache: { at: number; list: DetectedAgent[] } | undefined;

async function runOpen(appPath: string): Promise<void> {
  await promisify(execFile)("open", [appPath]);
}

function publicAccount(a: Account) {
  return { ...a, resting: isResting(a) };
}

function publicProvider(p: Provider, hasKey: boolean, usedBy: Harness[] = []) {
  // Key metadata is public inside the console; the secrets themselves never leave the Keychain.
  const keys = (p.keys ?? []).map(({ id, label, enabled, addedAt, lastUsedAt, restUntil, lastError }) =>
    ({ id, label, enabled, addedAt, ...(lastUsedAt ? { lastUsedAt } : {}), ...(restUntil ? { restUntil } : {}), ...(lastError ? { lastError } : {}) }));
  const sample = p.defaultModel ?? p.models[0];
  const priced = sample ? ratesFor(p, sample) : undefined;
  return {
    ...p, hasKey, ...(keys.length ? { keys } : {}), icon: p.icon ?? iconForBaseUrl(p.baseUrl, p.name), usedBy,
    ...(budgetStatus(p) ? { budgetStatus: budgetStatus(p) } : {}),
    ...(describeQuota(quotaOf(p.id)) ? { quota: { text: describeQuota(quotaOf(p.id))!, ...(exhaustedUntil(p.id) ? { exhaustedUntil: exhaustedUntil(p.id)! } : {}) } } : {}),
    ...(sample ? { priceSample: { model: sample, ...(priced ? { rates: priced.rates, source: priced.source } : {}) } } : {}),
  };
}

export function createEasySwitchServer(deps: ServerDeps): Server {
  const { store, secrets, port, ledger } = deps;
  const log: GatewayLogEntry[] = [];
  /** The log writer for one try: inside a pool it also says which pool and which try this is. */
  const logFor = (ctx?: { pool: string; attempt: number; attempts: number }) => (entry: GatewayLogEntry) =>
    pushLog(ctx ? { ...entry, pool: ctx.pool, attempt: ctx.attempt, attempts: ctx.attempts } : entry);
  // This month's spend is rebuilt from the ledger, so a restart does not forget what the budgets have used.
  if (ledger) loadMonth(ledger.read(monthStart()));
  const pushLog = (entry: GatewayLogEntry) => {
    priceEntry(store, entry);
    if (entry.providerId && entry.costUsd) addSpend(entry.providerId, entry.costUsd, new Date(entry.at));
    log.unshift(entry);
    log.length = Math.min(log.length, 100);
    ledger?.append(entry);
    console.log(`[gateway] ${entry.status} ${entry.route} ${entry.model} ${entry.ms}ms${entry.note ? ` (${entry.note})` : ""}`);
  };
  /** The executable for an agent: the two built-ins have their own finders, the rest come from detection. */
  async function agentBinary(id: string): Promise<string | undefined> {
    if (id === "codex") return findCodex();
    if (id === "claude") return findClaude();
    const found = (agentCache?.list ?? (agentCache = { at: Date.now(), list: await detectAgents() }).list).find(a => a.id === id);
    return found?.installed && found.where && !found.where.endsWith(".app") ? found.where : undefined;
  }

  const tasks = new TaskBook(store.dir);

  /** Whether an agent can take a task right now: installed, and it has a headless form. */
  async function canTake(id: string): Promise<boolean> {
    return Boolean(LAUNCHERS[id]?.headless) && Boolean(await agentBinary(id));
  }

  /**
   * "auto": which agent, model and level the dispatch rules pick for this task. A rule whose agent
   * is not available is skipped for the next matching one; with none left, the first agent that
   * can take a task is used, and the answer says so.
   */
  async function decideAuto(facts: TaskFacts): Promise<{ agent: string; model?: string; effort?: string; why: string }> {
    const skipped: string[] = [];
    for (const rule of matchingRules(store.rules(), facts)) {
      if (await canTake(rule.then.agent)) {
        const name = AGENTS.find(a => a.id === rule.then.agent)?.name ?? rule.then.agent;
        return {
          agent: rule.then.agent, ...(rule.then.model ? { model: rule.then.model } : {}), ...(rule.then.effort ? { effort: rule.then.effort } : {}),
          why: `按规则「${rule.name}」（${describeWhen(rule.when)}）派给 ${name}${skipped.length ? `；${skipped.join("；")}` : ""}`,
        };
      }
      skipped.push(`规则「${rule.name}」要派给 ${rule.then.agent}，但它现在接不了活，已跳过`);
    }
    for (const a of AGENTS) {
      if (await canTake(a.id)) return { agent: a.id, why: `没有规则接这个任务，交给第一个能接活的 ${a.name}${skipped.length ? `；${skipped.join("；")}` : ""}` };
    }
    throw new Error("现在没有任何 agent 能接活：先在 Agent 页确认至少一个已安装");
  }

  /** Hands a task to an agent ("auto": the dispatch rules choose): records it, runs it headlessly in the background, records how it ended. */
  async function startTask(requested: string, input: { task: string; model?: string; cwd?: string; effort?: string; depth: number; from: string }): Promise<{ task: Task; done: Promise<Task> }> {
    let id = requested;
    let why: string | undefined;
    if (requested === AUTO_AGENT) {
      const picked = await decideAuto({ task: input.task, from: input.from, ...(input.cwd ? { cwd: input.cwd } : {}) });
      id = picked.agent;
      why = picked.why;
      // What the caller asked for explicitly wins over what the rule says.
      input = { ...input, ...(input.model ? {} : picked.model ? { model: picked.model } : {}), ...(input.effort ? {} : picked.effort ? { effort: picked.effort } : {}) };
    }
    const bin = await agentBinary(id);
    if (!bin) throw new Error(`没有找到 ${id} 的命令`);
    const b = store.binding(id);
    // A model is never a dead end: the one asked for, else the agent's own, else the first one EasySwitch serves.
    const first = store.catalog()[0];
    const model = input.model ?? (b ? `${b.providerId}/${b.model}` : first ? `${first.providerId}/${first.model}` : "");
    if (!model || !resolveModel(store, model)) throw new Error("还没有可用的模型：先在「模型来源」里添加一个");
    const wanted = input.effort ?? store.prefs(id).effort;
    const effort = wanted && (await levelsFor(id, model)).includes(wanted) ? wanted : undefined;
    const { task, signal } = tasks.start({ agent: id, model, from: input.from, task: input.task, ...(input.cwd ? { cwd: input.cwd } : {}), ...(effort ? { effort } : {}), ...(why ? { why } : {}) });
    const done = runHeadless(id, { bin, port, model, models: modelsFor(model), task: input.task, stateDir: store.dir, tiers: tiersFor(id), claudeCaps: claudeCapabilities(store.catalog()), ...(effort ? { effort } : {}) }, { depth: input.depth, attachMcp: store.settings().agentCalls, signal, ...(input.cwd ? { cwd: input.cwd } : {}) })
      .then(r => tasks.finish(task.id, r)!)
      .catch(error => tasks.finish(task.id, { exitCode: null, output: String((error as Error).message ?? error), timedOut: false })!);
    return { task, done };
  }

  /** The levels the installed program itself reports (asked once, remembered), else the launcher's fallback. */
  async function levelsOf(id: string): Promise<string[] | undefined> {
    await discoverEfforts(id, await agentBinary(id));
    return effortsOf(id);
  }

  /** Every model an agent may be offered in its own menu, the chosen one first. Subscriptions that are switched off are not in the catalog. */
  const modelsFor = (main: string): string[] => [...new Set([main, ...store.catalog().map(m => `${m.providerId}/${m.model}`)])].filter(Boolean).slice(0, 80);
  /** The levels an agent can offer for a model: the agent's own, that the model has too. */
  async function levelsFor(id: string, model?: string): Promise<string[]> {
    const own = await levelsOf(id);
    const pool = model ? poolOf(store, model) : undefined;
    const resolved = model ? resolveModel(store, model) : undefined;
    // A pool can only offer what all its members have.
    const has = pool ? poolEfforts(store, pool) : resolved ? modelEfforts(resolved.provider, resolved.model) : undefined;
    // An agent with no levels of its own offers whatever its model has.
    return own === undefined ? (has ?? []) : levelsForAgentAndModel(own, has);
  }

  /** The agent's saved extra models that still exist, by tier id. */
  function tiersFor(id: string): Record<string, string> {
    const known = new Set((LAUNCHERS[id]?.tiers ?? []).map(t => t.id));
    return Object.fromEntries(Object.entries(store.prefs(id).tiers ?? {}).filter(([tier, name]) => known.has(tier) && resolveModel(store, name)));
  }

  /** The interactive command for an agent on EasySwitch, for one launch: the Terminal button and the `es` command both use it. */
  async function interactiveSpec(id: string, opts: { model?: string; effort?: string }): Promise<{ spec: LaunchSpec; sessionDir: string; model: string; name: string } | { error: string; status: number }> {
    const launcher = LAUNCHERS[id];
    const known = AGENTS.find(a => a.id === id);
    const bin = await agentBinary(id);
    if (!known || !launcher?.interactive) return { status: 409, error: "这个 agent 还没有接入交互启动" };
    if (!bin) return { status: 404, error: "没有检测到这个 agent 的命令" };
    const b = store.binding(id);
    const first = store.catalog()[0];
    // Claude Code keeps the user's own login when it has one: Claude's own models stay in the menu, and with no model chosen it starts on its usual default.
    const keepLogin = id === "claude" && store.settings().claudeNative && await claudeLoggedIn();
    const model = opts.model ?? (b ? `${b.providerId}/${b.model}` : keepLogin ? "" : first ? `${first.providerId}/${first.model}` : "");
    if (keepLogin ? (model !== "" && !resolveModel(store, model)) : (!model || !resolveModel(store, model))) {
      const off = model ? store.provider(model.slice(0, Math.max(0, model.indexOf("/")))) : undefined;
      return { status: 409, error: off?.off ? `「${off.name}」这个订阅现在是关着的：先在「模型来源」里把它打开` : "还没有可用的模型：先在「模型来源」里添加一个" };
    }
    const wanted = opts.effort ?? store.prefs(id).effort;
    const effort = wanted && (await levelsFor(id, model || undefined)).includes(wanted) ? wanted : undefined;
    const tiers = tiersFor(id);
    const sessionDir = newSessionDir();
    const token = sessionToken(id);
    const catalog = id === "codex" ? await writeCodexCatalog(bin, store.dir, store.providers(), { models: store.catalog() }) : undefined;
    const spec = launcher.interactive({ bin, port, model, models: modelsFor(model), token, sessionDir, stateDir: store.dir, tiers, claudeCaps: claudeCapabilities(store.catalog()), ...(keepLogin ? { keepLogin } : {}), ...(catalog ? { catalog } : {}), ...(effort ? { effort } : {}), ...(store.settings().agentCalls ? { mcp: mcpEndpoint(port, token, 0) } : {}) });
    materialize(spec, sessionDir);
    return { spec, sessionDir, model, name: known.name };
  }

  // ---- ChatGPT plan ("Continue with ChatGPT"): accounts, sign-in in progress, the provider each account becomes
  const siwcStore = store.siwcStorage();
  /** What the plan behind this account has said about its quota (see quota.ts), for the subscription card. */
  const planQuota = (accountId: string): { quota?: { text: string; exhaustedUntil?: number } } => {
    const providerIds = store.providers().filter(p => p.plan?.accountId === accountId || p.antigravity?.accountId === accountId || p.cursor?.accountId === accountId || p.id === accountId).map(p => p.id);
    for (const id of providerIds) {
      const text = describeQuota(quotaOf(id));
      if (text) return { quota: { text, ...(exhaustedUntil(id) ? { exhaustedUntil: exhaustedUntil(id)! } : {}) } };
    }
    return {};
  };
  setPlanToken(async provider => {
    try {
      return await accessToken({ storage: siwcStore, secrets }, provider.plan!.accountId);
    } catch (error) {
      // The gateway answers with a plain reason instead of calling OpenAI with nothing.
      throw new Error(String((error as Error).message));
    }
  });
  let planSignIn: { status: "waiting" | "done" | "error"; url: string; userCode?: string; message?: string; cancel: () => void } | undefined;

  /** Makes sure the account has a provider, and brings its models (and each model's own levels) up to date. */
  async function syncPlanProvider(account: SiwcAccount): Promise<Provider> {
    let provider = store.providers().find(p => p.plan?.accountId === account.id);
    const kind = account.kind === "codex" ? "codex" : account.kind === "copilot" ? "copilot" : "chatgpt";
    const token = account.planUsage ? await accessToken({ storage: siwcStore, secrets }, account.id) : "";
    const refreshed = siwcStore.accounts().find(a => a.id === account.id) ?? account;
    const copilotBase = (refreshed.endpoint ?? copilotDefaultBase()).replace(/\/+$/, "");
    const models = !token ? [] : kind === "copilot" ? await listCopilotModels(token, copilotBase) : await listPlanModels(token, kind);
    const name = kind === "copilot" ? `GitHub Copilot · ${account.label}` : `ChatGPT 订阅 · ${account.label}`;
    if (!provider) {
      provider = {
        id: slugify(name, [...store.providers().map(p => p.id), "pool"]), name,
        baseUrl: kind === "codex" ? codexBase() : kind === "copilot" ? copilotBase : apiBase(), models: [],
        // A Copilot account speaks Chat Completions, so it goes through the ordinary translation path with fixed client headers.
        route: kind === "copilot" ? "chat-translate" : "responses-native", routePinned: true,
        streamUsage: kind === "copilot", billing: "subscription", plan: { kind, accountId: account.id },
        ...(kind === "copilot" ? { wire: { headers: copilotHeaders() } } : {}),
        icon: kind === "copilot" ? "github-copilot-color" : "openai", createdAt: new Date().toISOString(),
        // A new subscription starts switched off: the user decides when it is used.
        off: true,
      };
    }
    provider.name = name;
    if (kind === "copilot") provider.baseUrl = copilotBase;
    if (models.length) {
      provider.models = models.map(m => m.slug);
      provider.defaultModel = provider.defaultModel && provider.models.includes(provider.defaultModel) ? provider.defaultModel : provider.models[0];
      provider.modelEfforts = Object.fromEntries(models.filter(m => m.efforts).map(m => [m.slug, m.efforts!]));
    }
    store.upsertProvider(provider);
    return provider;
  }

  // ---- Google Antigravity: the token source the send path asks for, and the provider an account becomes
  setAntigravityToken(async provider => {
    try { return await antigravityAccessToken(secrets, provider.antigravity!.accountId); } catch (error) { throw new Error(String((error as Error).message)); }
  });
  const syncAntigravity = async (account: AntigravityAccount): Promise<Provider> => {
    const token = await antigravityAccessToken(secrets, account.id);
    const models = await listAntigravityModels(token, account.projectId);
    let provider = store.providers().find(p => p.antigravity?.accountId === account.id);
    if (!provider) {
      const name = `Antigravity · ${account.email}`;
      provider = {
        id: slugify(name, [...store.providers().map(p => p.id), "pool"]), name, baseUrl: antigravityEndpoints().api,
        models: [], route: "chat-translate", routePinned: true, streamUsage: false, billing: "subscription",
        // Antigravity takes no Chat-style thinking level from us, so none is sent.
        reasoningEffort: false, antigravity: { accountId: account.id, email: account.email, projectId: account.projectId },
        icon: "antigravity-color", createdAt: new Date().toISOString(),
        // A new subscription starts switched off: the user decides when it is used.
        off: true,
      };
    }
    provider.antigravity = { accountId: account.id, email: account.email, projectId: account.projectId };
    provider.models = models;
    provider.defaultModel = provider.defaultModel && models.includes(provider.defaultModel) ? provider.defaultModel : models[0]!;
    store.upsertProvider(provider);
    return provider;
  };

  // ---- Cursor: the token source the send path asks for, and the provider an account becomes
  const cursorApi = () => process.env.EASYSWITCH_CURSOR_API ?? CURSOR_API;
  // A login that is gone or refused gives no token (the send path then says to sign in again, as a 401 a pool can move on from);
  // any other failure, such as Cursor being unreachable, is left to surface as it is.
  setCursorToken(async provider => {
    try { return await cursorAccessToken(secrets, provider.cursor!.accountId); }
    catch (error) { if (error instanceof CursorError && error.auth) return ""; throw error; }
  });
  const syncCursor = async (account: CursorAccount): Promise<Provider> => {
    const token = await cursorAccessToken(secrets, account.id);
    const models = await listCursorModels(cursorApi(), token);
    let provider = store.providers().find(p => p.cursor?.accountId === account.id);
    if (!provider) {
      const name = `Cursor · ${account.email ?? account.id}`;
      provider = {
        id: slugify(name, [...store.providers().map(p => p.id), "pool"]), name, baseUrl: cursorApi(),
        models: [], route: "chat-translate", routePinned: true, streamUsage: false, billing: "subscription",
        // The thinking level is part of Cursor's model id, not a separate setting.
        reasoningEffort: false, cursor: { accountId: account.id, ...(account.email ? { email: account.email } : {}) },
        icon: "cursor-color", createdAt: new Date().toISOString(),
        // A new subscription starts switched off: the user decides when it is used.
        off: true,
      };
    }
    provider.baseUrl = cursorApi();
    provider.models = models;
    provider.defaultModel = provider.defaultModel && models.includes(provider.defaultModel) ? provider.defaultModel : models[0]!;
    store.upsertProvider(provider);
    return provider;
  };

  // ---- Google Vertex AI: a service account key in the secret store becomes access tokens
  setVertexToken(async provider => {
    try { return await vertexAccessToken(secrets, provider); } catch (error) { throw new Error(String((error as Error).message)); }
  });

  const mcpDeps: McpDeps = {
    store, secrets, log: pushLog,
    async agents() {
      const out: Array<{ id: string; name: string; model?: string }> = [];
      for (const a of AGENTS) {
        if (!LAUNCHERS[a.id]?.headless || !(await agentBinary(a.id))) continue;
        const b = store.binding(a.id);
        out.push({ id: a.id, name: a.name, ...(b ? { model: `${b.providerId}/${b.model}` } : {}) });
      }
      return out;
    },
    async run(id, input) {
      const { done } = await startTask(id, input);
      const t = await done;
      return { exitCode: t.exitCode ?? null, output: t.output ?? "", timedOut: t.status === "timeout", model: t.model, agent: t.agent };
    },
  };
  // A test that asks for port 0 learns the real one only after listen(); both spellings are allowed.
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowBoundPort = (bound: number | undefined): void => {
    if (bound) { allowedHosts.add(`127.0.0.1:${bound}`); allowedHosts.add(`localhost:${bound}`); }
  };

  /** Adds a provider, lists models, then probes with the best model available. */
  async function addAndProbe(input: { name: string; baseUrl: string; apiKey: string; anthropicBaseUrl?: string; afterAdd?: () => string[] | void }): Promise<Provider> {
    const { name, baseUrl, apiKey } = input;
    if (!name || !/^https?:\/\//.test(baseUrl)) throw new Error("需要名称和以 http(s):// 开头的地址");
    const provider: Provider = {
      id: slugify(name, [...store.providers().map(p => p.id), "pool"]),
      name, baseUrl, models: [], route: "chat-translate", routePinned: false, streamUsage: true,
      // The free tier has no key: its JWT is bootstrapped per call (see mimo-free.ts).
      ...(isMimoFree({ baseUrl }) ? { mimoFree: true } : {}),
      ...(input.anthropicBaseUrl ? { anthropicBaseUrl: input.anthropicBaseUrl } : {}),
      createdAt: new Date().toISOString(),
    };
    if (apiKey) await secrets.set(provider.id, apiKey);
    const { models } = provider.mimoFree ? { models: ["mimo-auto"] } : await listModels(provider, apiKey || undefined).catch(() => ({ models: [] as string[] }));
    provider.models = models;
    store.upsertProvider(provider);
    const model = provider.defaultModel ?? provider.models[0] ?? "";
    if (model) {
      try {
        const apiKeyNow = await secrets.get(provider.id);
        const { report, models: probed, streamUsage } = await probeProvider(provider, apiKeyNow, model);
        if (probed.length) provider.models = probed;
        provider.defaultModel = model;
        provider.probe = report;
        provider.streamUsage = streamUsage;
        if (!provider.routePinned) provider.route = report.recommendedRoute;
        if (report.recommendedMessagesRoute) provider.messagesRoute = report.recommendedMessagesRoute;
        store.upsertProvider(provider);
      } catch {
        // Probe failures are surfaced in the UI, not fatal to the import.
      }
    }
    input.afterAdd?.();
    return provider;
  }

  /** Binds harnesses that have no model yet; harnesses already bound are left alone. */
  function attachFreeHarnesses(providerId: string): Harness[] {
    const provider = store.provider(providerId);
    const model = provider?.defaultModel ?? provider?.models[0];
    if (!provider || !model) return [];
    const attached: Harness[] = [];
    for (const harness of ["codex", "claude"] as const) {
      if (store.binding(harness)) continue;
      store.setBinding({ harness, providerId: provider.id, model });
      attached.push(harness);
    }
    return attached;
  }

  /** One human sentence about what the import did. */
  function importSummary(provider: Provider, parsed: { apiKey?: string }): string {
    const attached = (["codex", "claude"] as const).filter(h => store.binding(h)?.providerId === provider.id);
    const models = provider.models.length;
    const parts = [
      `已添加「${provider.name}」${models ? `，读到 ${models} 个模型` : ""}`,
      provider.probe?.checks.every(c => c.status !== "fail")
        ? "一致性测试通过"
        : provider.probe ? "一致性测试有未通过项，详情在来源页" : "",
      parsed.apiKey ? undefined : "没有 Key，测试没跑",
      attached.length
        ? `${attached.map(h => h === "codex" ? "ChatGPT" : "Claude Code").join("和")}的增强会话现在用它`
        : "两个 agent 的绑定都没有动",
    ].filter(Boolean);
    return parts.join("；");
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? "GET";
    // A custom header forces a CORS preflight, which we never answer, so other
    // web pages cannot drive this API even though it listens on loopback.
    if (method !== "GET" && req.headers["x-easyswitch"] !== "1") {
      json(res, 403, { error: "missing x-easyswitch header" });
      return;
    }
    const body = method === "GET" ? {} : ((JSON.parse((await readBody(req)) || "{}")) as Json);

    if (method === "GET" && path === "/api/state") {
      const bound = store.allBindings();
      const providers = await Promise.all(store.providers().map(async p =>
        publicProvider(p, Boolean(await secrets.get(p.id)), bound.filter(b => b.providerId === p.id).map(b => b.harness))));
      json(res, 200, {
        version: VERSION, port, providers,
        binding: store.binding("codex") ?? null,
        bindings: { codex: null, claude: null, ...Object.fromEntries(store.allBindings().map(b => [b.harness, b])) },
        codexPath: (await findCodex()) ?? null,
        claudePath: (await findClaude()) ?? null,
        claudeLogin: store.settings().claudeNative && await claudeLoggedIn(),
        prefs: store.allPrefs(),
        rules: store.rules().map(r => ({ ...r, summary: describeWhen(r.when) })),
        pools: store.pools().map(p => ({ ...p, live: liveMembers(store, p) })),
        profiles: store.profiles().map(p => ({ id: p.id, name: p.name, agents: p.bindings.length })),
        modelEfforts: Object.fromEntries(store.catalog().map(m => [`${m.providerId}/${m.model}`, m.efforts])),
        sessions: await augmentedSessions(),
        sessionDetails: await sessionDetails(),
        accounts: store.accounts().map(publicAccount),
        accountSettings: store.accountSettings(),
        display: store.display(),
        settings: store.settings(),
        native: nativeFiles(),
        log,
      });
      return;
    }

    // --- profiles: every agent's settings, saved under a name -----------------
    if (path === "/api/profiles" && method === "GET") {
      json(res, 200, { profiles: store.profiles().map(p => ({ id: p.id, name: p.name, agents: p.bindings.length, createdAt: p.createdAt })) });
      return;
    }
    if (path === "/api/profiles" && method === "POST") {
      const name = String(body.name ?? "").trim();
      if (!name) { json(res, 400, { error: "给这套设置取个名字" }); return; }
      const p = store.saveProfile(name);
      json(res, 200, { id: p.id, name: p.name });
      return;
    }
    const profileMatch = /^\/api\/profiles\/(f-[a-f0-9]+)(?:\/(apply))?$/.exec(path);
    if (profileMatch) {
      if (method === "POST" && profileMatch[2] === "apply") {
        const p = store.applyProfile(profileMatch[1] ?? "");
        if (!p) { json(res, 404, { error: "没有这套设置" }); return; }
        json(res, 200, { ok: true, name: p.name });
        return;
      }
      if (method === "DELETE" && !profileMatch[2]) { store.removeProfile(profileMatch[1] ?? ""); json(res, 200, { ok: true }); return; }
    }

    // --- model pools ---------------------------------------------------------
    if (path === "/api/pools" && method === "GET") {
      json(res, 200, { pools: store.pools().map(p => ({ ...p, live: liveMembers(store, p), efforts: poolEfforts(store, p) })) });
      return;
    }
    const poolBody = (): { name: string; strategy: "order" | "rotate"; members: string[] } | string => {
      const name = String(body.name ?? "").trim();
      const strategy = body.strategy === "rotate" ? "rotate" : "order";
      const have = new Set(store.catalog().filter(m => m.providerId !== "pool").map(m => `${m.providerId}/${m.model}`));
      const members = [...new Set(((body.members as unknown[]) ?? []).map(String))].filter(m => have.has(m));
      if (!name) return "给这个池取个名字";
      if (members.length < 2) return "一个池至少要有两个来源，才谈得上切换";
      return { name, strategy, members };
    };
    if (path === "/api/pools" && method === "POST") {
      const made = poolBody();
      if (typeof made === "string") { json(res, 400, { error: made }); return; }
      const pool = { id: slugify(made.name, store.pools().map(p => p.id)), ...made, createdAt: new Date().toISOString() };
      store.upsertPool(pool);
      json(res, 200, pool);
      return;
    }
    const poolMatch = /^\/api\/pools\/([a-z0-9-]+)$/.exec(path);
    if (poolMatch) {
      const current = store.pool(poolMatch[1] ?? "");
      if (!current) { json(res, 404, { error: "没有这个模型池" }); return; }
      if (method === "DELETE") { store.removePool(current.id); json(res, 200, { ok: true }); return; }
      if (method === "PUT") {
        const made = poolBody();
        if (typeof made === "string") { json(res, 400, { error: made }); return; }
        const pool = { ...current, ...made };
        store.upsertPool(pool);
        json(res, 200, pool);
        return;
      }
    }

    // --- ChatGPT plan: Continue with ChatGPT --------------------------------
    if (path === "/api/plan" && method === "GET") {
      json(res, 200, {
        accounts: [
          ...siwcStore.accounts().map(a => ({ id: a.id, kind: a.kind ?? "open", label: a.label, email: a.email, planUsage: a.planUsage, needsSignIn: a.needsSignIn === true, on: store.providers().some(p => p.plan?.accountId === a.id && !p.off), ...planQuota(a.id) })),
          // Kiro has no account of ours (its login stays in the Kiro CLI), only a source; it shows in the same list so it gets the same switch.
          ...store.providers().filter(p => p.kiro).map(p => ({ id: p.id, kind: "kiro", label: p.name, planUsage: true, needsSignIn: false, on: !p.off, ...planQuota(p.id) })),
          ...store.providers().filter(p => p.cursor).map(p => ({ id: p.cursor!.accountId, kind: "cursor", label: p.name, ...(p.cursor!.email ? { email: p.cursor!.email } : {}), planUsage: true, needsSignIn: false, on: !p.off, ...planQuota(p.id) })),
          ...store.providers().filter(p => p.antigravity).map(p => ({ id: p.antigravity!.accountId, kind: "antigravity", label: p.name, email: p.antigravity!.email, planUsage: true, needsSignIn: false, on: !p.off, ...planQuota(p.id) })),
        ],
        signIn: planSignIn ? { status: planSignIn.status, url: planSignIn.url, ...(planSignIn.userCode ? { userCode: planSignIn.userCode } : {}), ...(planSignIn.message ? { message: planSignIn.message } : {}) } : null,
      });
      return;
    }
    // The switch on a subscription: on or off, the user decides. Off keeps the login and the settings.
    const planSwitch = /^\/api\/plan\/([A-Za-z0-9_-]+)\/switch$/.exec(path);
    if (planSwitch && method === "PUT") {
      const mine = store.providers().filter(p => p.plan?.accountId === planSwitch[1] || p.antigravity?.accountId === planSwitch[1] || p.cursor?.accountId === planSwitch[1] || (p.kiro && p.id === planSwitch[1]));
      if (!mine.length) { json(res, 404, { error: "没有这个订阅" }); return; }
      if (typeof body.on !== "boolean") { json(res, 400, { error: "需要 on: true 或 false" }); return; }
      for (const p of mine) { if (body.on) delete p.off; else p.off = true; store.upsertProvider(p); }
      agentCache = undefined;
      json(res, 200, { ok: true, on: body.on });
      return;
    }
    // --- Kiro: the user's own Kiro CLI login as a model source. Nothing is copied: only where the login lives is kept.
    if (path === "/api/kiro/import" && method === "POST") {
      const existing = store.providers().find(p => p.kiro);
      const loginPath = typeof body.loginPath === "string" && isAbsolute(body.loginPath) ? body.loginPath : existing?.kiro?.loginPath;
      try {
        const { models, region } = await listKiroModels(loginPath);
        let provider = store.providers().find(p => p.kiro);
        if (!provider) {
          provider = {
            id: slugify("Kiro", [...store.providers().map(p => p.id), "pool"]), name: "Kiro", baseUrl: `https://runtime.${region}.kiro.dev`,
            models: [], route: "chat-translate", routePinned: true, streamUsage: false, billing: "subscription",
            // Kiro takes no thinking level, so none is ever sent.
            reasoningEffort: false, kiro: {}, icon: "kiro-color", createdAt: new Date().toISOString(),
            // A new subscription starts switched off: the user decides when it is used.
            off: true,
          };
        }
        provider.baseUrl = `https://runtime.${region}.kiro.dev`;
        provider.models = models;
        provider.defaultModel = provider.defaultModel && models.includes(provider.defaultModel) ? provider.defaultModel : models[0]!;
        provider.kiro = loginPath ? { loginPath } : {};
        store.upsertProvider(provider);
        json(res, 200, { id: provider.id, models: models.length, on: !provider.off });
      } catch (error) {
        const e = error as KiroError;
        json(res, e.status === 401 ? 409 : e.status || 502, { error: e.message });
      }
      return;
    }
    // --- Google Antigravity: a Google sign-in in the browser. The refresh token goes to the Keychain; the account becomes a source that starts off.
    // --- Google Vertex AI: project, location and a service account key. The key goes to the secret store; the first token is minted now to prove it works.
    if (path === "/api/vertex" && method === "POST") {
      try {
        const project = String(body.project ?? "").trim();
        const location = String(body.location ?? "global").trim() || "global";
        if (!/^[a-z][a-z0-9-]{4,29}$/.test(project)) throw new VertexError("项目 ID 不对：小写字母、数字和短横线，以字母开头（在 Google Cloud 控制台里能看到）。");
        if (!/^(global|[a-z]+-[a-z]+[0-9]+)$/.test(location)) throw new VertexError("区域不对，比如 global 或 us-central1。");
        const sa = parseServiceAccount(body.serviceAccount as string | object);
        const name = String(body.name ?? "").trim() || `Google Vertex · ${project}`;
        const id = slugify(name, [...store.providers().map(p => p.id), "pool"]);
        await mintAccessToken(id, sa);
        const models = Array.isArray(body.models) && body.models.length ? (body.models as unknown[]).map(String).filter(Boolean) : DEFAULT_VERTEX_MODELS;
        await storeServiceAccount(secrets, id, sa);
        const provider: Provider = {
          id, name, baseUrl: vertexBaseUrl(project, location), models, defaultModel: models[0]!, route: "chat-translate", routePinned: true,
          streamUsage: true, vertex: { project, location, clientEmail: sa.client_email }, icon: "gemini-color", createdAt: new Date().toISOString(),
        };
        store.upsertProvider(provider);
        json(res, 200, { id, models: models.length });
      } catch (error) {
        const e = error as VertexError;
        json(res, e.status === 401 ? 409 : e.status || 400, { error: e.message });
      }
      return;
    }
    if (path === "/api/antigravity/signin" && method === "POST") {
      planSignIn?.cancel();
      try {
        const si = await beginAntigravitySignIn({ secrets, ...(deps.openUrl ? { open: deps.openUrl } : {}) });
        const current: NonNullable<typeof planSignIn> = { status: "waiting", url: si.url, cancel: si.cancel };
        planSignIn = current;
        si.done.then(async account => {
          try { await syncAntigravity(account); current.status = "done"; }
          catch (error) { current.status = "error"; current.message = `登录成功，但读取模型失败：${String((error as Error).message)}`; }
        }).catch(error => { current.status = "error"; current.message = String((error as Error).message); });
        json(res, 200, { url: si.url });
      } catch (error) {
        json(res, 409, { error: String((error as Error).message) });
      }
      return;
    }
    if (path === "/api/cursor/signin" && method === "POST") {
      planSignIn?.cancel();
      try {
        const si = await beginCursorSignIn({ secrets, ...(deps.openUrl ? { open: deps.openUrl } : {}), ...(process.env.EASYSWITCH_CURSOR_POLL_MS ? { pollMs: Number(process.env.EASYSWITCH_CURSOR_POLL_MS) } : {}) });
        const current: NonNullable<typeof planSignIn> = { status: "waiting", url: si.url, cancel: si.cancel };
        planSignIn = current;
        si.done.then(async account => {
          try { await syncCursor(account); current.status = "done"; }
          catch (error) { current.status = "error"; current.message = `登录成功，但读取模型失败：${String((error as Error).message)}`; }
        }).catch(error => { current.status = "error"; current.message = String((error as Error).message); });
        json(res, 200, { url: si.url });
      } catch (error) {
        json(res, 409, { error: String((error as Error).message) });
      }
      return;
    }
    const cursorMatch = /^\/api\/cursor\/([a-z0-9-]+)(?:\/(refresh))?$/.exec(path);
    if (cursorMatch) {
      const providers = store.providers().filter(p => p.cursor?.accountId === cursorMatch[1]);
      if (!providers.length) { json(res, 404, { error: "没有这个 Cursor 账号" }); return; }
      if (cursorMatch[2] === "refresh" && method === "POST") {
        const known = providers[0]!.cursor!;
        try { json(res, 200, { models: (await syncCursor({ id: known.accountId, ...(known.email ? { email: known.email } : {}) })).models }); }
        catch (error) { const e = error as CursorError; json(res, e.status === 401 ? 409 : e.status || 502, { error: e.message }); }
        return;
      }
      if (!cursorMatch[2] && method === "DELETE") {
        for (const p of providers) store.removeProvider(p.id);
        await forgetCursorAccount(secrets, cursorMatch[1]!);
        json(res, 200, { ok: true });
        return;
      }
    }
    const agMatch = /^\/api\/antigravity\/([a-z0-9-]+)(?:\/(refresh))?$/.exec(path);
    if (agMatch) {
      const providers = store.providers().filter(p => p.antigravity?.accountId === agMatch[1]);
      if (!providers.length) { json(res, 404, { error: "没有这个 Antigravity 账号" }); return; }
      if (agMatch[2] === "refresh" && method === "POST") {
        const known = providers[0]!.antigravity!;
        try { json(res, 200, { models: (await syncAntigravity({ id: known.accountId, email: known.email, projectId: known.projectId })).models }); }
        catch (error) { const e = error as AntigravityError; json(res, e.status === 401 ? 409 : e.status || 502, { error: e.message }); }
        return;
      }
      if (!agMatch[2] && method === "DELETE") {
        for (const p of providers) store.removeProvider(p.id);
        await forgetAntigravityAccount(secrets, agMatch[1]!);
        json(res, 200, { ok: true });
        return;
      }
    }
    const kiroRemove = /^\/api\/kiro\/([A-Za-z0-9_-]+)$/.exec(path);
    if (kiroRemove && method === "DELETE") {
      const provider = store.provider(kiroRemove[1]!);
      if (!provider?.kiro) { json(res, 404, { error: "没有这个 Kiro 来源" }); return; }
      // Only the source is removed; the Kiro CLI's own login is not ours to touch.
      store.removeProvider(provider.id);
      json(res, 200, { ok: true });
      return;
    }
    if (path === "/api/plan/signin" && method === "POST") {
      planSignIn?.cancel();
      if (body.cancelOnly === true) { planSignIn = undefined; json(res, 200, { ok: true }); return; }
      try {
        const signInDeps = { storage: siwcStore, secrets, ...(deps.openUrl ? { open: deps.openUrl } : {}) };
        const label = typeof body.label === "string" && body.label.trim() ? { label: body.label } : {};
        // The default is the Codex client's device-code sign-in: one step, nothing to register. OpenAI's
        // own registered-client route stays available (mode "open") but is not offered in the console.
        const si = body.mode === "open"
          ? await beginSignIn(signInDeps, { ...label, ...(typeof body.accountId === "string" && body.accountId ? { existingId: body.accountId } : {}) })
          : body.mode === "copilot" ? await beginCopilotSignIn(signInDeps, label)
          : await beginCodexSignIn(signInDeps, label);
        const current: NonNullable<typeof planSignIn> = { status: "waiting", url: si.url, ...(si.userCode ? { userCode: si.userCode } : {}), cancel: si.cancel };
        planSignIn = current;
        si.done.then(async account => {
          try {
            await syncPlanProvider(account);
            current.status = "done";
            if (!account.planUsage) current.message = "已登录，但你没有允许使用 ChatGPT 订阅额度；重新授权时请勾选允许。";
          } catch (error) {
            current.status = "error";
            current.message = `登录成功，但读取模型失败：${String((error as Error).message)}`;
          }
        }).catch(error => {
          current.status = "error";
          current.message = String((error as Error).message);
        });
        json(res, 200, { url: si.url, ...(si.userCode ? { userCode: si.userCode } : {}) });
      } catch (error) {
        json(res, 409, { error: String((error as Error).message) });
      }
      return;
    }
    const planMatch = /^\/api\/plan\/([a-z0-9-]+)(?:\/(models))?$/.exec(path);
    if (planMatch) {
      const account = siwcStore.accounts().find(a => a.id === planMatch[1]);
      if (!account) { json(res, 404, { error: "没有这个账号" }); return; }
      if (planMatch[2] === "models" && method === "POST") {
        try {
          const provider = await syncPlanProvider(account);
          json(res, 200, { models: provider.models });
        } catch (error) {
          json(res, 409, { error: String((error as Error).message) });
        }
        return;
      }
      if (method === "DELETE" && !planMatch[2]) {
        const { revoked } = await signOut({ storage: siwcStore, secrets }, account.id);
        for (const p of store.providers().filter(x => x.plan?.accountId === account.id)) store.removeProvider(p.id);
        json(res, 200, { ok: true, revoked });
        return;
      }
    }

    // --- dispatch rules: who gets a task ---------------------------------------
    if (path === "/api/rules" && method === "GET") {
      json(res, 200, { rules: store.rules().map(r => ({ ...r, summary: describeWhen(r.when) })) });
      return;
    }
    const knownAgents = { agents: AGENTS.filter(a => LAUNCHERS[a.id]?.headless).map(a => a.id) };
    if (path === "/api/rules" && method === "POST") {
      const parsed = parseRule(body, knownAgents);
      if ("error" in parsed) { json(res, 400, { error: parsed.error }); return; }
      json(res, 201, store.addRule(parsed.rule));
      return;
    }
    if (path === "/api/rules/test" && method === "POST") {
      // A dry run for the console: which rule would catch this task, and who would get it.
      const facts: TaskFacts = { task: String(body.task ?? ""), from: String(body.from ?? "console"), ...(typeof body.cwd === "string" && body.cwd ? { cwd: body.cwd } : {}) };
      try {
        const picked = await decideAuto(facts);
        json(res, 200, picked);
      } catch (error) {
        json(res, 409, { error: String((error as Error).message ?? error) });
      }
      return;
    }
    const ruleMatch = /^\/api\/rules\/(r-[a-f0-9]+)(?:\/(move))?$/.exec(path);
    if (ruleMatch) {
      const id = ruleMatch[1] ?? "";
      if (!store.rules().some(r => r.id === id)) { json(res, 404, { error: "没有这条规则" }); return; }
      if (method === "POST" && ruleMatch[2] === "move") {
        json(res, 200, { ok: store.moveRule(id, body.direction === "up" ? -1 : 1) });
        return;
      }
      if (method === "PUT") {
        const parsed = parseRule(body, knownAgents);
        if ("error" in parsed) { json(res, 400, { error: parsed.error }); return; }
        json(res, 200, store.updateRule(id, parsed.rule));
        return;
      }
      if (method === "DELETE") { store.removeRule(id); json(res, 200, { ok: true }); return; }
    }

    // --- tasks: hand work to an agent, watch it, read what came back ---------
    if (path === "/api/tasks" && method === "GET") {
      json(res, 200, { tasks: tasks.list(), running: tasks.running() });
      return;
    }
    if (path === "/api/tasks" && method === "DELETE") {
      json(res, 200, { cleared: tasks.clearFinished() });
      return;
    }
    if (path === "/api/tasks" && method === "POST") {
      const agent = String(body.agent ?? "");
      const text = String(body.task ?? "").trim();
      if (!agent || !text) { json(res, 400, { error: "需要选一个 agent，并写清楚任务" }); return; }
      if (agent !== AUTO_AGENT && !LAUNCHERS[agent]?.headless) { json(res, 409, { error: "这个 agent 还没有无界面的调用方式" }); return; }
      try {
        const { task } = await startTask(agent, {
          task: text, from: "console", depth: 1,
          ...(typeof body.model === "string" && body.model ? { model: body.model } : {}),
          ...(typeof body.effort === "string" && body.effort ? { effort: body.effort } : {}),
          ...(typeof body.cwd === "string" && body.cwd.startsWith("/") ? { cwd: body.cwd } : {}),
        });
        json(res, 202, { task });
      } catch (error) {
        json(res, 409, { error: String((error as Error).message ?? error) });
      }
      return;
    }
    const taskStop = /^\/api\/tasks\/(t-[a-z0-9]+)\/stop$/.exec(path);
    if (taskStop && method === "POST") {
      json(res, tasks.stop(taskStop[1] ?? "") ? 200 : 404, { ok: tasks.get(taskStop[1] ?? "")?.status === "running" });
      return;
    }

    // --- ChatGPT desktop app: start it on this gateway, or plainly ------------
    if (path === "/api/chatgpt" && method === "GET") {
      json(res, 200, { ...(await chatgptStatus(port)), gateway: gatewayBase(port) });
      return;
    }
    if ((path === "/api/chatgpt/enhance" || path === "/api/chatgpt/native") && method === "POST") {
      const status = await chatgptStatus(port);
      if (!status.installed) {
        json(res, 404, { error: "没有找到 ChatGPT 桌面端" });
        return;
      }
      // Restarting closes the user's running app, so it only happens when the console asked for it explicitly.
      if (status.running && body.restart !== true) {
        json(res, 409, { error: "ChatGPT 正在运行，需要重启才能切换", needsRestart: true });
        return;
      }
      let launcher: string | undefined;
      if (path === "/api/chatgpt/enhance") {
        if (!store.providers().length) {
          json(res, 409, { error: "还没有模型来源，先添加一个再增强" });
          return;
        }
        launcher = (await prepareLauncher(store.dir, port, store.providers()))?.launcher;
        if (!launcher) {
          json(res, 500, { error: "生成启动器失败：找不到 ChatGPT 自带的 Codex 程序" });
          return;
        }
      }
      const result = await restartChatgpt(launcher);
      json(res, result.ok ? 200 : 500, result.ok ? { ok: true, enhanced: Boolean(launcher), staticCatalog: status.staticCatalog } : { error: result.error });
      return;
    }

    if (path === "/api/settings") {
      if (method === "GET") { json(res, 200, store.settings()); return; }
      if (method === "PUT") {
        json(res, 200, store.setSettings({
          ...(typeof body.agentCalls === "boolean" ? { agentCalls: body.agentCalls } : {}),
          ...(typeof body.claudeNative === "boolean" ? { claudeNative: body.claudeNative } : {}),
        }));
        return;
      }
    }

    // --- billing: display currency, per-provider billing mode and prices ----
    if (path === "/api/display") {
      if (method === "GET") { json(res, 200, store.display()); return; }
      if (method === "PUT") {
        const patch: Partial<DisplaySettings> = {};
        if (body.currency === "USD" || body.currency === "CNY") patch.currency = body.currency;
        if (typeof body.usdToCny === "number" && body.usdToCny > 0 && body.usdToCny < 1000) patch.usdToCny = body.usdToCny;
        json(res, 200, store.setDisplay(patch));
        return;
      }
    }
    const billingMatch = /^\/api\/providers\/([a-z0-9-]+)\/(billing|prices)$/.exec(path);
    if (billingMatch && method === "PUT") {
      const provider = store.provider(billingMatch[1] ?? "");
      if (!provider) { json(res, 404, { error: "没有这个模型来源" }); return; }
      if (billingMatch[2] === "billing") {
        if (body.billing !== "usage" && body.billing !== "subscription") { json(res, 400, { error: "billing 需要是 usage 或 subscription" }); return; }
        provider.billing = body.billing;
      } else {
        const model = String(body.model ?? "").trim();
        if (!model) { json(res, 400, { error: "需要模型名" }); return; }
        const prices = { ...(provider.prices ?? {}) };
        const r = body.rates as Record<string, unknown> | null | undefined;
        if (r === null) delete prices[model];
        else {
          const num = (v: unknown) => (typeof v === "number" && v >= 0 && v <= 1_000_000 ? v : 0);
          prices[model] = { input: num(r?.input), output: num(r?.output), cacheRead: num(r?.cacheRead), cacheWrite: num(r?.cacheWrite) };
        }
        if (Object.keys(prices).length) provider.prices = prices; else delete provider.prices;
      }
      store.upsertProvider(provider);
      json(res, 200, publicProvider(provider, Boolean(await secrets.get(provider.id))));
      return;
    }

    // --- every agent we know of, with what is installed on this Mac ---------
    if (path === "/api/agents" && method === "GET") {
      if (!agentCache || Date.now() - agentCache.at > 30_000) agentCache = { at: Date.now(), list: await detectAgents() };
      await Promise.all(agentCache.list.filter(a => a.installed && LAUNCHERS[a.id]).map(a => levelsOf(a.id)));
      const matrix = capabilityMatrix(agentCache.list);
      json(res, 200, { agents: agentCache.list.map(a => ({ ...a, can: hasLauncher(a.id) ?? null, caps: matrix[a.id], ...((GUIDE_IDS as readonly string[]).includes(a.id) ? { guide: true } : {}) })), coverage: coverage(matrix), features: FEATURES });
      return;
    }
    // The manual-setup helper: what to type into an app that has no per-launch override. Nothing is written for the person.
    const guideMatch = /^\/api\/agents\/([a-z0-9-]+)\/setup$/.exec(path);
    if (guideMatch && method === "GET") {
      const binding = store.binding(guideMatch[1]!);
      const first = store.catalog()[0];
      const main = binding ? `${binding.providerId}/${binding.model}` : first ? `${first.providerId}/${first.model}` : "";
      const guide = setupGuide(guideMatch[1]!, { port, models: modelsFor(main) });
      if (!guide) { json(res, 404, { error: "这个应用没有配置向导" }); return; }
      json(res, 200, guide);
      return;
    }
    const agentAction = /^\/api\/agents\/([a-z0-9-]+)\/(launch|command)$/.exec(path);
    if (agentAction && method === "POST") {
      const id = agentAction[1] ?? "";
      const q = new URL(req.url ?? "", "http://x").searchParams;
      const made = await interactiveSpec(id, {
        ...(typeof body.model === "string" && body.model ? { model: body.model } : q.get("model") ? { model: q.get("model")! } : {}),
        ...(typeof body.effort === "string" && body.effort ? { effort: body.effort } : q.get("effort") ? { effort: q.get("effort")! } : {}),
      });
      if ("error" in made) { json(res, made.status, { error: made.error }); return; }
      if (agentAction[2] === "command") {
        // For the `es` command: the caller runs this in its own terminal and removes sessionDir afterwards.
        json(res, 200, { command: made.spec.command, args: made.spec.args, env: made.spec.env, unset: made.spec.unset ?? [], sessionDir: made.sessionDir, model: made.model, name: made.name });
        return;
      }
      const launcher = LAUNCHERS[id]!;
      await launchInTerminal(commandLine(made.spec), `${made.name} · ${made.model}（只在这个窗口生效，关掉窗口即回到原样${launcher.verified ? "" : "；这个启动方式还没在真实程序上实测"}）`);
      json(res, 200, { ok: true, model: made.model, verified: launcher.verified });
      return;
    }
    const agentOpen = /^\/api\/agents\/([a-z0-9-]+)\/open$/.exec(path);
    if (agentOpen && method === "POST") {
      const found = (agentCache?.list ?? await detectAgents()).find(a => a.id === agentOpen[1]);
      if (!found?.installed || !found.where) {
        json(res, 404, { error: "没有检测到这个 agent" });
        return;
      }
      // An app bundle opens as itself; a command opens in a Terminal window. Nothing is configured.
      if (found.where.endsWith(".app")) await runOpen(found.where);
      else await launchInTerminal(`'${found.where.replace(/'/g, `'\\''`)}'`, `${found.name}（EasySwitch 只负责打开，没有改动它的任何配置）`);
      json(res, 200, { ok: true });
      return;
    }

    // --- subscription accounts: isolated homes, manual or automatic choice --
    if (path === "/api/accounts" && method === "GET") {
      json(res, 200, { accounts: store.accounts().map(publicAccount), settings: store.accountSettings() });
      return;
    }
    if (path === "/api/accounts/settings" && method === "PUT") {
      const settings = store.setAccountSettings({
        ...(typeof body.autoPick === "boolean" ? { autoPick: body.autoPick } : {}),
        ...(typeof body.defaultRestHours === "number" && body.defaultRestHours > 0 ? { defaultRestHours: Math.min(body.defaultRestHours, 168) } : {}),
      });
      json(res, 200, settings);
      return;
    }
    if (path === "/api/accounts" && method === "POST") {
      const harness = body.harness === "claude" ? "claude" : body.harness === "codex" ? "codex" : undefined;
      if (!harness) {
        json(res, 400, { error: "harness 需要是 codex 或 claude" });
        return;
      }
      json(res, 201, publicAccount(createAccount(store, harness, String(body.label ?? ""))));
      return;
    }
    if (path === "/api/accounts/launch" && method === "POST") {
      const harness = body.harness === "claude" ? "claude" : "codex";
      const label = harness === "codex" ? "ChatGPT" : "Claude Code";
      let account = typeof body.accountId === "string" ? store.account(body.accountId) : undefined;
      let note: string | undefined;
      if (!account) {
        const picked = pickAccount(store, harness);
        if (!picked.ok) {
          json(res, 409, { error: picked.reason });
          return;
        }
        account = picked.account;
        note = picked.note;
      }
      const binary = harness === "codex" ? await findCodex() : await findClaude();
      if (!binary) {
        json(res, 409, { error: `找不到 ${label} 的命令` });
        return;
      }
      const command = accountCommandLine(binary, account);
      await launchInTerminal(command, `${label} · 账号「${account.label}」（独立的登录目录；第一次用需要在这里登录一次；关掉窗口即结束）`);
      touchAccount(store, account.id);
      json(res, 200, { account: publicAccount(account), ...(note ? { note } : {}) });
      return;
    }
    const accountMatch = /^\/api\/accounts\/(a-[a-z0-9]+)$/.exec(path);
    if (accountMatch) {
      const account = store.account(accountMatch[1] ?? "");
      if (!account) {
        json(res, 404, { error: "没有这个账号" });
        return;
      }
      if (method === "PATCH") {
        if (typeof body.label === "string" && body.label.trim()) account.label = body.label.trim();
        if (typeof body.enabled === "boolean") account.enabled = body.enabled;
        store.upsertAccount(account);
        if (body.rest === true) markResting(store, account.id, typeof body.restHours === "number" ? new Date(Date.now() + body.restHours * 3_600_000) : undefined);
        if (body.rest === false) clearResting(store, account.id);
        json(res, 200, publicAccount(store.account(account.id)!));
        return;
      }
      if (method === "DELETE") {
        // Only the record goes; the directory (login and history) stays on disk so nothing is lost by accident.
        store.removeAccount(account.id);
        json(res, 200, { ok: true, keptDirectory: account.home });
        return;
      }
    }

    // --- one-paste onboarding: parse whatever the vendor handed over, add,
    // probe, and attach to any harness that is still on native -------------
    if (method === "POST" && path === "/api/import") {
      const text = String(body.text ?? "");
      const parsed = parsePaste(text);
      if (!parsed.baseUrl) {
        json(res, 422, { error: parsed.found.length
          ? `只认出了${parsed.found.join("和")}，还不够添加来源`
          : "没有认出地址或 Key；把中转站给你的使用说明整段粘贴进来", ...(parsed.keyUrl ? { keyUrl: parsed.keyUrl } : {}) });
        return;
      }
      const name = String(body.name ?? "").trim() || nameFromUrl(parsed.baseUrl);
      let provider: Provider;
      try {
        provider = await addAndProbe({ name, baseUrl: parsed.baseUrl.replace(/\/+$/, ""), apiKey: parsed.apiKey ?? "" });
      } catch (error) {
        json(res, 502, { error: String((error as Error).message ?? error) });
        return;
      }
      const attached = attachFreeHarnesses(provider.id);
      json(res, 201, { provider: publicProvider(provider, Boolean(parsed.apiKey)), attached, summary: importSummary(provider, parsed) });
      return;
    }

    // --- import from an existing opencodex config --------------------------
    if (path === "/api/import/opencodex") {
      const configPath = typeof body.configPath === "string" && body.configPath.trim() ? body.configPath.trim() : undefined;
      if (method === "GET") {
        json(res, 200, { candidates: opencodexCandidates(configPath).map(c => ({ ...c, icon: iconForBaseUrl(c.baseUrl, c.name) })) });
        return;
      }
      if (method === "POST") {
        const chosen = Array.isArray(body.chosen) ? body.chosen.filter((c: unknown) => typeof c === "string") : [];
        if (!chosen.length) {
          json(res, 400, { error: "没有选择要导入的来源" });
          return;
        }
        const result = await importFromOpencodex(chosen, configPath, store, secrets, async (provider, apiKey) => {
          const { models } = await listModels(provider, apiKey);
          return { models };
        });
        json(res, 200, result);
        return;
      }
    }

    if (method === "POST" && path === "/api/providers") {
      const name = String(body.name ?? "").trim();
      const baseUrl = String(body.baseUrl ?? "").trim().replace(/\/+$/, "");
      const apiKey = String(body.apiKey ?? "").trim();
      const anthropicBaseUrl = String(body.anthropicBaseUrl ?? "").trim().replace(/\/+$/, "");
      if (!name || !/^https?:\/\//.test(baseUrl) || (anthropicBaseUrl && !/^https?:\/\//.test(anthropicBaseUrl))) {
        json(res, 400, { error: "需要名称和以 http(s):// 开头的地址" });
        return;
      }
      // Wire differences (auth header, extra headers, paths) come from the preset, never from the page.
      const preset = PRESETS.find(x => x.id === body.presetId);
      const urlParams: Record<string, string> = {};
      for (const { key } of preset?.urlParams ?? []) {
        const value = String((body.urlParams as Record<string, unknown> | undefined)?.[key] ?? "").trim();
        if (value) urlParams[key] = value;
      }
      const provider: Provider = {
        id: slugify(name, [...store.providers().map(p => p.id), "pool"]),
        name, baseUrl, models: preset?.models ? [...preset.models] : [], route: "chat-translate", routePinned: false, streamUsage: true,
        // The free tier has no key: its JWT is bootstrapped per call (see mimo-free.ts).
        ...(isMimoFree({ baseUrl }) ? { mimoFree: true } : {}),
        ...(anthropicBaseUrl ? { anthropicBaseUrl } : {}),
        ...(Object.keys(urlParams).length ? { urlParams } : {}),
        ...(preset?.wire ? { wire: preset.wire } : {}),
        ...(preset && preset.id !== "relay" ? { icon: preset.icon } : {}),
        // Coding plans are flat monthly subscriptions: per-call cost would be fiction.
        ...(preset?.category === "编程套餐" ? { billing: "subscription" as const } : {}),
        createdAt: new Date().toISOString(),
      };
      try {
        expandUrl(provider.baseUrl, provider.urlParams);
      } catch (error) {
        if (error instanceof UnresolvedPlaceholder) {
          json(res, 400, { error: error.message });
          return;
        }
        throw error;
      }
      if (apiKey) await secrets.set(provider.id, apiKey);
      const { models } = await listModels(provider, apiKey || undefined);
      provider.models = models;
      store.upsertProvider(provider);
      json(res, 201, publicProvider(provider, Boolean(apiKey)));
      return;
    }

    // --- key pool ---------------------------------------------------------
    const keyMatch = /^\/api\/providers\/([a-z0-9-]+)\/keys(?:\/([a-z0-9-]+))?$/.exec(path);
    if (keyMatch) {
      const provider = store.provider(keyMatch[1] ?? "");
      if (!provider) {
        json(res, 404, { error: "没有这个模型来源" });
        return;
      }
      const keyId = keyMatch[2];
      if (method === "POST" && !keyId) {
        const label = String(body.label ?? "").trim();
        const apiKey = String(body.apiKey ?? "").trim();
        if (!apiKey) {
          json(res, 400, { error: "Key 不能为空" });
          return;
        }
        const key = { id: newKeyId(), label: label || `Key ${(provider.keys?.length ?? 0) + 1}`, enabled: true, addedAt: new Date().toISOString() };
        await secrets.set(keySecretId(provider.id, key.id), apiKey);
        provider.keys = [...(provider.keys ?? []), key];
        store.upsertProvider(provider);
        json(res, 201, publicProvider(provider, true));
        return;
      }
      if (keyId) {
        const key = provider.keys?.find(k => k.id === keyId);
        if (!key) {
          json(res, 404, { error: "没有这把 Key" });
          return;
        }
        if (method === "PATCH") {
          if (typeof body.label === "string" && body.label.trim()) key.label = body.label.trim();
          if (typeof body.enabled === "boolean") key.enabled = body.enabled;
          store.upsertProvider(provider);
        } else if (method === "DELETE") {
          provider.keys = provider.keys?.filter(k => k.id !== keyId);
          await secrets.delete(keySecretId(provider.id, key.id));
          store.upsertProvider(provider);
        } else {
          json(res, 405, { error: "不支持的操作" });
          return;
        }
        json(res, 200, publicProvider(provider, true));
        return;
      }
    }

    const levelsMatch = /^\/api\/providers\/([a-z0-9-]+)\/model-efforts$/.exec(path);
    if (levelsMatch && method === "PUT") {
      // The user's word on which thinking levels a model has (a relay that takes more than EasySwitch knows).
      const provider = store.provider(levelsMatch[1] ?? "");
      const model = String(body.model ?? "");
      if (!provider || !model) { json(res, 404, { error: "没有这个来源或模型" }); return; }
      const levels = Array.isArray(body.levels) ? (body.levels as unknown[]).map(String).filter(l => /^[a-z][a-z0-9-]*$/.test(l)) : [];
      const modelEffortsSet = { ...(provider.modelEfforts ?? {}) };
      if (Array.isArray(body.levels)) modelEffortsSet[model] = levels; else delete modelEffortsSet[model];
      if (Object.keys(modelEffortsSet).length) provider.modelEfforts = modelEffortsSet; else delete provider.modelEfforts;
      store.upsertProvider(provider);
      json(res, 200, { model, levels: modelEfforts(provider, model) });
      return;
    }
    const budgetMatch = /^\/api\/providers\/([a-z0-9-]+)\/budget$/.exec(path);
    if (budgetMatch && method === "PUT") {
      // A monthly budget for one source: how much it may cost this month, and whether it stops when that is gone.
      const provider = store.provider(budgetMatch[1] ?? "");
      if (!provider) { json(res, 404, { error: "没有这个模型来源" }); return; }
      if (body.monthlyUsd === null || body.monthlyUsd === undefined || body.monthlyUsd === "") delete provider.budget;
      else {
        const usd = Number(body.monthlyUsd);
        if (!(usd > 0) || usd > 1_000_000) { json(res, 400, { error: "预算要是一个大于 0 的数（美元）" }); return; }
        provider.budget = { monthlyUsd: usd, ...(body.stop === true ? { stop: true } : {}) };
      }
      store.upsertProvider(provider);
      json(res, 200, { budget: provider.budget ?? null, status: budgetStatus(provider) ?? null });
      return;
    }
    const usageMatch = /^\/api\/providers\/([a-z0-9-]+)\/usage$/.exec(path);
    if (usageMatch && method === "POST") {
      // Asks the vendor how much of a coding plan used with a key is left (Kimi, MiniMax).
      const provider = store.provider(usageMatch[1] ?? "");
      if (!provider) { json(res, 404, { error: "没有这个模型来源" }); return; }
      if (!hasPlanUsage(provider)) { json(res, 404, { error: "这个来源的厂商没有公开查额度的办法" }); return; }
      const windows = await refreshPlanUsage(provider, (await pickKey(secrets, provider)).apiKey);
      if (!windows) { json(res, 502, { error: "没能读到额度（厂商没有回答，或返回的格式不认识）" }); return; }
      json(res, 200, { quota: { text: describeQuota(quotaOf(provider.id)) ?? "", ...(exhaustedUntil(provider.id) ? { exhaustedUntil: exhaustedUntil(provider.id)! } : {}) } });
      return;
    }
    const providerMatch = /^\/api\/providers\/([a-z0-9-]+)(?:\/(probe|route))?$/.exec(path);
    if (providerMatch) {
      const provider = store.provider(providerMatch[1] ?? "");
      if (!provider) {
        json(res, 404, { error: "没有这个模型来源" });
        return;
      }
      const action = providerMatch[2];
      if (method === "DELETE" && !action) {
        for (const key of provider.keys ?? []) await secrets.delete(keySecretId(provider.id, key.id));
        if (provider.vertex) await forgetServiceAccount(secrets, provider.id);
        store.removeProvider(provider.id);
        await secrets.delete(provider.id);
        json(res, 200, { ok: true });
        return;
      }
      if (method === "POST" && action === "probe") {
        const model = String(body.model ?? provider.defaultModel ?? provider.models[0] ?? "");
        if (!model) {
          json(res, 400, { error: "先选一个模型再测试" });
          return;
        }
        const apiKey = await secrets.get(provider.id);
        const { report, models, streamUsage } = await probeProvider(provider, apiKey, model);
        if (models.length) provider.models = models;
        provider.defaultModel = model;
        provider.probe = report;
        provider.streamUsage = streamUsage;
        if (!provider.routePinned) provider.route = report.recommendedRoute;
        if (report.recommendedMessagesRoute) provider.messagesRoute = report.recommendedMessagesRoute;
        store.upsertProvider(provider);
        json(res, 200, publicProvider(provider, Boolean(apiKey)));
        return;
      }
      if (method === "POST" && action === "route") {
        const route = body.route as ProviderRoute | null;
        if (route === null) {
          provider.routePinned = false;
          provider.route = provider.probe?.recommendedRoute ?? provider.route;
        } else if (route === "responses-native" || route === "chat-translate") {
          provider.routePinned = true;
          provider.route = route;
        } else {
          json(res, 400, { error: "未知的线路" });
          return;
        }
        store.upsertProvider(provider);
        json(res, 200, publicProvider(provider, Boolean(await secrets.get(provider.id))));
        return;
      }
    }

    if (method === "GET" && path === "/api/presets") {
      json(res, 200, PRESETS);
      return;
    }

    if (method === "GET" && path === "/api/usage") {
      const range = (new URL(req.url ?? "", "http://x").searchParams.get("range") ?? "7d") as UsageRange;
      if (!["today", "7d", "30d", "all"].includes(range)) {
        json(res, 400, { error: "未知的时间范围" });
        return;
      }
      const since = rangeStart(range);
      const entries = ledger ? ledger.read(since) : [...log].reverse().filter(e => !since || new Date(e.at) >= since);
      json(res, 200, summarize(entries, range));
      return;
    }

    const stopMatch = /^\/api\/sessions\/(\d+)\/stop$/.exec(path);
    if (method === "POST" && stopMatch) {
      const pid = Number(stopMatch[1]);
      // Only ever signal a process that carries an EasySwitch session marker.
      if (!(await augmentedSessions()).includes(pid)) {
        json(res, 404, { error: "不是 EasySwitch 启动的会话" });
        return;
      }
      process.kill(pid, "SIGTERM");
      json(res, 200, { ok: true });
      return;
    }

    const bindingMatch = /^\/api\/bindings\/([a-z0-9-]+)$/.exec(path);
    if (bindingMatch && !AGENTS.some(a => a.id === bindingMatch[1])) {
      json(res, 404, { error: "不认识这个 agent" });
      return;
    }
    if (method === "DELETE" && bindingMatch) {
      // Back to native for this harness: no augmented model at all.
      store.clearBinding(bindingMatch[1] as Harness);
      json(res, 200, { ok: true });
      return;
    }
    if (method === "PUT" && bindingMatch) {
      const harness = bindingMatch[1] as Harness;
      const model = String(body.model ?? "");
      // A pool is a model like any other as far as an agent is concerned.
      const provider = body.providerId === "pool" && store.pool(model) ? { id: "pool" } : store.provider(String(body.providerId ?? ""));
      if (!provider || !model) {
        json(res, 400, { error: "需要选择模型来源和模型" });
        return;
      }
      store.setBinding({ harness, providerId: provider.id, model });
      json(res, 200, store.binding(harness));
      return;
    }
    // Thinking level and the other models an agent runs belong to the agent, whatever its main model is (even native).
    const bindingEffort = /^\/api\/bindings\/([a-z0-9-]+)\/effort$/.exec(path);
    if (bindingEffort && method === "PUT") {
      const id = bindingEffort[1] ?? "";
      if (!LAUNCHERS[id]) { json(res, 404, { error: "这个 agent 不能单独设置" }); return; }
      const cur = store.binding(id);
      const level = String(body.effort ?? "");
      if (level && !(await levelsFor(id, cur ? `${cur.providerId}/${cur.model}` : undefined)).includes(level)) { json(res, 400, { error: "这个模型没有这一档（或者这个 agent 说不出这一档）" }); return; }
      json(res, 200, store.setPrefs(id, { effort: level }));
      return;
    }
    const bindingTier = /^\/api\/bindings\/([a-z0-9-]+)\/tiers\/([a-z0-9-]+)$/.exec(path);
    if (bindingTier && (method === "PUT" || method === "DELETE")) {
      const [, id = "", tier = ""] = bindingTier;
      if (!(LAUNCHERS[id]?.tiers ?? []).some(t => t.id === tier)) { json(res, 404, { error: "这个 agent 没有这一项" }); return; }
      if (method === "DELETE") { json(res, 200, store.setPrefs(id, { tiers: { [tier]: "" } })); return; }
      const name = `${String(body.providerId ?? "")}/${String(body.model ?? "")}`;
      if (!store.catalog().some(m => `${m.providerId}/${m.model}` === name)) { json(res, 400, { error: "没有这个模型" }); return; }
      json(res, 200, store.setPrefs(id, { tiers: { [tier]: name } }));
      return;
    }

    const launchMatch = /^\/api\/launch\/(codex|claude)$/.exec(path);
    if (launchMatch && (method === "POST" || method === "GET")) {
      const harness = launchMatch[1] as Harness;
      const label = harness === "codex" ? "ChatGPT" : "Claude Code";
      const made = await interactiveSpec(harness, {});
      if ("error" in made) { json(res, made.status, { error: made.error }); return; }
      const command = `${commandLine(made.spec)}; rm -rf ${JSON.stringify(made.sessionDir)}`;
      const shown = made.model || "Claude 原生模型 + 你加的模型";
      if (method === "POST") {
        await launchInTerminal(command, `EasySwitch 增强会话（${label}）：${shown}（只在这个窗口生效，关掉窗口即回到原生）`);
      }
      json(res, 200, { command, model: shown });
      return;
    }

    json(res, 404, { error: "unknown endpoint" });
  }

  async function serveStatic(res: ServerResponse, path: string): Promise<void> {
    const file = path === "/" ? "index.html" : path.slice(1);
    if (!/^(icons\/)?[a-z0-9._-]+$/i.test(file) || file.includes("..")) {
      json(res, 404, { error: "not found" });
      return;
    }
    try {
      const bytes = await readFile(WEB_DIR + file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(bytes);
    } catch {
      json(res, 404, { error: "not found" });
    }
  }

  // The key that signs the launch tokens is made (or read) before the first request is answered.
  const gatewayKeyReady = deps.gatewayAuth ? loadGatewayKey(secrets) : Promise.resolve();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://placeholder");
    const path = url.pathname;
    try {
      // DNS-rebinding guard: only our own loopback authority may talk to us.
      if (!allowedHosts.has(String(req.headers.host ?? ""))) {
        json(res, 421, { error: "unexpected host" });
        return;
      }
      await gatewayKeyReady;
      if (path === "/health") {
        json(res, 200, { ok: true, service: "easyswitch", version: VERSION, port });
        return;
      }
      if (isChatgptPath(path)) {
        // The ChatGPT desktop app, pointed here through the launcher: merged models, native traffic forwarded.
        await handleChatgpt(req, res, path, url.search, { store, secrets, log: pushLog });
        return;
      }
      // The gateway spends the person's keys and subscriptions: only a launch EasySwitch itself made may use it.
      if (deps.gatewayAuth && isGatewayPath(path) && !requestHasValidToken(req.headers, url.search)) {
        json(res, 401, { type: "error", error: { type: "authentication_error", message: "EasySwitch 的网关只接受它自己启动的 agent：请用 EasySwitch 启动（es <名字> 或控制台里的「启动」），或照「配置向导」里的令牌填。" } });
        return;
      }
      if (req.method === "POST" && (path === "/v1/responses" || path === "/responses")) {
        const raw = await readBody(req);
        await runWithPool(store, modelOfBody(raw), res, (r, member, ctx) => handleResponses(req, r, member ? withModel(raw, member) : raw, { store, secrets, log: logFor(ctx) }));
        return;
      }
      if (path === "/mcp") {
        await handleMcp(req, res, req.method === "POST" ? await readBody(req) : "", mcpDeps);
        return;
      }
      if (req.method === "GET" && (path === "/v1beta/models" || path === "/v1beta/openai/models")) {
        json(res, 200, listGeminiModels({ store, secrets, log: pushLog }));
        return;
      }
      const geminiMatch = req.method === "POST" ? GEMINI_PATH.exec(path) : null;
      if (geminiMatch) {
        const raw = await readBody(req);
        const named = decodeURIComponent(geminiMatch[2] ?? "").replace(/^models\//, "");
        await runWithPool(store, named, res, (r, member, ctx) => {
          // The model is in the address, not the body.
          const m = member ? Object.assign([...geminiMatch], { index: geminiMatch.index, input: geminiMatch.input }) as unknown as RegExpExecArray : geminiMatch;
          if (member) m[2] = `models/${encodeURIComponent(member)}`;
          return handleGemini(req, r, m, raw, { store, secrets, log: logFor(ctx) });
        });
        return;
      }
      if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
        const raw = await readBody(req);
        await runWithPool(store, modelOfBody(raw), res, (r, member, ctx) => handleChatCompletions(req, r, member ? withModel(raw, member) : raw, { store, secrets, log: logFor(ctx) }));
        return;
      }
      if (req.method === "POST" && (path === "/v1/messages/count_tokens" || path === "/messages/count_tokens")) {
        await handleCountTokens(req, res, await readBody(req), { store, secrets, log: pushLog });
        return;
      }
      if (req.method === "POST" && (path === "/v1/messages" || path === "/messages")) {
        const raw = await readBody(req);
        await runWithPool(store, modelOfBody(raw), res, (r, member, ctx) => handleMessages(req, r, member ? withModel(raw, member) : raw, { store, secrets, log: logFor(ctx) }));
        return;
      }
      if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
        // Claude Code's gateway model discovery sends Anthropic headers.
        const forClaude = req.headers["anthropic-version"] !== undefined;
        const list = listExposedModels(store, forClaude);
        if (forClaude && store.settings().claudeNative) {
          // Claude's own models first, then the ones EasySwitch adds, in one menu.
          const native = await nativeModels(req.headers);
          if (native.length) {
            const data = [...native, ...((list.data as unknown[]) ?? [])] as Array<{ id: string }>;
            json(res, 200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
            return;
          }
        }
        json(res, 200, list);
        return;
      }
      if (path.startsWith("/api/")) {
        await api(req, res, path);
        return;
      }
      if (req.method === "GET") {
        await serveStatic(res, path);
        return;
      }
      json(res, 404, { error: "not found" });
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: String((error as Error).message ?? error) });
      else res.end();
    }
  });
  allowBoundPort((server.address() as { port: number } | null)?.port);
  server.on("listening", () => allowBoundPort((server.address() as { port: number } | null)?.port));
  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://placeholder").pathname;
    // Only the ChatGPT app's WebSocket, and only from our own loopback authority.
    if (!isChatgptPath(path) || !allowedHosts.has(String(req.headers.host ?? ""))) {
      socket.destroy();
      return;
    }
    handleChatgptUpgrade(req, socket as import("node:net").Socket, head);
  });
  // Coding plans used with a key are asked how much is left now and then, so a used-up one is skipped by the pools and the cards show it.
  const pollUsage = async () => {
    for (const p of store.providers()) {
      if (p.off || !hasPlanUsage(p)) continue;
      try { await refreshPlanUsage(p, (await pickKey(secrets, p)).apiKey); } catch { /* the next round tries again */ }
    }
  };
  const first = setTimeout(() => void pollUsage(), 5_000);
  const every = setInterval(() => void pollUsage(), 5 * 60_000);
  first.unref(); every.unref();
  server.on("close", () => { clearTimeout(first); clearInterval(every); });
  return server;
}
