import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { handleResponses, listExposedModels } from "./gateway.ts";
import { augmentedSessions, codexCommandLine, findCodex, launchInTerminal } from "./launch.ts";
import { nativeFiles } from "./native.ts";
import { listModels, probeProvider } from "./probe.ts";
import type { SecretStore } from "./secrets.ts";
import { slugify, type Store } from "./store.ts";
import type { GatewayLogEntry, Provider, ProviderRoute } from "./types.ts";

type Json = Record<string, unknown>;

const VERSION = "0.0.1";
const MAX_BODY = 32 * 1024 * 1024;
const WEB_DIR = fileURLToPath(new URL("../../web/", import.meta.url));
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

export interface ServerDeps {
  store: Store;
  secrets: SecretStore;
  port: number;
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

function publicProvider(p: Provider, hasKey: boolean) {
  return { ...p, hasKey };
}

export function createEasySwitchServer(deps: ServerDeps): Server {
  const { store, secrets, port } = deps;
  const log: GatewayLogEntry[] = [];
  const pushLog = (entry: GatewayLogEntry) => {
    log.unshift(entry);
    log.length = Math.min(log.length, 100);
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
      const providers = await Promise.all(store.providers().map(async p => publicProvider(p, Boolean(await secrets.get(p.id)))));
      json(res, 200, {
        version: VERSION, port, providers,
        binding: store.binding("codex") ?? null,
        codexPath: (await findCodex()) ?? null,
        sessions: await augmentedSessions(),
        native: nativeFiles(),
        log,
      });
      return;
    }

    if (method === "POST" && path === "/api/providers") {
      const name = String(body.name ?? "").trim();
      const baseUrl = String(body.baseUrl ?? "").trim().replace(/\/+$/, "");
      const apiKey = String(body.apiKey ?? "").trim();
      if (!name || !/^https?:\/\//.test(baseUrl)) {
        json(res, 400, { error: "需要名称和以 http(s):// 开头的地址" });
        return;
      }
      const provider: Provider = {
        id: slugify(name, store.providers().map(p => p.id)),
        name, baseUrl, models: [], route: "chat-translate", routePinned: false, streamUsage: true,
        createdAt: new Date().toISOString(),
      };
      if (apiKey) await secrets.set(provider.id, apiKey);
      const { models } = await listModels(provider, apiKey || undefined);
      provider.models = models;
      store.upsertProvider(provider);
      json(res, 201, publicProvider(provider, Boolean(apiKey)));
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

    if (method === "PUT" && path === "/api/bindings/codex") {
      const provider = store.provider(String(body.providerId ?? ""));
      const model = String(body.model ?? "");
      if (!provider || !model) {
        json(res, 400, { error: "需要选择模型来源和模型" });
        return;
      }
      store.setBinding({ harness: "codex", providerId: provider.id, model });
      json(res, 200, store.binding("codex"));
      return;
    }

    if (path === "/api/launch/codex" && (method === "POST" || method === "GET")) {
      const binding = store.binding("codex");
      const codex = await findCodex();
      if (!binding || !codex) {
        json(res, 409, { error: !binding ? "还没有给 Codex 绑定模型" : "找不到 codex 命令" });
        return;
      }
      const exposed = `${binding.providerId}/${binding.model}`;
      const command = codexCommandLine(codex, port, exposed);
      if (method === "POST") {
        await launchInTerminal(command, `EasySwitch 增强会话：${exposed}（只在这个窗口生效，关掉窗口即回到原生）`);
      }
      json(res, 200, { command, model: exposed });
      return;
    }

    json(res, 404, { error: "unknown endpoint" });
  }

  async function serveStatic(res: ServerResponse, path: string): Promise<void> {
    const file = path === "/" ? "index.html" : path.slice(1);
    if (!/^[a-z0-9._-]+$/i.test(file)) {
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
      if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
        json(res, 200, listExposedModels(store));
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
