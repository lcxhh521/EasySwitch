import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeCodexCatalog } from "./catalog.ts";
import { handleResponses, listExposedModels } from "./gateway.ts";
import { handleCountTokens, handleMessages } from "./gateway-messages.ts";
import { augmentedSessions, claudeCommandLine, claudeEnv, codexCommandLine, findClaude, findCodex, launchInTerminal, sessionDetails } from "./launch.ts";
import { rangeStart, summarize, type Ledger, type UsageRange } from "./ledger.ts";
import { iconForBaseUrl, PRESETS } from "./presets.ts";
import { keySecretId, newKeyId } from "./keypool.ts";
import { nativeFiles } from "./native.ts";
import { listModels, probeProvider } from "./probe.ts";
import type { SecretStore } from "./secrets.ts";
import { slugify, type Store } from "./store.ts";
import type { GatewayLogEntry, Harness, Provider, ProviderRoute } from "./types.ts";

type Json = Record<string, unknown>;

const VERSION = "0.0.1";
const MAX_BODY = 32 * 1024 * 1024;
const WEB_DIR = fileURLToPath(new URL("../../web/", import.meta.url));
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

export interface ServerDeps {
  store: Store;
  secrets: SecretStore;
  port: number;
  /** Durable usage ledger; tests leave it out and usage comes from memory. */
  ledger?: Ledger;
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

function publicProvider(p: Provider, hasKey: boolean, usedBy: Harness[] = []) {
  // Key metadata is public inside the console; the secrets themselves never leave the Keychain.
  const keys = (p.keys ?? []).map(({ id, label, enabled, addedAt, lastUsedAt, restUntil, lastError }) =>
    ({ id, label, enabled, addedAt, ...(lastUsedAt ? { lastUsedAt } : {}), ...(restUntil ? { restUntil } : {}), ...(lastError ? { lastError } : {}) }));
  return { ...p, hasKey, ...(keys.length ? { keys } : {}), icon: iconForBaseUrl(p.baseUrl), usedBy };
}

export function createEasySwitchServer(deps: ServerDeps): Server {
  const { store, secrets, port, ledger } = deps;
  const log: GatewayLogEntry[] = [];
  const pushLog = (entry: GatewayLogEntry) => {
    log.unshift(entry);
    log.length = Math.min(log.length, 100);
    ledger?.append(entry);
    console.log(`[gateway] ${entry.status} ${entry.route} ${entry.model} ${entry.ms}ms${entry.note ? ` (${entry.note})` : ""}`);
  };
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

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
      const bound = (["codex", "claude"] as const).map(h => store.binding(h)).filter(b => b !== undefined);
      const providers = await Promise.all(store.providers().map(async p =>
        publicProvider(p, Boolean(await secrets.get(p.id)), bound.filter(b => b.providerId === p.id).map(b => b.harness))));
      json(res, 200, {
        version: VERSION, port, providers,
        binding: store.binding("codex") ?? null,
        bindings: { codex: store.binding("codex") ?? null, claude: store.binding("claude") ?? null },
        codexPath: (await findCodex()) ?? null,
        claudePath: (await findClaude()) ?? null,
        sessions: await augmentedSessions(),
        sessionDetails: await sessionDetails(),
        native: nativeFiles(),
        log,
      });
      return;
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
      const provider: Provider = {
        id: slugify(name, store.providers().map(p => p.id)),
        name, baseUrl, models: [], route: "chat-translate", routePinned: false, streamUsage: true,
        ...(anthropicBaseUrl ? { anthropicBaseUrl } : {}),
        createdAt: new Date().toISOString(),
      };
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

    const bindingMatch = /^\/api\/bindings\/(codex|claude)$/.exec(path);
    if (method === "DELETE" && bindingMatch) {
      // Back to native for this harness: no augmented model at all.
      store.clearBinding(bindingMatch[1] as Harness);
      json(res, 200, { ok: true });
      return;
    }
    if (method === "PUT" && bindingMatch) {
      const harness = bindingMatch[1] as Harness;
      const provider = store.provider(String(body.providerId ?? ""));
      const model = String(body.model ?? "");
      if (!provider || !model) {
        json(res, 400, { error: "需要选择模型来源和模型" });
        return;
      }
      store.setBinding({ harness, providerId: provider.id, model });
      json(res, 200, store.binding(harness));
      return;
    }

    const launchMatch = /^\/api\/launch\/(codex|claude)$/.exec(path);
    if (launchMatch && (method === "POST" || method === "GET")) {
      const harness = launchMatch[1] as Harness;
      const label = harness === "codex" ? "Codex" : "Claude Code";
      const binding = store.binding(harness);
      const binary = harness === "codex" ? await findCodex() : await findClaude();
      if (!binding || !binary) {
        json(res, 409, { error: !binding ? `还没有给 ${label} 绑定模型` : `找不到 ${label} 的命令` });
        return;
      }
      const exposed = `${binding.providerId}/${binding.model}`;
      const catalog = harness === "codex" ? await writeCodexCatalog(binary, store.dir, store.providers()) : undefined;
      const command = harness === "codex"
        ? codexCommandLine(binary, port, exposed, catalog)
        : claudeCommandLine(binary, claudeEnv(port, exposed, `es-session-${randomUUID()}`));
      if (method === "POST") {
        await launchInTerminal(command, `EasySwitch 增强会话（${label}）：${exposed}（只在这个窗口生效，关掉窗口即回到原生）`);
      }
      json(res, 200, { command, model: exposed });
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

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://placeholder");
    const path = url.pathname;
    try {
      // DNS-rebinding guard: only our own loopback authority may talk to us.
      if (!allowedHosts.has(String(req.headers.host ?? ""))) {
        json(res, 421, { error: "unexpected host" });
        return;
      }
      if (path === "/health") {
        json(res, 200, { ok: true, service: "easyswitch", version: VERSION, port });
        return;
      }
      if (req.method === "POST" && (path === "/v1/responses" || path === "/responses")) {
        await handleResponses(req, res, await readBody(req), { store, secrets, log: pushLog });
        return;
      }
      if (req.method === "POST" && (path === "/v1/messages/count_tokens" || path === "/messages/count_tokens")) {
        handleCountTokens(res, await readBody(req));
        return;
      }
      if (req.method === "POST" && (path === "/v1/messages" || path === "/messages")) {
        await handleMessages(req, res, await readBody(req), { store, secrets, log: pushLog });
        return;
      }
      if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
        // Claude Code's gateway model discovery sends Anthropic headers.
        json(res, 200, listExposedModels(store, req.headers["anthropic-version"] !== undefined));
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
}
