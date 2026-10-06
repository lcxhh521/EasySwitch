import type { MessagesRoute, ProbeCheck, ProbeReport, Provider, ProviderRoute } from "./types.ts";
import { endpointUrl, sseData, timedFetch, upstreamHeaders, type CallKind } from "./upstream.ts";

type Json = Record<string, unknown>;

const JSON_HEADERS = { "content-type": "application/json" };

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Source check cancelled", "AbortError");
}

/** Cancel the actual response reader, including injected streams that do not implement fetch abort. */
function cancellableBody(body: ReadableStream<Uint8Array>, signal?: AbortSignal): ReadableStream<Uint8Array> {
  if (!signal) return body;
  const reader = body.getReader();
  let finished = false;
  let abort = () => {};
  const cleanup = () => { signal.removeEventListener("abort", abort); };
  const release = () => { try { reader.releaseLock(); } catch { /* a pending read is already being cancelled */ } };
  const cancel = () => { void reader.cancel().catch(() => {}); release(); };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        if (finished) return;
        finished = true; cleanup(); cancel();
        controller.error(new DOMException("Source check cancelled", "AbortError"));
      };
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    },
    async pull(controller) {
      if (finished) return;
      try {
        const next = await reader.read();
        if (finished) return;
        if (next.done) { finished = true; cleanup(); release(); controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) {
        if (finished) return;
        finished = true; cleanup(); release(); controller.error(error);
      }
    },
    cancel() { if (!finished) { finished = true; cleanup(); cancel(); } },
  });
}

async function readProbeJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const json = await (response.body ? new Response(cancellableBody(response.body, signal)) : response).json();
  checkCancelled(signal);
  return json;
}

function probeFailure(response: Response, signal?: AbortSignal): string {
  // No upstream error body is read or persisted. Never wait on an uncooperative body's cancel promise.
  void response.body?.cancel().catch(() => {});
  checkCancelled(signal);
  return `HTTP ${response.status}`;
}

async function postJson(provider: Provider, apiKey: string | undefined, kind: CallKind, body: Json, signal?: AbortSignal) {
  checkCancelled(signal);
  return timedFetch(endpointUrl(provider, kind), {
    method: "POST", signal,
    headers: { ...JSON_HEADERS, ...upstreamHeaders(provider, apiKey) },
    body: JSON.stringify(body),
  });
}

function messageText(json: Json): string {
  const choice = (Array.isArray(json.choices) ? json.choices[0] : undefined) as Json | undefined;
  const message = choice?.message as Json | undefined;
  return typeof message?.content === "string" ? message.content : "";
}

/** GET /models. Returns the ids so the UI can offer them. */
export async function listModels(provider: Provider, apiKey: string | undefined, signal?: AbortSignal): Promise<{ check: ProbeCheck; models: string[] }> {
  const label = "列出模型";
  try {
    checkCancelled(signal);
    const { response, ms } = await timedFetch(endpointUrl(provider, "models"), { headers: upstreamHeaders(provider, apiKey), signal }, 15_000);
    if (!response.ok) return { check: { id: "models", label, status: "fail", latencyMs: ms, detail: probeFailure(response, signal) }, models: [] };
    const json = (await readProbeJson(response, signal)) as Json;
    const models = (Array.isArray(json.data) ? json.data : [])
      .map(m => (m as Json).id)
      .filter((id): id is string => typeof id === "string")
      .slice(0, 500);
    return { check: { id: "models", label, status: models.length ? "pass" : "fail", latencyMs: ms, detail: `${models.length} 个模型` }, models };
  } catch (error) {
    checkCancelled(signal);
    return { check: { id: "models", label, status: "fail", detail: String((error as Error).message ?? error) }, models: [] };
  }
}

async function checkChat(provider: Provider, apiKey: string | undefined, model: string, signal?: AbortSignal): Promise<ProbeCheck> {
  const label = "普通回答";
  try {
    checkCancelled(signal);
    const { response, ms } = await postJson(provider, apiKey, "chat", {
      model, stream: false, max_tokens: 32,
      messages: [{ role: "user", content: "Reply with exactly the word: pong" }],
    }, signal);
    if (!response.ok) return { id: "chat", label, status: "fail", latencyMs: ms, detail: probeFailure(response, signal) };
    const text = messageText((await readProbeJson(response, signal)) as Json);
    return { id: "chat", label, status: text ? "pass" : "fail", latencyMs: ms, detail: text ? `回答：${text.slice(0, 60)}` : "回答为空" };
  } catch (error) {
    checkCancelled(signal);
    return { id: "chat", label, status: "fail", detail: String((error as Error).message ?? error) };
  }
}

/** Streams once with include_usage; if the relay refuses that option, once without. */
async function checkStream(provider: Provider, apiKey: string | undefined, model: string, signal?: AbortSignal): Promise<{ check: ProbeCheck; streamUsage: boolean }> {
  const label = "流式输出";
  for (const withUsage of [true, false]) {
    try {
      checkCancelled(signal);
      const body: Json = { model, stream: true, max_tokens: 32, messages: [{ role: "user", content: "Count from 1 to 5." }] };
      if (withUsage) body.stream_options = { include_usage: true };
      const { response, ms } = await postJson(provider, apiKey, "chat", body, signal);
      if (!response.ok || !response.body) {
        if (withUsage && response.status === 400) { probeFailure(response, signal); continue; }
        return { check: { id: "chat-stream", label, status: "fail", latencyMs: ms, detail: probeFailure(response, signal) }, streamUsage: false };
      }
      let deltas = 0;
      let usage = false;
      for await (const data of sseData(cancellableBody(response.body, signal))) {
        if (data === "[DONE]") break;
        const json = JSON.parse(data) as Json;
        if (json.usage) usage = true;
        const delta = ((Array.isArray(json.choices) ? json.choices[0] : undefined) as Json | undefined)?.delta as Json | undefined;
        if (typeof delta?.content === "string" && delta.content) deltas += 1;
      }
      checkCancelled(signal);
      return {
        check: { id: "chat-stream", label, status: deltas ? "pass" : "fail", latencyMs: ms, detail: `${deltas} 段增量${usage ? "，带用量" : "，不带用量"}` },
        streamUsage: withUsage && usage,
      };
    } catch (error) {
      checkCancelled(signal);
      if (withUsage) continue;
      return { check: { id: "chat-stream", label, status: "fail", detail: String((error as Error).message ?? error) }, streamUsage: false };
    }
  }
  return { check: { id: "chat-stream", label, status: "fail", detail: "不支持流式输出" }, streamUsage: false };
}

async function checkTools(provider: Provider, apiKey: string | undefined, model: string, signal?: AbortSignal): Promise<ProbeCheck> {
  const label = "工具调用";
  try {
    checkCancelled(signal);
    const { response, ms } = await postJson(provider, apiKey, "chat", {
      model, stream: false, max_tokens: 128, tool_choice: "auto",
      messages: [{ role: "user", content: "What is the weather in Paris? Use the tool." }],
      tools: [{
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the current weather for a city.",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      }],
    }, signal);
    if (!response.ok) return { id: "tools", label, status: "fail", latencyMs: ms, detail: probeFailure(response, signal) };
    const json = (await readProbeJson(response, signal)) as Json;
    const message = ((Array.isArray(json.choices) ? json.choices[0] : undefined) as Json | undefined)?.message as Json | undefined;
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    const first = calls[0] as Json | undefined;
    const name = (first?.function as Json | undefined)?.name;
    return {
      id: "tools", label, status: name === "get_weather" ? "pass" : "fail", latencyMs: ms,
      detail: name ? `调用了 ${String(name)}` : "没有发起工具调用（Codex 读写代码离不开工具调用）",
    };
  } catch (error) {
    checkCancelled(signal);
    return { id: "tools", label, status: "fail", detail: String((error as Error).message ?? error) };
  }
}

/** Does the relay speak the Responses API itself? Then we pass Codex traffic through untouched. */
async function checkResponses(provider: Provider, apiKey: string | undefined, model: string, signal?: AbortSignal): Promise<ProbeCheck> {
  const label = "原生 Responses 协议";
  try {
    checkCancelled(signal);
    const { response, ms } = await postJson(provider, apiKey, "responses", {
      model, stream: false, input: "Reply with exactly the word: pong", max_output_tokens: 32,
    }, signal);
    if (!response.ok) return { id: "responses", label, status: "fail", latencyMs: ms, detail: `不支持（${probeFailure(response, signal)}），将走协议转换` };
    const json = (await readProbeJson(response, signal)) as Json;
    const ok = Array.isArray(json.output) && json.output.length > 0;
    return { id: "responses", label, status: ok ? "pass" : "fail", latencyMs: ms, detail: ok ? "支持，Codex 请求将原样转发" : "返回格式不对，将走协议转换" };
  } catch (error) {
    checkCancelled(signal);
    return { id: "responses", label, status: "fail", detail: `不支持（${String((error as Error).message ?? error)}），将走协议转换` };
  }
}

/** Anthropic Messages headers: relays read either the bearer or x-api-key. */
export function anthropicHeaders(apiKey: string | undefined, provider?: Pick<Provider, "wire">): Record<string, string> {
  return {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    ...(apiKey ? { "x-api-key": apiKey } : {}),
    ...upstreamHeaders(provider ?? {}, apiKey),
  };
}

/** Does the provider speak Anthropic Messages? Then Claude Code traffic passes through untouched. */
async function checkMessages(provider: Provider, apiKey: string | undefined, model: string, signal?: AbortSignal): Promise<ProbeCheck> {
  const label = "原生 Messages 协议";
  try {
    checkCancelled(signal);
    const { response, ms } = await timedFetch(endpointUrl(provider, "messages"), {
      method: "POST", signal,
      headers: anthropicHeaders(apiKey, provider),
      body: JSON.stringify({ model, max_tokens: 32, messages: [{ role: "user", content: "Reply with exactly the word: pong" }] }),
    });
    if (!response.ok) return { id: "messages", label, status: "fail", latencyMs: ms, detail: `不支持（${probeFailure(response, signal)}），Claude Code 将走协议转换` };
    const json = (await readProbeJson(response, signal)) as Json;
    const ok = Array.isArray(json.content) && json.content.some(b => (b as Json).type === "text");
    return { id: "messages", label, status: ok ? "pass" : "fail", latencyMs: ms, detail: ok ? "支持，Claude Code 请求将原样转发" : "返回格式不对，将走协议转换" };
  } catch (error) {
    checkCancelled(signal);
    return { id: "messages", label, status: "fail", detail: `不支持（${String((error as Error).message ?? error)}），将走协议转换` };
  }
}

export async function probeProvider(provider: Provider, apiKey: string | undefined, model: string, signal?: AbortSignal): Promise<{ report: ProbeReport; models: string[]; streamUsage: boolean }> {
  checkCancelled(signal);
  const { check: modelsCheck, models } = await listModels(provider, apiKey, signal);
  checkCancelled(signal);
  const [chat, stream, tools, responses, messages] = await Promise.all([
    checkChat(provider, apiKey, model, signal),
    checkStream(provider, apiKey, model, signal),
    checkTools(provider, apiKey, model, signal),
    checkResponses(provider, apiKey, model, signal),
    checkMessages(provider, apiKey, model, signal),
  ]);
  checkCancelled(signal);
  const recommendedRoute: ProviderRoute = responses.status === "pass" ? "responses-native" : "chat-translate";
  const recommendedMessagesRoute: MessagesRoute = messages.status === "pass" ? "anthropic-native" : "chat-translate";
  return {
    report: {
      at: new Date().toISOString(), model,
      checks: [modelsCheck, chat, stream.check, tools, responses, messages],
      recommendedRoute, recommendedMessagesRoute,
    },
    models,
    streamUsage: stream.streamUsage,
  };
}
