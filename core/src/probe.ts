import type { MessagesRoute, ProbeCheck, ProbeReport, Provider, ProviderRoute } from "./types.ts";
import { authHeaders, describeFailure, joinUrl, sseData, timedFetch } from "./upstream.ts";

type Json = Record<string, unknown>;

const JSON_HEADERS = { "content-type": "application/json" };

async function postJson(provider: Provider, apiKey: string | undefined, path: string, body: Json) {
  return timedFetch(joinUrl(provider.baseUrl, path), {
    method: "POST",
    headers: { ...JSON_HEADERS, ...authHeaders(apiKey) },
    body: JSON.stringify(body),
  });
}

function messageText(json: Json): string {
  const choice = (Array.isArray(json.choices) ? json.choices[0] : undefined) as Json | undefined;
  const message = choice?.message as Json | undefined;
  return typeof message?.content === "string" ? message.content : "";
}

/** GET /models. Returns the ids so the UI can offer them. */
export async function listModels(provider: Provider, apiKey: string | undefined): Promise<{ check: ProbeCheck; models: string[] }> {
  const label = "列出模型";
  try {
    const { response, ms } = await timedFetch(joinUrl(provider.baseUrl, "models"), { headers: authHeaders(apiKey) }, 15_000);
    if (!response.ok) return { check: { id: "models", label, status: "fail", latencyMs: ms, detail: await describeFailure(response) }, models: [] };
    const json = (await response.json()) as Json;
    const models = (Array.isArray(json.data) ? json.data : [])
      .map(m => (m as Json).id)
      .filter((id): id is string => typeof id === "string")
      .slice(0, 500);
    return { check: { id: "models", label, status: models.length ? "pass" : "fail", latencyMs: ms, detail: `${models.length} 个模型` }, models };
  } catch (error) {
    return { check: { id: "models", label, status: "fail", detail: String((error as Error).message ?? error) }, models: [] };
  }
}

async function checkChat(provider: Provider, apiKey: string | undefined, model: string): Promise<ProbeCheck> {
  const label = "普通回答";
  try {
    const { response, ms } = await postJson(provider, apiKey, "chat/completions", {
      model, stream: false, max_tokens: 32,
      messages: [{ role: "user", content: "Reply with exactly the word: pong" }],
    });
    if (!response.ok) return { id: "chat", label, status: "fail", latencyMs: ms, detail: await describeFailure(response) };
    const text = messageText((await response.json()) as Json);
    return { id: "chat", label, status: text ? "pass" : "fail", latencyMs: ms, detail: text ? `回答：${text.slice(0, 60)}` : "回答为空" };
  } catch (error) {
    return { id: "chat", label, status: "fail", detail: String((error as Error).message ?? error) };
  }
}

/** Streams once with include_usage; if the relay refuses that option, once without. */
async function checkStream(provider: Provider, apiKey: string | undefined, model: string): Promise<{ check: ProbeCheck; streamUsage: boolean }> {
  const label = "流式输出";
  for (const withUsage of [true, false]) {
    try {
      const body: Json = { model, stream: true, max_tokens: 32, messages: [{ role: "user", content: "Count from 1 to 5." }] };
      if (withUsage) body.stream_options = { include_usage: true };
      const { response, ms } = await postJson(provider, apiKey, "chat/completions", body);
      if (!response.ok || !response.body) {
        if (withUsage && response.status === 400) continue;
        return { check: { id: "chat-stream", label, status: "fail", latencyMs: ms, detail: await describeFailure(response) }, streamUsage: false };
      }
      let deltas = 0;
      let usage = false;
      for await (const data of sseData(response.body)) {
        if (data === "[DONE]") break;
        const json = JSON.parse(data) as Json;
        if (json.usage) usage = true;
        const delta = ((Array.isArray(json.choices) ? json.choices[0] : undefined) as Json | undefined)?.delta as Json | undefined;
        if (typeof delta?.content === "string" && delta.content) deltas += 1;
      }
      return {
        check: { id: "chat-stream", label, status: deltas ? "pass" : "fail", latencyMs: ms, detail: `${deltas} 段增量${usage ? "，带用量" : "，不带用量"}` },
        streamUsage: withUsage && usage,
      };
    } catch (error) {
      if (withUsage) continue;
      return { check: { id: "chat-stream", label, status: "fail", detail: String((error as Error).message ?? error) }, streamUsage: false };
    }
  }
  return { check: { id: "chat-stream", label, status: "fail", detail: "不支持流式输出" }, streamUsage: false };
}

async function checkTools(provider: Provider, apiKey: string | undefined, model: string): Promise<ProbeCheck> {
  const label = "工具调用";
  try {
    const { response, ms } = await postJson(provider, apiKey, "chat/completions", {
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
    });
    if (!response.ok) return { id: "tools", label, status: "fail", latencyMs: ms, detail: await describeFailure(response) };
    const json = (await response.json()) as Json;
    const message = ((Array.isArray(json.choices) ? json.choices[0] : undefined) as Json | undefined)?.message as Json | undefined;
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    const first = calls[0] as Json | undefined;
    const name = (first?.function as Json | undefined)?.name;
    return {
      id: "tools", label, status: name === "get_weather" ? "pass" : "fail", latencyMs: ms,
      detail: name ? `调用了 ${String(name)}` : "没有发起工具调用（Codex 读写代码离不开工具调用）",
    };
  } catch (error) {
    return { id: "tools", label, status: "fail", detail: String((error as Error).message ?? error) };
  }
}

/** Does the relay speak the Responses API itself? Then we pass Codex traffic through untouched. */
async function checkResponses(provider: Provider, apiKey: string | undefined, model: string): Promise<ProbeCheck> {
  const label = "原生 Responses 协议";
  try {
    const { response, ms } = await postJson(provider, apiKey, "responses", {
      model, stream: false, input: "Reply with exactly the word: pong", max_output_tokens: 32,
    });
    if (!response.ok) return { id: "responses", label, status: "fail", latencyMs: ms, detail: `不支持（${await describeFailure(response)}），将走协议转换` };
    const json = (await response.json()) as Json;
    const ok = Array.isArray(json.output) && json.output.length > 0;
    return { id: "responses", label, status: ok ? "pass" : "fail", latencyMs: ms, detail: ok ? "支持，Codex 请求将原样转发" : "返回格式不对，将走协议转换" };
  } catch (error) {
    return { id: "responses", label, status: "fail", detail: `不支持（${String((error as Error).message ?? error)}），将走协议转换` };
  }
}

/** Anthropic Messages headers: relays read either the bearer or x-api-key. */
export function anthropicHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    ...(apiKey ? { "x-api-key": apiKey, ...authHeaders(apiKey) } : {}),
  };
}

/** Does the provider speak Anthropic Messages? Then Claude Code traffic passes through untouched. */
async function checkMessages(provider: Provider, apiKey: string | undefined, model: string): Promise<ProbeCheck> {
  const label = "原生 Messages 协议";
  const base = provider.anthropicBaseUrl ?? provider.baseUrl;
  try {
    const { response, ms } = await timedFetch(joinUrl(base, "messages"), {
      method: "POST",
      headers: anthropicHeaders(apiKey),
      body: JSON.stringify({ model, max_tokens: 32, messages: [{ role: "user", content: "Reply with exactly the word: pong" }] }),
    });
    if (!response.ok) return { id: "messages", label, status: "fail", latencyMs: ms, detail: `不支持（${await describeFailure(response)}），Claude Code 将走协议转换` };
    const json = (await response.json()) as Json;
    const ok = Array.isArray(json.content) && json.content.some(b => (b as Json).type === "text");
    return { id: "messages", label, status: ok ? "pass" : "fail", latencyMs: ms, detail: ok ? "支持，Claude Code 请求将原样转发" : "返回格式不对，将走协议转换" };
  } catch (error) {
    return { id: "messages", label, status: "fail", detail: `不支持（${String((error as Error).message ?? error)}），将走协议转换` };
  }
}

export async function probeProvider(provider: Provider, apiKey: string | undefined, model: string): Promise<{ report: ProbeReport; models: string[]; streamUsage: boolean }> {
  const { check: modelsCheck, models } = await listModels(provider, apiKey);
  const [chat, stream, tools, responses, messages] = await Promise.all([
    checkChat(provider, apiKey, model),
    checkStream(provider, apiKey, model),
    checkTools(provider, apiKey, model),
    checkResponses(provider, apiKey, model),
    checkMessages(provider, apiKey, model),
  ]);
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
