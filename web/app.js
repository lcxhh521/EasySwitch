// EasySwitch console. Plain JS, no build step; talks only to the local core.
// Layout ideas from Magpie (agent rows, model picker, provider list, live routing,
// usage tiles) and opencodex (overview figures, status chips); see PROVENANCE.md.
"use strict";

const PANEL = new URLSearchParams(location.search).has("panel");
const BRIDGE = window.webkit?.messageHandlers?.easyswitch;
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const HARNESS = {
  codex: { name: "Codex", icon: "codex-color", protocol: "Responses" },
  claude: { name: "Claude Code", icon: "claudecode-color", protocol: "Anthropic Messages" },
};
const ROUTE = { "responses-native": "原样转发", "anthropic-native": "原样转发", "chat-translate": "协议转换" };
const TOOL_NAMES = { "tool:web_search": "网页搜索", "tool:namespace:multi_agent_v1": "子 agent 工具" };

let state = null;
let page = PANEL ? "agents" : (location.hash.slice(1) || "agents");
let usageRange = "7d";
let usage = null;
let openProvider = null;
let addForm = null; // { preset } while the add panel is open
let presets = [];
let popover = null;

// ---------------------------------------------------------------- helpers

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", "x-easyswitch": "1" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message ?? json.error ?? `HTTP ${res.status}`);
  return json;
}

function icon(name, cls = "") {
  const src = `icons/${name}.svg`;
  return name.endsWith("-color")
    ? `<img class="ic ${cls}" src="${src}" alt="">`
    : `<span class="ic mono ${cls}" style="--src:url(${src})"></span>`;
}

const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const compact = n => compactFmt.format(n ?? 0);
const thousands = n => (n ?? 0).toLocaleString("en-US");

function ago(at) {
  const s = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
  if (s < 10) return "刚刚";
  if (s < 60) return `${Math.floor(s)} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

function toast(text) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}

const providerById = id => state.providers.find(p => p.id === id);
const modelsOf = p => (p.models.length ? p.models : p.defaultModel ? [p.defaultModel] : []);
const sessionsOf = h => (state.sessionDetails ?? []).filter(s => s.harness === h);

function closePopover() {
  popover?.remove();
  popover = null;
}

function placePopover(el, anchor) {
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const left = Math.min(Math.max(12, r.right - w), window.innerWidth - w - 12);
  let top = r.bottom + 6;
  if (top + el.offsetHeight > window.innerHeight - 12) top = Math.max(12, r.top - el.offsetHeight - 6);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

// ---------------------------------------------------------------- header

function renderHeader() {
  for (const b of document.querySelectorAll("#nav button")) b.classList.toggle("on", b.dataset.page === page);
  $("#ver").textContent = state ? `v${state.version}` : "";
  const files = state?.native.filter(f => f.exists) ?? [];
  const clean = files.every(f => !f.mentionsEasySwitch);
  const chip = $("#guard-chip");
  chip.className = `chip ${state ? (clean ? "ok" : "bad") : "bad"}`;
  chip.innerHTML = state
    ? `<span class="dot"></span>${clean ? "原生配置未被改动" : "原生配置出现了 EasySwitch 痕迹"}`
    : `<span class="dot"></span>连不上核心服务`;
}

function openGuard(anchor) {
  closePopover();
  const el = document.createElement("div");
  el.className = "popover guard";
  el.innerHTML = `
    <div class="search"><b>原生配置</b><span class="hint">EasySwitch 承诺不碰这些文件；这里是它们的实时指纹</span></div>
    <table class="tbl"><tr><th>Agent</th><th>文件</th><th>指纹</th><th>EasySwitch 痕迹</th></tr>
    ${state.native.map(f => `<tr><td>${esc(f.harness)}</td><td class="mono">${esc(f.path)}</td>
      <td class="mono">${f.exists ? esc(f.sha256.slice(0, 12)) : "不存在"}</td>
      <td>${f.mentionsEasySwitch ? '<span class="chip bad">有</span>' : '<span class="chip ok">无</span>'}</td></tr>`).join("")}
    </table>`;
  document.body.append(el);
  placePopover(el, anchor);
  popover = el;
}

// ---------------------------------------------------------------- agents

function agentRow(harness) {
  const meta = HARNESS[harness];
  const binding = state.bindings?.[harness];
  const provider = binding && providerById(binding.providerId);
  const binary = harness === "codex" ? state.codexPath : state.claudePath;
  const sessions = sessionsOf(harness).length;
  const face = binding && provider
    ? `${icon(provider.icon)}<span class="label">${esc(binding.model)}<small>${esc(provider.name)}</small></span>`
    : `<span class="ic sm"></span><span class="label">原生<small>不经过 EasySwitch</small></span>`;
  const sub = !binary
    ? `没有找到 ${meta.name} 的命令`
    : binding ? `平时打开：原生 · 增强会话：${esc(binding.providerId)}/${esc(binding.model)}` : "平时打开：原生 · 选一个模型就能开增强会话";
  return `
    <div class="row" data-harness="${harness}">
      ${icon(meta.icon, "lg")}
      <div class="grow">
        <div class="title">${meta.name}${sessions ? `<button class="chip accent" data-go="sessions">${sessions} 个增强会话运行中</button>` : ""}</div>
        <div class="sub">${sub}</div>
      </div>
      <button class="popbtn" data-pick="${harness}" title="增强会话用哪个模型">${face}<span class="caret">▾</span></button>
      <button class="btn launch" data-launch="${harness}" ${binding && binary ? "" : "disabled"}>启动增强会话</button>
    </div>`;
}

function renderAgents() {
  const rows = Object.keys(HARNESS).map(agentRow).join("");
  if (PANEL) {
    return `
      <div class="card">${rows}</div>
      <div class="panel-foot">
        <button data-bridge="openConsole">打开控制台</button>
        <span>
          ${BRIDGE ? `<button data-bridge="backToNative">全部退回原生</button><button data-bridge="quit">退出</button>` : ""}
        </span>
      </div>`;
  }
  return `
    <div class="section-head"><h2>Agent</h2><span class="aside">每个 agent 平时都走原生；增强会话只在 EasySwitch 打开的终端窗口里生效</span></div>
    <div class="card">${rows}</div>
    <p class="hint">点模型选择框挑一个外接模型，再点「启动增强会话」。选「原生」就是不用 EasySwitch；你平时直接打开的 Codex 和 Claude Code 永远不受影响。</p>
    ${state.providers.length ? "" : `<div class="card empty">还没有模型来源。<button class="btn secondary" data-go="providers">去添加</button></div>`}`;
}

function openPicker(anchor, harness) {
  closePopover();
  const binding = state.bindings?.[harness];
  const el = document.createElement("div");
  el.className = "popover";
  el.innerHTML = `
    <div class="search"><span>🔍</span><input placeholder="搜索模型或来源…" autocomplete="off"></div>
    <div class="body"><div class="rail"></div><div class="list"></div></div>`;
  document.body.append(el);
  popover = el;
  let filter = "";
  let only = null;
  let kb = 0;
  const rail = el.querySelector(".rail");
  rail.innerHTML = `<button data-only="" class="on" title="全部">▦</button>` +
    state.providers.map(p => `<button data-only="${esc(p.id)}" title="${esc(p.name)}">${icon(p.icon)}</button>`).join("");

  const options = () => {
    const q = filter.trim().toLowerCase();
    const out = [];
    if (!only && (!q || "原生 native".includes(q))) out.push({ native: true });
    for (const p of state.providers) {
      if (only && p.id !== only) continue;
      const route = harness === "codex" ? p.route : p.messagesRoute ?? "chat-translate";
      for (const m of modelsOf(p)) {
        if (q && !m.toLowerCase().includes(q) && !p.name.toLowerCase().includes(q)) continue;
        out.push({ provider: p, model: m, route });
      }
    }
    return out;
  };

  const draw = () => {
    const opts = options();
    kb = Math.min(kb, Math.max(0, opts.length - 1));
    let lastGroup = null;
    el.querySelector(".list").innerHTML = opts.map((o, i) => {
      if (o.native) {
        const on = !binding;
        return `<button class="opt native ${i === kb ? "kb" : ""}" data-i="${i}">${icon(HARNESS[harness].icon)}
          <span class="name">原生</span><span class="meta">${HARNESS[harness].name} 自带的，不经过 EasySwitch</span><span class="tick">${on ? "✓" : ""}</span></button>`;
      }
      const head = o.provider.id !== lastGroup ? `<div class="group">${esc(o.provider.name)}</div>` : "";
      lastGroup = o.provider.id;
      const on = binding && binding.providerId === o.provider.id && binding.model === o.model;
      return `${head}<button class="opt ${i === kb ? "kb" : ""}" data-i="${i}">${icon(o.provider.icon)}
        <span class="name">${esc(o.model)}</span><span class="meta">${ROUTE[o.route]}</span><span class="tick">${on ? "✓" : ""}</span></button>`;
    }).join("") || `<div class="empty">没有匹配的模型</div>`;
    el.querySelector(".opt.kb")?.scrollIntoView({ block: "nearest" });
    return opts;
  };

  const choose = async o => {
    closePopover();
    try {
      if (o.native) {
        await call("DELETE", `/api/bindings/${harness}`);
        toast(`${HARNESS[harness].name}：增强会话已关闭，只用原生`);
      } else {
        await call("PUT", `/api/bindings/${harness}`, { providerId: o.provider.id, model: o.model });
        toast(`${HARNESS[harness].name} 的增强会话将使用 ${o.model}`);
      }
    } catch (error) {
      toast(error.message);
    }
    await refresh(true);
  };

  let opts = draw();
  placePopover(el, anchor);
  const input = el.querySelector("input");
  input.focus();
  input.addEventListener("input", () => { filter = input.value; kb = 0; opts = draw(); });
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown") { kb = Math.min(kb + 1, opts.length - 1); opts = draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { kb = Math.max(kb - 1, 0); opts = draw(); e.preventDefault(); }
    else if (e.key === "Enter" && opts[kb]) choose(opts[kb]);
    else if (e.key === "Escape") closePopover();
  });
  rail.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    only = b.dataset.only || null;
    for (const x of rail.children) x.classList.toggle("on", x === b);
    kb = 0;
    opts = draw();
  });
  el.querySelector(".list").addEventListener("click", e => {
    const b = e.target.closest(".opt");
    if (b) choose(opts[Number(b.dataset.i)]);
  });
}

// ---------------------------------------------------------------- providers

function providerRow(p) {
  const models = modelsOf(p);
  const used = p.usedBy.map(h => icon(HARNESS[h].icon, "sm")).join("");
  const open = openProvider === p.id;
  const checks = (p.probe?.checks ?? []).map(c => `
    <div class="check ${c.status}"><b>${esc(c.label)}</b>${esc(c.detail)}${c.latencyMs != null ? ` · ${c.latencyMs}ms` : ""}</div>`).join("");
  const options = models.map(m => `<option ${m === p.defaultModel ? "selected" : ""}>${esc(m)}</option>`).join("");
  const nextRoute = p.route === "chat-translate" ? "responses-native" : "chat-translate";
  const detail = open ? `
    <div class="detail" data-provider="${esc(p.id)}">
      <div class="controls">
        <span class="chip">Codex：${ROUTE[p.route]}${p.routePinned ? "（手动）" : p.probe ? "（自动）" : ""}</span>
        <span class="chip">Claude Code：${ROUTE[p.messagesRoute ?? "chat-translate"]}</span>
        <button class="btn secondary" data-route="${nextRoute}">Codex 改为${ROUTE[nextRoute]}</button>
        ${p.routePinned ? `<button class="btn secondary" data-route="auto">恢复自动</button>` : ""}
      </div>
      <div class="controls">
        <label class="hint">测试用模型</label>
        <select class="probe-model">${options || "<option value=''>（没有可选模型）</option>"}</select>
        <button class="btn" data-probe>一致性测试</button>
        <span class="hint">${p.probe ? `上次测试：${ago(p.probe.at)}` : "还没测过"}</span>
      </div>
      ${checks ? `<div class="checks">${checks}</div>` : ""}
      <div class="hint">OpenAI 兼容地址：<span class="mono">${esc(p.baseUrl)}</span>${p.anthropicBaseUrl ? ` · Anthropic 地址：<span class="mono">${esc(p.anthropicBaseUrl)}</span>` : ""}</div>
      <div><button class="btn danger" data-remove>删除这个来源</button></div>
    </div>` : "";
  return `
    <div class="row clickable ${open ? "open" : ""}" data-toggle="${esc(p.id)}">
      ${icon(p.icon, "lg")}
      <div class="grow"><div class="title">${esc(p.name)}</div><div class="sub">${esc(hostOf(p.baseUrl))} · ${models.length} 个模型</div></div>
      ${used ? `<span title="正在使用的 agent">${used}</span>` : ""}
      <span class="chip ${p.hasKey ? "ok" : "warn"}"><span class="dot"></span>${p.hasKey ? "Key 在钥匙串" : "未设置 Key"}</span>
      <span class="chev">›</span>
    </div>${detail}`;
}

function renderAddForm() {
  const preset = addForm.preset;
  return `
    <div class="presets">${presets.map(x => `
      <button class="preset ${preset?.id === x.id ? "on" : ""}" data-preset="${esc(x.id)}">${icon(x.icon, "lg")}<span>${esc(x.name)}</span></button>`).join("")}
    </div>
    <form class="form" id="add-form">
      <div class="field"><label>名称</label><input type="text" name="name" required value="${esc(preset && preset.id !== "relay" ? preset.name : "")}" placeholder="例如：我的中转站"></div>
      <div class="field"><label>OpenAI 兼容地址</label><input type="url" name="baseUrl" required value="${esc(preset?.baseUrl ?? "")}" placeholder="https://relay.example.com/v1"></div>
      <div class="field"><label>Anthropic 地址（可选，给 Claude Code 原样转发用）</label><input type="url" name="anthropicBaseUrl" value="${esc(preset?.anthropicBaseUrl ?? "")}" placeholder="不填就用上面的地址"></div>
      <div class="field"><label>API Key（存进 macOS 钥匙串）${preset?.keyUrl ? ` · <a href="${esc(preset.keyUrl)}" target="_blank" rel="noopener">去哪里拿 Key</a>` : ""}</label><input type="password" name="apiKey" autocomplete="off"></div>
      <div class="controls"><button class="btn" type="submit">添加并测试</button><button class="btn secondary" type="button" data-cancel-add>取消</button></div>
      <p class="msg" id="add-msg"></p>
    </form>`;
}

function renderProviders() {
  return `
    <div class="section-head"><h2>模型来源</h2><span class="aside">中转站、官方 API、本地模型都可以；加进来先自动测一遍</span></div>
    <div class="card">
      ${state.providers.map(providerRow).join("") || `<div class="empty">还没有模型来源</div>`}
      ${addForm ? renderAddForm() : `<button class="add-row" data-add>＋ 添加模型来源</button>`}
    </div>`;
}

async function submitAdd(form) {
  const data = Object.fromEntries(new FormData(form));
  const msg = $("#add-msg");
  msg.className = "msg";
  msg.textContent = "正在添加并读取模型列表…";
  try {
    const p = await call("POST", "/api/providers", data);
    const want = addForm.preset?.defaultModel;
    const model = want && p.models.includes(want) ? want : p.models.length === 1 ? p.models[0] : null;
    addForm = null;
    openProvider = p.id;
    if (model) {
      toast(`已添加「${p.name}」，正在用 ${model} 做一致性测试…`);
      await call("POST", `/api/providers/${p.id}/probe`, { model });
    } else {
      toast(`已添加「${p.name}」，读到 ${p.models.length} 个模型；选一个做一致性测试`);
    }
  } catch (error) {
    msg.className = "msg bad";
    msg.textContent = error.message;
    return;
  }
  await refresh(true);
}

// ---------------------------------------------------------------- sessions

function explain(e) {
  const harness = HARNESS[e.harness ?? "codex"];
  const provider = providerById(e.providerId ?? e.model.split("/")[0]);
  const pname = provider?.name ?? e.providerId ?? "未知来源";
  const parts = [];
  if (e.route === "chat-translate") parts.push(`这个来源不支持 ${harness.protocol} 协议，EasySwitch 把请求翻译成 Chat 协议转发`);
  else parts.push(`这个来源原生支持 ${harness.protocol} 协议，请求原样转发`);
  if (e.dropped?.length) parts.push(`去掉了${e.dropped.map(d => TOOL_NAMES[d] ?? d.replace(/^tool:/, "")).join("、")}（Chat 协议里没有对应的工具）`);
  if (e.note) parts.push(e.note);
  if (e.inputTokens != null || e.outputTokens != null) {
    parts.push(`输入 ${thousands(e.inputTokens)} / 输出 ${thousands(e.outputTokens)} tokens${e.cachedTokens ? `，其中 ${thousands(e.cachedTokens)} 命中缓存` : ""}`);
  }
  const ok = e.status < 400;
  return {
    title: `${harness.name} → ${esc(pname)}<span class="mono" style="margin-left:6px">${esc(e.model.split("/").slice(1).join("/"))}</span> ${ok ? "" : `<span class="chip bad">失败 ${e.status}</span>`}`,
    why: `${parts.join("；")}。耗时 ${e.ms}ms。`,
  };
}

function renderSessions() {
  const now = Date.now();
  const recent = state.log.filter(e => now - new Date(e.at).getTime() < 120_000);
  const live = state.log.filter(e => now - new Date(e.at).getTime() < 30_000);
  const agentActive = h => sessionsOf(h).length > 0 || live.some(e => (e.harness ?? "codex") === h);
  const providerIds = [...new Set([
    ...Object.values(state.bindings ?? {}).filter(Boolean).map(b => b.providerId),
    ...recent.map(e => e.providerId ?? e.model.split("/")[0]),
  ])].filter(id => providerById(id));
  const providerNode = id => {
    const p = providerById(id);
    const last = state.log.find(e => (e.providerId ?? e.model.split("/")[0]) === id);
    const isLive = live.some(e => (e.providerId ?? e.model.split("/")[0]) === id);
    const status = !last ? "还没有请求" : last.status >= 400 ? `失败 · ${ago(last.at)}` : `${ago(last.at)}回答过`;
    return `<div class="node ${isLive ? "active" : "idle"}" data-node="p:${esc(id)}">${icon(p.icon, "lg")}
      <div><div class="t">${esc(p.name)}</div><div class="s">${esc(status)}</div></div></div>`;
  };
  const running = state.sessionDetails ?? [];
  return `
    <div class="section-head"><h2>会话</h2><span class="aside"><span class="chip ok"><span class="dot"></span>实时</span></span></div>
    <div class="card"><div class="flow" id="flow">
      <svg id="flow-lines"></svg>
      <div class="col">${Object.keys(HARNESS).map(h => `
        <div class="node ${agentActive(h) ? "active" : "idle"}" data-node="a:${h}">${icon(HARNESS[h].icon, "lg")}
          <div><div class="t">${HARNESS[h].name}</div><div class="s">${sessionsOf(h).length ? `${sessionsOf(h).length} 个增强会话` : "原生"}</div></div></div>`).join("")}
      </div>
      <div class="col"><div class="node hub" data-node="hub"><span class="logo">⇄</span><div class="t">EasySwitch</div><div class="s">127.0.0.1:${state.port}</div></div></div>
      <div class="col">${providerIds.map(providerNode).join("") || `<div class="hint">还没有用到任何模型来源</div>`}</div>
    </div></div>

    <div class="section-head"><h2>运行中的增强会话</h2></div>
    <div class="card">${running.length ? `<table class="tbl"><tr><th>Agent</th><th>模型</th><th>启动于</th><th>进程</th><th></th></tr>
      ${running.map(s => `<tr><td>${icon(HARNESS[s.harness].icon, "sm")} ${HARNESS[s.harness].name}</td><td class="mono">${esc(s.model ?? "")}</td>
        <td>${s.startedAt ? ago(s.startedAt) : "—"}</td><td class="mono">${s.pid}</td>
        <td class="num"><button class="btn secondary" data-stop="${s.pid}">结束</button></td></tr>`).join("")}</table>`
      : `<div class="empty">没有运行中的增强会话；你的 agent 都在走原生</div>`}</div>

    <div class="section-head"><h2>最近的请求是怎么走的</h2></div>
    <div class="card events">${state.log.length ? state.log.slice(0, 30).map(e => {
      const x = explain(e);
      return `<div class="event"><div class="when">${new Date(e.at).toLocaleTimeString()}</div><div class="what"><div>${x.title}</div><div class="why">${x.why}</div></div></div>`;
    }).join("") : `<div class="empty">还没有请求</div>`}</div>`;
}

function drawFlowLines() {
  const flow = $("#flow");
  const svg = $("#flow-lines");
  if (!flow || !svg) return;
  const box = flow.getBoundingClientRect();
  const at = (sel, side) => {
    const r = flow.querySelector(`[data-node="${sel}"]`)?.getBoundingClientRect();
    return r ? { x: (side === "right" ? r.right : r.left) - box.left, y: r.top + r.height / 2 - box.top } : null;
  };
  const curve = (a, b, live) => a && b
    ? `<path class="${live ? "live" : ""}" d="M${a.x},${a.y} C${(a.x + b.x) / 2},${a.y} ${(a.x + b.x) / 2},${b.y} ${b.x},${b.y}"/>` : "";
  const now = Date.now();
  const isLive = e => now - new Date(e.at).getTime() < 30_000;
  let paths = "";
  for (const h of Object.keys(HARNESS)) {
    const live = sessionsOf(h).length > 0 || state.log.some(e => (e.harness ?? "codex") === h && isLive(e));
    if (live || state.bindings?.[h]) paths += curve(at(`a:${h}`, "right"), at("hub", "left"), live);
  }
  for (const node of flow.querySelectorAll('[data-node^="p:"]')) {
    const id = node.dataset.node.slice(2);
    const live = state.log.some(e => (e.providerId ?? e.model.split("/")[0]) === id && isLive(e));
    paths += curve(at("hub", "right"), at(`p:${id}`, "left"), live);
  }
  svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
  svg.innerHTML = paths;
}

// ---------------------------------------------------------------- usage

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map(m => m * p).find(m => m >= v);
}

function barPath(x, y, w, h) {
  const r = Math.min(4, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function drawChart() {
  const host = $("#chart");
  if (!host || !usage) return;
  const days = usage.days;
  const values = days.map(d => d.inputTokens + d.outputTokens);
  const W = host.clientWidth - 36, H = 200, left = 46, bottom = 22, top = 8;
  const plotW = W - left, plotH = H - bottom - top;
  const max = niceMax(Math.max(...values, 0));
  const slot = plotW / Math.max(days.length, 1);
  const bw = Math.min(24, slot * 0.62);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => max * f);
  const y = v => top + plotH - (v / max) * plotH;
  const labelEvery = Math.max(1, Math.ceil(days.length / 7));
  const svg = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="每日 token 用量柱状图">
      <g class="grid">${ticks.map(t => `<line x1="${left}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/>`).join("")}</g>
      <g class="axis">${ticks.map(t => `<text x="${left - 8}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`).join("")}
        ${days.map((d, i) => i % labelEvery === 0 ? `<text x="${left + slot * i + slot / 2}" y="${H - 4}" text-anchor="middle">${d.day.slice(5).replace("-", "/")}</text>` : "").join("")}</g>
      ${values.map((v, i) => v > 0 ? `<path class="bar" d="${barPath(left + slot * i + (slot - bw) / 2, y(v), bw, top + plotH - y(v))}"/>` : "").join("")}
      ${days.map((d, i) => `<rect class="bar-hit" data-i="${i}" x="${left + slot * i}" y="${top}" width="${slot}" height="${plotH}"/>`).join("")}
    </svg>`;
  host.innerHTML = `${svg}${values.every(v => v === 0) ? `<div class="empty" style="position:absolute;inset:0;display:grid;place-items:center">这段时间还没有用量</div>` : ""}`;
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  host.append(tip);
  host.querySelector("svg").addEventListener("mousemove", e => {
    const hit = e.target.closest(".bar-hit");
    if (!hit) { tip.hidden = true; return; }
    const d = days[Number(hit.dataset.i)];
    tip.innerHTML = `<b>${d.day}</b><br>${thousands(d.inputTokens + d.outputTokens)} tokens · ${d.calls} 次调用`;
    const hb = host.getBoundingClientRect();
    tip.style.left = `${e.clientX - hb.left}px`;
    tip.style.top = `${e.clientY - hb.top - 10}px`;
    tip.hidden = false;
  });
  host.querySelector("svg").addEventListener("mouseleave", () => { tip.hidden = true; });
}

function renderUsage() {
  if (!usage) return `<div class="card empty">正在读取用量…</div>`;
  const t = usage.totals;
  const hit = usage.cacheHitRate == null ? "—" : `${Math.round(usage.cacheHitRate * 100)}%`;
  const ranges = { today: "今天", "7d": "7 天", "30d": "30 天", all: "全部" };
  const providerRows = Object.entries(usage.byProvider).sort((a, b) => b[1].calls - a[1].calls).map(([id, v]) => {
    const p = providerById(id);
    return `<tr><td>${p ? icon(p.icon, "sm") : ""} ${esc(p?.name ?? id)}</td><td class="num">${thousands(v.calls)}</td>
      <td class="num">${compact(v.inputTokens)}</td><td class="num">${compact(v.outputTokens)}</td>
      <td class="num">${v.inputTokens ? `${Math.round((v.cachedTokens / v.inputTokens) * 100)}%` : "—"}</td><td class="num">${v.errors}</td></tr>`;
  }).join("");
  const harnessRows = Object.entries(usage.byHarness).map(([h, v]) => `
    <tr><td>${icon(HARNESS[h]?.icon ?? "newapi-color", "sm")} ${HARNESS[h]?.name ?? esc(h)}</td><td class="num">${thousands(v.calls)}</td>
      <td class="num">${compact(v.inputTokens)}</td><td class="num">${compact(v.outputTokens)}</td><td class="num">${v.errors}</td></tr>`).join("");
  return `
    <div class="section-head"><h2>用量</h2>
      <nav class="seg" id="range">${Object.entries(ranges).map(([k, v]) => `<button data-range="${k}" class="${usageRange === k ? "on" : ""}">${v}</button>`).join("")}</nav>
    </div>
    <div class="card tiles">
      <div class="tile"><div class="v">${compact(t.inputTokens + t.outputTokens)}</div><div class="l">Token</div><div class="d">输入 ${compact(t.inputTokens)} · 输出 ${compact(t.outputTokens)}</div></div>
      <div class="tile"><div class="v">${compact(t.cachedTokens)}</div><div class="l">缓存读取</div><div class="d">命中率 ${hit}</div></div>
      <div class="tile"><div class="v">${thousands(t.calls)}</div><div class="l">调用次数</div><div class="d">${t.unmetered ? `${t.unmetered} 次原样转发未计量` : "全部已计量"}</div></div>
      <div class="tile"><div class="v">${thousands(t.errors)}</div><div class="l">失败</div><div class="d">${t.calls ? `占 ${Math.round((t.errors / t.calls) * 100)}%` : "—"}</div></div>
    </div>
    <div class="card"><div class="chart" id="chart"></div>
      <details style="padding:0 18px 12px"><summary class="hint">查看每日数据表</summary>
        <table class="tbl"><tr><th>日期</th><th class="num">输入</th><th class="num">输出</th><th class="num">调用</th></tr>
        ${usage.days.map(d => `<tr><td>${d.day}</td><td class="num">${thousands(d.inputTokens)}</td><td class="num">${thousands(d.outputTokens)}</td><td class="num">${d.calls}</td></tr>`).join("")}</table>
      </details>
    </div>
    <div class="section-head"><h2>按模型来源</h2></div>
    <div class="card">${providerRows ? `<table class="tbl"><tr><th>来源</th><th class="num">调用</th><th class="num">输入</th><th class="num">输出</th><th class="num">缓存命中</th><th class="num">失败</th></tr>${providerRows}</table>` : `<div class="empty">还没有用量</div>`}</div>
    <div class="section-head"><h2>按 Agent</h2></div>
    <div class="card">${harnessRows ? `<table class="tbl"><tr><th>Agent</th><th class="num">调用</th><th class="num">输入</th><th class="num">输出</th><th class="num">失败</th></tr>${harnessRows}</table>` : `<div class="empty">还没有用量</div>`}</div>`;
}

async function loadUsage() {
  try { usage = await call("GET", `/api/usage?range=${usageRange}`); } catch { usage = null; }
}

// ---------------------------------------------------------------- render loop

function render() {
  renderHeader();
  const main = $("#page");
  if (!state) {
    main.innerHTML = `<div class="card empty">连不上 EasySwitch 核心服务。从菜单栏启动它，或在终端运行 <code>node core/src/main.ts</code>。</div>`;
    return;
  }
  const views = { agents: renderAgents, providers: renderProviders, sessions: renderSessions, usage: renderUsage };
  main.innerHTML = (views[page] ?? renderAgents)();
  if (page === "sessions") requestAnimationFrame(drawFlowLines);
  if (page === "usage") requestAnimationFrame(drawChart);
}

/** Re-render unless the user is in the middle of something we would wipe out. */
function busy() {
  return popover || addForm || document.activeElement?.matches("input, select, textarea");
}

async function refresh(force = false) {
  try {
    state = await call("GET", "/api/state");
  } catch {
    state = null;
  }
  if (page === "usage" && (force || !usage)) await loadUsage();
  if (force || !busy()) render();
  else renderHeader();
}

// ---------------------------------------------------------------- events

document.addEventListener("click", async e => {
  const t = e.target;
  if (popover && !popover.contains(t) && !t.closest("[data-pick], #guard-chip")) closePopover();

  const nav = t.closest("#nav button, [data-go]");
  if (nav) {
    page = nav.dataset.page ?? nav.dataset.go;
    if (!PANEL) history.replaceState(null, "", `#${page}`);
    closePopover();
    if (page === "usage") await loadUsage();
    render();
    return;
  }
  if (t.closest("#refresh")) { await refresh(true); toast("已刷新"); return; }
  if (t.closest("#guard-chip")) { if (popover) closePopover(); else if (state) openGuard($("#guard-chip")); return; }

  const pick = t.closest("[data-pick]");
  if (pick) { if (popover) closePopover(); else openPicker(pick, pick.dataset.pick); return; }

  const launch = t.closest("[data-launch]");
  if (launch) {
    launch.disabled = true;
    try {
      const { model } = await call("POST", `/api/launch/${launch.dataset.launch}`);
      toast(`已在终端里打开 ${HARNESS[launch.dataset.launch].name} 增强会话（${model}）`);
    } catch (error) { toast(error.message); }
    setTimeout(() => refresh(true), 1500);
    return;
  }

  const bridge = t.closest("[data-bridge]");
  if (bridge) {
    if (BRIDGE) BRIDGE.postMessage(bridge.dataset.bridge);
    else if (bridge.dataset.bridge === "openConsole") window.open("/", "_blank");
    return;
  }

  const range = t.closest("[data-range]");
  if (range) { usageRange = range.dataset.range; await loadUsage(); render(); return; }

  const stop = t.closest("[data-stop]");
  if (stop) {
    try { await call("POST", `/api/sessions/${stop.dataset.stop}/stop`); toast("已结束这个增强会话"); } catch (error) { toast(error.message); }
    setTimeout(() => refresh(true), 800);
    return;
  }

  if (t.closest("[data-add]")) {
    if (!presets.length) presets = await call("GET", "/api/presets").catch(() => []);
    addForm = { preset: null };
    render();
    return;
  }
  const preset = t.closest("[data-preset]");
  if (preset) { addForm = { preset: presets.find(x => x.id === preset.dataset.preset) }; render(); return; }
  if (t.closest("[data-cancel-add]")) { addForm = null; render(); return; }

  const detail = t.closest(".detail");
  if (detail) {
    const id = detail.dataset.provider;
    const button = t.closest("button");
    if (!button) return;
    button.disabled = true;
    try {
      if (button.hasAttribute("data-probe")) {
        button.textContent = "测试中…";
        await call("POST", `/api/providers/${id}/probe`, { model: detail.querySelector(".probe-model").value });
      } else if (button.dataset.route) {
        await call("POST", `/api/providers/${id}/route`, { route: button.dataset.route === "auto" ? null : button.dataset.route });
      } else if (button.hasAttribute("data-remove")) {
        if (!window.confirm("删除这个模型来源？钥匙串里的 Key 也会一起删除。")) { button.disabled = false; return; }
        await call("DELETE", `/api/providers/${id}`);
        openProvider = null;
      }
    } catch (error) { toast(error.message); }
    await refresh(true);
    return;
  }

  const toggle = t.closest("[data-toggle]");
  if (toggle) { openProvider = openProvider === toggle.dataset.toggle ? null : toggle.dataset.toggle; render(); }
});

document.addEventListener("submit", e => {
  if (e.target.id === "add-form") { e.preventDefault(); submitAdd(e.target); }
});
document.addEventListener("keydown", e => { if (e.key === "Escape") closePopover(); });
window.addEventListener("resize", () => { if (page === "sessions") drawFlowLines(); if (page === "usage") drawChart(); });

if (PANEL) document.body.classList.add("panel");
if (PANEL) {
  $("#nav").remove();
  $("#refresh").remove();
}
refresh(true);
setInterval(() => refresh(), 3000);
