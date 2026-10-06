import { randomUUID } from "node:crypto";
import type { ApiProtocol } from "./types.ts";
import { packState, ProtocolError, type Json, type OutputEvent, type Stop, type Tool, type Usage } from "./protocol.ts";

interface Item { kind: "text" | "reasoning" | "call"; id: string; text: string; index: number; callId?: string; name?: string; signature?: string; encrypted?: string }
const chatStop = (s: Stop) => ({ stop: "stop", tool: "tool_calls", length: "length", filter: "content_filter" })[s];
const messageStop = (s: Stop) => ({ stop: "end_turn", tool: "tool_use", length: "max_tokens", filter: "refusal" })[s];

/** Each inbound API owns its response encoder, including its streaming lifecycle. */
export class Downstream {
  readonly id = "resp_" + randomUUID();
  readonly items: Item[] = [];
  usage?: Usage;
  stop: Stop = "stop";
  private slots = new Map<string, Item>();
  private sequence = 0;
  private openMessage?: number;
  private started = false;
  private created = Math.floor(Date.now() / 1000);
  private protocol: ApiProtocol;
  private model: string;
  private source: string;
  private outbound: ApiProtocol;
  private tools: Tool[];
  private write?: (value: string) => void;

  constructor(protocol: ApiProtocol, model: string, source: string, outbound: ApiProtocol, tools: Tool[], write?: (value: string) => void) {
    this.protocol = protocol; this.model = model; this.source = source; this.outbound = outbound; this.tools = tools; this.write = write;
  }
  private emit(type: string, data: Json) {
    if (!this.write) return;
    if (this.protocol === "responses") this.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data, sequence_number: this.sequence++ }) + '\n\n');
    else if (this.protocol === "messages") this.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n');
    else this.write('data: ' + JSON.stringify(data) + '\n\n');
  }
  private chat(delta: Json, finish: string | null = null, usage?: Json) {
    this.emit("", { id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) });
  }
  private gemini(parts: Json[], finish?: string) {
    this.emit("", { candidates: [{ index: 0, content: { role: "model", parts }, ...(finish ? { finishReason: finish } : {}) }], modelVersion: this.model, ...(finish ? { usageMetadata: this.wireUsage("gemini") } : {}) });
  }
  start() {
    if (this.started) return;
    this.started = true;
    if (this.protocol === "responses") this.emit("response.created", { response: this.response("in_progress") });
    else if (this.protocol === "messages") this.emit("message_start", { message: { id: this.id, type: "message", role: "assistant", model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    else if (this.protocol === "chat") this.chat({ role: "assistant", content: "" });
  }
  private state(i: Item): string | undefined {
    if (!i.signature && !i.encrypted) return undefined;
    return packState(this.source, this.model, { protocol: this.outbound, text: i.text, ...(i.signature ? { signature: i.signature } : {}), ...(i.encrypted ? { encrypted: i.encrypted } : {}) });
  }
  private spec(i: Item) { return this.tools.find(t => t.name === i.name); }
  private incomplete(): boolean { return this.stop === "length" || this.stop === "filter"; }
  private validArguments(i: Item): boolean {
    try { JSON.parse(i.text || "{}"); return true; } catch { return false; }
  }
  private customInput(i: Item): string {
    // A truncated custom wrapper cannot safely become an executable custom-tool input.
    if (this.incomplete() && !this.validArguments(i)) return "";
    const value = JSON.parse(i.text || "{}");
    if (typeof value.input !== "string") throw new ProtocolError("自定义工具缺少 input 字符串。", 502);
    return value.input;
  }
  private responseItem(i: Item, complete: boolean): Json {
    const status = complete ? this.incomplete() ? "incomplete" : "completed" : "in_progress";
    if (i.kind === "text") return { id: i.id, type: "message", role: "assistant", status, content: complete ? [{ type: "output_text", text: i.text, annotations: [], logprobs: [] }] : [] };
    if (i.kind === "reasoning") return { id: i.id, type: "reasoning", summary: complete && i.text ? [{ type: "summary_text", text: i.text }] : [], ...(complete && this.state(i) ? { encrypted_content: this.state(i) } : {}) };
    const tool = this.spec(i);
    return { id: i.id, type: tool?.custom ? "custom_tool_call" : "function_call", call_id: i.callId, name: tool?.bareName ?? i.name, ...(tool?.namespace ? { namespace: tool.namespace } : {}), status, ...(tool?.custom ? { input: complete ? this.customInput(i) : "" } : { arguments: complete ? i.text || "{}" : "" }) };
  }
  private wireUsage(p = this.protocol): Json {
    const u = this.usage ?? { input: 0, output: 0 };
    if (p === "chat") return { prompt_tokens: u.input, completion_tokens: u.output, total_tokens: u.input + u.output, prompt_tokens_details: { cached_tokens: u.cached ?? 0 }, ...(u.reasoning !== undefined ? { completion_tokens_details: { reasoning_tokens: u.reasoning } } : {}) };
    if (p === "responses") return { input_tokens: u.input, output_tokens: u.output, total_tokens: u.input + u.output, input_tokens_details: { cached_tokens: u.cached ?? 0 }, output_tokens_details: { reasoning_tokens: u.reasoning ?? 0 } };
    if (p === "messages") return { input_tokens: Math.max(0, u.input - (u.cached ?? 0) - (u.cacheWrite ?? 0)), output_tokens: u.output, cache_read_input_tokens: u.cached ?? 0, cache_creation_input_tokens: u.cacheWrite ?? 0 };
    return { promptTokenCount: u.input, candidatesTokenCount: u.output, totalTokenCount: u.input + u.output, cachedContentTokenCount: u.cached ?? 0, ...(u.reasoning !== undefined ? { thoughtsTokenCount: u.reasoning } : {}) };
  }
  private response(status: string): Json {
    return { id: this.id, object: "response", created_at: this.created, status, model: this.model, output: status === "in_progress" ? [] : this.items.map(i => this.responseItem(i, true)), error: null, incomplete_details: status === "incomplete" ? { reason: this.stop === "length" ? "max_output_tokens" : "content_filter" } : null, usage: status === "in_progress" ? null : this.wireUsage() };
  }
  private closeMessage() {
    if (this.openMessage === undefined) return;
    this.emit("content_block_stop", { index: this.openMessage }); this.openMessage = undefined;
  }
  accept(e: OutputEvent) {
    if (e.type === "usage") { this.usage = e.usage; return; }
    if (e.type === "stop") { this.stop = e.reason; return; }
    if (e.type === "reasoning" && !e.text && !e.signature && !e.encrypted) return;
    this.start();
    const kind = e.type === "call" || e.type === "arguments" ? "call" : e.type;
    const key = kind + ":" + (e.index ?? 0);
    let i = this.slots.get(key);
    if (!i) {
      if (e.type === "arguments") throw new ProtocolError("上游工具参数缺少对应调用。", 502);
      i = { kind, id: kind.slice(0, 3) + "_" + randomUUID(), index: this.items.length, text: "", ...(e.type === "call" ? { callId: e.id, name: e.name } : {}) };
      this.items.push(i); this.slots.set(key, i);
      if (this.protocol === "responses") {
        this.emit("response.output_item.added", { output_index: i.index, item: this.responseItem(i, false) });
        if (kind === "text") this.emit("response.content_part.added", { item_id: i.id, output_index: i.index, content_index: 0, part: { type: "output_text", text: "", annotations: [], logprobs: [] } });
        if (kind === "reasoning") this.emit("response.reasoning_summary_part.added", { item_id: i.id, output_index: i.index, summary_index: 0, part: { type: "summary_text", text: "" } });
      }
    }
    const delta = e.type === "call" ? e.arguments : e.type === "arguments" ? e.text : e.text ?? "";
    i.text += delta;
    if (e.type === "reasoning") { if (e.signature) i.signature = (i.signature ?? "") + e.signature; if (e.encrypted) i.encrypted = e.encrypted; }
    if (this.protocol === "chat") {
      if (kind === "text" && delta) this.chat({ content: delta });
      else if (kind === "reasoning" && delta) this.chat({ reasoning_content: delta });
      else if (kind === "call") this.chat({ tool_calls: [{ index: this.items.filter(x => x.kind === "call").indexOf(i), ...(e.type === "call" ? { id: i.callId, type: "function" } : {}), function: { ...(e.type === "call" ? { name: i.name } : {}), arguments: delta } }] });
    } else if (this.protocol === "responses" && delta) {
      const base = { item_id: i.id, output_index: i.index, delta };
      if (kind === "text") this.emit("response.output_text.delta", { ...base, content_index: 0, logprobs: [] });
      else if (kind === "reasoning") this.emit("response.reasoning_summary_text.delta", { ...base, summary_index: 0 });
      else if (!this.spec(i)?.custom) this.emit("response.function_call_arguments.delta", base);
    } else if (this.protocol === "messages" && kind === "text" && i.index === 0 && delta) {
      // Only the leading text block can stream before signed/interleaved blocks are complete.
      if (this.openMessage !== i.index) {
        this.closeMessage(); this.openMessage = i.index;
        this.emit("content_block_start", { index: i.index, content_block: { type: "text", text: "" } });
      }
      this.emit("content_block_delta", { index: i.index, delta: { type: "text_delta", text: delta } });
    } else if (this.protocol === "gemini" && delta && kind === "text" && i.index === 0) {
      // Later blocks can contain signatures or incomplete tool JSON. Keep them together and
      // ordered until complete, rather than moving tools/signatures behind subsequent text.
      this.gemini([{ text: delta }]);
    }
  }
  private messageBlocks(): Json[] {
    return this.items.flatMap((i): Json[] => {
      if (i.kind === "text") return [{ type: "text", text: i.text }];
      if (i.kind === "call") return this.incomplete() && !this.validArguments(i) ? [] : [{ type: "tool_use", id: i.callId, name: i.name, input: JSON.parse(i.text || "{}") }];
      const state = this.state(i);
      return i.text ? [{ type: "thinking", thinking: i.text, signature: state ?? "" }] : state ? [{ type: "redacted_thinking", data: state }] : [];
    });
  }
  result(): Json {
    // Validate tool arguments before any success terminal event is emitted.
    for (const i of this.items) if (i.kind === "call" && !this.incomplete()) JSON.parse(i.text || "{}");
    if (this.protocol === "responses") return this.response(this.stop === "length" || this.stop === "filter" ? "incomplete" : "completed");
    if (this.protocol === "messages") return { id: this.id, type: "message", role: "assistant", model: this.model, content: this.messageBlocks(), stop_reason: messageStop(this.stop), stop_sequence: null, usage: this.wireUsage() };
    if (this.protocol === "chat") {
      const thoughts = this.items.filter(i => i.kind === "reasoning");
      // Chat splits an assistant turn into content/reasoning/tool_calls and loses block order.
      // Signed upstream blocks must replay in their original order, so keep a source-bound
      // snapshot. This is routing metadata, not a signature or trust boundary of its own.
      const states = this.items.some(i => i.signature || i.encrypted) ? [packState(this.source, this.model, {
        protocol: this.outbound,
        replay: this.items.map(i => ({ kind: i.kind, text: i.text, ...(i.callId ? { callId: i.callId, name: i.name } : {}), ...(i.signature ? { signature: i.signature } : {}), ...(i.encrypted ? { encrypted: i.encrypted } : {}) })),
      })] : [];
      const calls = this.items.filter(i => i.kind === "call");
      return { id: this.id, object: "chat.completion", created: this.created, model: this.model, choices: [{ index: 0, message: { role: "assistant", content: this.items.filter(i => i.kind === "text").map(i => i.text).join(""), ...(thoughts.length ? { reasoning_content: thoughts.map(i => i.text).join("") } : {}), ...(states.length ? { provider_state: JSON.stringify(states) } : {}), ...(calls.length ? { tool_calls: calls.map(i => ({ id: i.callId, type: "function", function: { name: i.name, arguments: i.text || "{}" } })) } : {}) }, finish_reason: chatStop(this.stop) }], usage: this.wireUsage() };
    }
    return { candidates: [{ index: 0, content: { role: "model", parts: this.items.flatMap((i): Json[] => i.kind === "call" ? this.incomplete() && !this.validArguments(i) ? [] : [{ functionCall: { id: i.callId, name: i.name, args: JSON.parse(i.text || "{}") } }] : [{ text: i.text, ...(i.kind === "reasoning" ? { thought: true, ...(this.state(i) ? { thoughtSignature: this.state(i) } : {}) } : {}) }]) }, finishReason: this.stop === "length" ? "MAX_TOKENS" : this.stop === "filter" ? "SAFETY" : "STOP" }], usageMetadata: this.wireUsage(), modelVersion: this.model };
  }
  finish() {
    this.start();
    const result = this.result();
    if (this.protocol === "chat") {
      const state = result.choices[0].message.provider_state;
      if (state) this.chat({ provider_state: state });
      this.chat({}, chatStop(this.stop), this.wireUsage()); this.write?.("data: [DONE]\n\n");
    } else if (this.protocol === "responses") {
      for (const i of this.items) {
        const base = { item_id: i.id, output_index: i.index };
        if (i.kind === "text") {
          this.emit("response.output_text.done", { ...base, content_index: 0, text: i.text, logprobs: [] });
          this.emit("response.content_part.done", { ...base, content_index: 0, part: { type: "output_text", text: i.text, annotations: [], logprobs: [] } });
        } else if (i.kind === "reasoning") {
          this.emit("response.reasoning_summary_text.done", { ...base, summary_index: 0, text: i.text });
          this.emit("response.reasoning_summary_part.done", { ...base, summary_index: 0, part: { type: "summary_text", text: i.text } });
        } else if (this.spec(i)?.custom) {
          const input = this.customInput(i);
          this.emit("response.custom_tool_call_input.delta", { ...base, delta: input });
          this.emit("response.custom_tool_call_input.done", { ...base, input });
        } else this.emit("response.function_call_arguments.done", { ...base, arguments: i.text || "{}" });
        this.emit("response.output_item.done", { output_index: i.index, item: this.responseItem(i, true) });
      }
      this.emit("response." + result.status, { response: result });
    } else if (this.protocol === "messages") {
      this.closeMessage();
      for (const i of this.items) {
        if (i.kind === "text" && i.index === 0 && i.text) continue;
        if (i.kind === "call" && this.incomplete() && !this.validArguments(i)) continue;
        const state = this.state(i);
        const b = i.kind === "text" ? { type: "text", text: i.text } : i.kind === "call" ? { type: "tool_use", id: i.callId, name: i.name, input: {} } : i.text ? { type: "thinking", thinking: "" } : state ? { type: "redacted_thinking", data: state } : undefined;
        if (!b) continue;
        this.emit("content_block_start", { index: i.index, content_block: b });
        if (i.kind === "call") this.emit("content_block_delta", { index: i.index, delta: { type: "input_json_delta", partial_json: i.text || "{}" } });
        else if (i.kind === "reasoning" && i.text) {
          this.emit("content_block_delta", { index: i.index, delta: { type: "thinking_delta", thinking: i.text } });
          this.emit("content_block_delta", { index: i.index, delta: { type: "signature_delta", signature: state ?? "" } });
        }
        this.emit("content_block_stop", { index: i.index });
      }
      this.emit("message_delta", { delta: { stop_reason: messageStop(this.stop), stop_sequence: null }, usage: this.wireUsage() });
      this.emit("message_stop", {});
    } else {
      const parts = this.items.flatMap((i): Json[] => {
        if (i.kind === "text" && i.index === 0 && i.text) return [];
        if (i.kind === "call") return this.incomplete() && !this.validArguments(i) ? [] : [{ functionCall: { id: i.callId, name: i.name, args: JSON.parse(i.text || "{}") } }];
        return [{ text: i.text, ...(i.kind === "reasoning" ? { thought: true, ...(this.state(i) ? { thoughtSignature: this.state(i) } : {}) } : {}) }];
      });
      this.gemini(parts, this.stop === "length" ? "MAX_TOKENS" : this.stop === "filter" ? "SAFETY" : "STOP");
    }
  }
  fail(message: string) {
    if (this.protocol === "responses") this.emit("response.failed", { response: { id: this.id, object: "response", status: "failed", error: { code: "upstream_error", message } } });
    else if (this.protocol === "messages") this.emit("error", { error: { type: "api_error", message } });
    else this.emit("", { error: { message, type: "upstream_error", ...(this.protocol === "gemini" ? { code: 502, status: "UNAVAILABLE" } : {}) } });
  }
}
