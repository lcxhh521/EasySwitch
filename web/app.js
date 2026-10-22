// EasySwitch console. Plain JS, no build step; talks only to the local core.
// Layout ideas from Magpie (agent rows, model picker, provider list, live routing,
// usage tiles) and opencodex (overview figures, status chips); see PROVENANCE.md.
"use strict";

const PANEL = new URLSearchParams(location.search).has("panel");
const BRIDGE = window.webkit?.messageHandlers?.easyswitch;
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const HARNESS = {
  codex: { name: "ChatGPT", icon: "openai", protocol: "Responses" },
  claude: { name: "Claude Code", icon: "claudecode-color", protocol: "Anthropic Messages" },
};
const ROUTE = { "responses-native": "原样转发", "anthropic-native": "原样转发", "chat-translate": "协议转换", pool: "按池里的顺序", "pool-automatic": "仅纯文字试用；工具请求拒绝（已确认名单）" };
const TOOL_NAMES = { "tool:web_search": "网页搜索", "tool:namespace:multi_agent_v1": "子 agent 工具" };

let state = null;
const PAGE_META = {agents:["Agent","为每个工具选择合适的模型"],providers:["模型","管理来源、订阅与模型池"],usage:["用量","查看已记录用量与估算费用"],sessions:["会话记录","查看连接与实际模型线路"],doctor:["自检","检查运行状态，找到下一步"],settings:["设置","外观与本机订阅账号"]};
function pageOf(value) { return value === "accounts" ? "settings" : Object.hasOwn(PAGE_META,value) ? value : "agents"; }
// Bookmarks for removed or renamed pages always resolve to a supported route.
function pageFromHash() {
  const requested = location.hash.slice(1);
  const next = pageOf(requested);
  if (requested && requested !== next) history.replaceState(null, "", `#${next}`);
  return next;
}
let page = PANEL ? "agents" : pageFromHash();
let usageRange = "7d";
let chartMetric = "tokens"; // "tokens" | "cost"
let usage = null;
const usageRanges = { today: "今天", "7d": "7 天", "30d": "30 天", all: "已有记录" };
let usageRequest = null; // One cancellable, bounded GET for the visible range.
let usageError = "";
let openProvider = null;
let addForm = null; // { preset } while the add panel is open
let chatgptInfo = null; // /api/chatgpt: installed, running, enhanced
let chatgptConfirm = null; // "enhance" | "native" while the restart notice is open
let claudeDesktopInfo = null;
let claudeDesktopConfirm = false;
let claudeDesktopBusy = false;
let claudeDesktopModel = "";
let claudeDesktopError = "";
/** Which collapsible panels the user opened; the page redraws every few seconds and must not close them. */
const openDetails = new Set();
const keepOpen = id => (openDetails.has(id) ? "open" : "");

let pageNavigationVersion = 0; // A response must not override newer user navigation.
let agentList = null; // every agent we know of, from /api/agents
let agentCoverage = null; // { coverage, features } from the same call: what is done for which agent
async function loadAgents() {
  const r = await call("GET", "/api/agents").catch(() => null);
  if (!r) return null;
  agentCoverage = { coverage: r.coverage ?? [], features: r.features ?? [] };
  return r.agents;
}

const CAP_STATE = {
  verified: { label: "已实测", cls: "ok", dot: "●" },
  documented: { label: "按文档做了，未实测", cls: "doc", dot: "◐" },
  manual: { label: "手动配置", cls: "man", dot: "◆" },
  impossible: { label: "做不了", cls: "no", dot: "✕" },
  todo: { label: "还没做", cls: "todo", dot: "○" },
  na: { label: "不适用", cls: "na", dot: "·" },
};

/** One small dot per feature under an agent's name; hover for the state and the reason. */
function capStrip(a) {
  if (!a.caps || !agentCoverage) return "";
  return `<div class="caps">${agentCoverage.features.map(f => {
    const c = a.caps[f.id];
    const st = CAP_STATE[c.state];
    return `<span class="cap ${st.cls}" title="${esc(f.label)}：${esc(st.label)}${c.note ? ` — ${esc(c.note)}` : ""}">${st.dot}</span>`;
  }).join("")}</div>`;
}

/** The whole picture: every agent against every feature, so nothing hides behind the one or two that work. */
function coverageCard() {
  if (!agentList || !agentCoverage?.features.length) return "";
  const feats = agentCoverage.features;
  const summary = agentCoverage.coverage.map(r => `<div class="tile"><div class="v">${r.settled}<small>/${r.applies}</small></div><div class="l">${esc(r.label)}</div><div class="d">实测 ${r.counts.verified} · 按文档 ${r.counts.documented} · 做不了 ${r.counts.impossible} · <b>没做 ${r.counts.todo}</b></div></div>`).join("");
  const cell = (a, f) => {
    const c = a.caps[f.id];
    const st = CAP_STATE[c.state];
    return `<td><span class="chip cap-${st.cls}" title="${esc(c.note ?? st.label)}">${st.label.replace("按文档做了，未实测", "按文档").replace("手动配置", "手动")}</span></td>`;
  };
  return `
    <details class="card" data-keep="coverage" ${keepOpen("coverage")} style="margin-top:12px">
      <summary class="row" style="cursor:pointer"><span class="grow title">覆盖情况：每个功能在每个 agent 上做到哪了</span><span class="hint">已定 = 已做或明确做不了；「没做」是欠的账</span></summary>
      <div class="tiles" style="grid-template-columns:repeat(3,1fr)">${summary}</div>
      <div style="overflow-x:auto"><table class="tbl"><tr><th>Agent</th>${feats.map(f => `<th title="${esc(f.hint)}">${esc(f.label)}</th>`).join("")}</tr>
        ${agentList.map(a => `<tr><td>${icon(a.icon, "sm")} ${esc(a.name)}</td>${feats.map(f => cell(a, f)).join("")}</tr>`).join("")}</table></div>
    </details>`;
}
let presets = [];
let popover = null;

// ---------------------------------------------------------------- helpers

function errorPresentation(error, context = "local") {
  return globalThis.EasySwitchErrors?.humanError(error, { context }) ?? { code: "unknown_error", title: "这次操作没有完成", reason: "请检查连接和设置后重试", action: {label:"查看控制台",target:"agents"}, message:"这次操作没有完成。请检查连接和设置后重试；到控制台查看相关设置。", details:{code:"unknown_error"} };
}
function userErrorMessage(error, context) { return error?.userError?.message ?? errorPresentation(error, context).message; }
function showError(error, context) {
  const view = error?.userError ?? errorPresentation(error, context);
  toast(view.message, view);
}
async function call(method, path, body, options = {}) {
  const context = /budget/.test(path) ? "budget" : /providers|plan|signin|vertex|kiro|kimi|cursor|antigravity/.test(path) ? "source" : /launch|command/.test(path) ? "launch" : /gateway\/sessions/.test(path) ? "session" : "local";
  let res;
  try { res = await fetch(path, { method, redirect: "error", ...(options.signal ? {signal:options.signal} : {}), headers: { "content-type": "application/json", "x-easyswitch": "1" }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
  catch (failure) { const view=errorPresentation(failure,context);throw Object.assign(new Error(view.message),{code:view.code,userError:view}); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Rebuild from the registered code, never trust arbitrary server prose/details as display HTML.
    const view = errorPresentation({ ...json, ...(json.uiError?.code ? {code:json.uiError.code} : {}), status:res.status }, context);
    throw Object.assign(new Error(view.message), { code:view.code, status:res.status, userError:view });
  }
  return json;
}

let monoIcons = null; // Set of single-colour icon names, once icons/manifest.json is loaded

function icon(name, cls = "") {
  // Source metadata must never become an attribute, CSS URL, or event handler.
  if (typeof name !== "string" || (!name.startsWith("letter:") && !/^[a-z0-9][a-z0-9-]*$/.test(name))) name = "letter:?";
  if (typeof cls !== "string" || !/^[a-z0-9 -]*$/i.test(cls)) cls = "";
  if (name.startsWith("letter:")) {
    const letter = name.slice(7);
    // Same letter, same colour; different letters land on different hues.
    const hue = [...letter].reduce((h, c) => (h * 31 + c.codePointAt(0)) % 360, 7);
    return `<span class="ic letter ${cls}" style="--h:${hue}">${esc(letter)}</span>`;
  }
  const src = `icons/${name}.svg`;
  // The manifest (scripts/icon-manifest.mjs) says by content which icons are single-colour.
  const mono = monoIcons ? monoIcons.has(name) : !name.endsWith("-color");
  return mono
    ? `<span class="ic mono ${cls}" style="--src:url(${src})"></span>`
    : `<img class="ic ${cls}" src="${src}" alt="">`;
}

/** Money in the user's chosen currency; USD is what prices are kept in, CNY uses their own rate. */
function money(usd, digits) {
  const d = state?.display ?? { currency: "USD", usdToCny: 7.2 };
  const cny = d.currency === "CNY";
  const v = usd * (cny ? d.usdToCny : 1);
  const sign = cny ? "¥" : "$";
  const places = digits ?? (v >= 100 ? 0 : v >= 1 ? 2 : v > 0 ? 3 : 2);
  return `${sign}${v.toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places })}`;
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

/** "约 3 小时后" for a time ahead of now. */
function inFuture(at) {
  const s = Math.max(0, (new Date(at).getTime() - Date.now()) / 1000);
  if (s < 90) return "1 分钟内";
  if (s < 3600) return `约 ${Math.round(s / 60)} 分钟后`;
  if (s < 86400) return `约 ${Math.round(s / 3600)} 小时后`;
  return `约 ${Math.round(s / 86400)} 天后`;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

function toast(text, problem) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  if (problem) {
    const action = document.createElement("button"); action.className="btn secondary";action.textContent=problem.action.label;
    action.addEventListener("click", async()=>{if(problem.action.target!=="current")await navigatePage(problem.action.target);el.remove();});el.append(action);
    const detail=document.createElement("details"),summary=document.createElement("summary"),code=document.createElement("pre");summary.textContent="详情";code.textContent=JSON.stringify(problem.details,null,2);detail.append(summary,code);el.append(detail);
    const close=document.createElement("button");close.textContent="关闭";close.addEventListener("click",()=>el.remove());el.append(close);
  }
  document.body.append(el);
  if (!problem) setTimeout(() => el.remove(), 2600);
}

/** Name and icon of any agent: the two built-in rows, or an entry of the wider catalog. */
function agentMeta(id) {
  return HARNESS[id] ?? agentList?.find(a => a.id === id) ?? { name: id, icon: `letter:${id[0]?.toUpperCase() ?? "?"}` };
}

const POOL_PROVIDER = { id: "pool", name: "模型池", icon: "letter:池", models: [] };
const providerById = id => (id === "pool" ? POOL_PROVIDER : state?.providers?.find(p => p.id === id));
const modelsOf = p => (Array.isArray(p?.models) && p.models.length ? p.models : p?.defaultModel ? [p.defaultModel] : []);
const sessionsOf = h => (state.sessionDetails ?? []).filter(s => s.harness === h);

/** The server's catalog is configuration eligibility, not a health/probe result. */
function selectableModelNames() {
  if (Array.isArray(state?.selectableModels)) return state.selectableModels;
  // Compatibility with an older state response, using the same catalog rules.
  const direct = (state?.providers ?? []).filter(p => !p.off && !p.budgetStatus?.blocked && p.cliTextBridge?.kind !== "droid")
    .flatMap(p => modelsOf(p).map(m => `${p.id}/${m}`));
  const have = new Set(direct);
  return [...direct, ...(state?.pools ?? []).filter(p => (p.members ?? p.live ?? []).some(m => have.has(m))).map(p => `pool/${p.id}`)];
}
function modelSelectionReason(name) {
  if (!name || selectableModelNames().includes(name)) return "";
  const slash = name.indexOf("/"), id = name.slice(0, slash);
  if (id === "pool") return (state?.pools ?? []).some(p => p.id === name.slice(slash + 1)) ? "模型池没有可选择的成员" : "模型池已不存在";
  const p = providerById(id);
  if (!p) return "模型来源已不存在";
  if (p.off) return "来源已关闭";
  if (p.budgetStatus?.blocked) return "来源预算阻断，请检查预算和记账状态";
  if (p.cliTextBridge?.kind === "droid") return "此文字桥暂未支持使用";
  return "模型未列入当前目录";
}
function savedModelNotice(name) {
  const reason = modelSelectionReason(name);
  return reason ? `<small class="hint">已保留：${esc(reason)}</small>` : "";
}
/** A stale saved/draft value stays selected; choosing the blank option is explicit. */
function savedModelOption(name, names) {
  return name && !names.includes(name) ? `<option value="${esc(name)}" selected disabled>${esc(name)}（已保留：${esc(modelSelectionReason(name) || "此处不能选择该模型")}）</option>` : "";
}

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
  for (const b of document.querySelectorAll("#nav button")) { const active=b.dataset.page===page;b.classList.toggle("on",active);if(active)b.setAttribute?.("aria-current","page");else b.removeAttribute?.("aria-current"); }
  const meta=PAGE_META[page]??PAGE_META.agents;
  if($("#page-title"))$("#page-title").textContent=meta[0];
  if($("#page-caption"))$("#page-caption").textContent=meta[1];
  $("#ver").textContent = state ? `v${state.version}` : "";
  const files = state?.native?.filter(f => f.exists) ?? [];
  const clean = files.every(f => !f.mentionsEasySwitch);
  const chip = $("#guard-chip");
  chip.className = `chip ${state ? (clean ? "ok" : "bad") : "bad"}`;
  chip.innerHTML = state
    ? `<span class="dot"></span>${clean ? "原生配置未被改动" : "原生配置出现了 EasySwitch 痕迹"}`
    : page === "doctor" && typeof doctorReport !== "undefined" && doctorReport ? `<span class="dot"></span>只读自检` : `<span class="dot"></span>连不上核心服务`;
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

const ALL_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
let levelsEditor = null; // "providerId/model" whose levels are being edited

/**
 * An agent's own controls, in the agent's row: thinking level and the other models it runs next to the main one
 * (sub-agent, small tasks), each with a small label above. They do not depend on the main model, which can stay native.
 */
function agentControls(id) {
  const binding = state.bindings?.[id];
  const can0 = (agentList ?? []).find(a => a.id === id)?.can;
  if (!can0) return "";
  const prefs = state.prefs?.[id] ?? {};
  const modelKey = binding ? `${binding.providerId}/${binding.model}` : null;
  const modelHas = modelKey ? state.modelEfforts?.[modelKey] ?? [] : null;
  // With a model of ours the levels are the model's that the agent can say (or all of the model's, for an agent with none of its own); on a native model, the agent's own.
  const own = can0.efforts ?? [];
  const levels = modelKey ? (can0.anyEffort ? modelHas : own.filter(l => (modelHas.includes(l) || ((l === "off" || l === "none") && modelHas.some(v => v === "off" || v === "none"))))) : own;
  const tierCtl = t => {
    const name = prefs.tiers?.[t.id];
    const slash = name ? name.indexOf("/") : -1;
    const provider = name && providerById(name.slice(0, slash));
    const face = name
      ? `${provider ? icon(provider.icon) : ""}<span class="label">${esc(name.slice(slash + 1))}</span>`
      : `<span class="label">跟随主模型</span>`;
    return `<div class="ctl" title="${esc(t.hint)}"><small>${esc(t.label)}</small><button class="popbtn" data-pick="${esc(id)}@${esc(t.id)}">${face}<span class="caret">▾</span></button>${savedModelNotice(name)}</div>`;
  };
  const effort = levels.length
    ? `<div class="ctl"><small>想得多深</small><select data-effort-select="${esc(id)}" title="只对这个 agent 生效">
        ${["", ...levels].map(l => `<option value="${esc(l)}" ${(prefs.effort ?? "") === l ? "selected" : ""}>${levelLabel(l, levels)}</option>`).join("")}</select></div>`
    : modelKey
      // A model EasySwitch knows no levels for: the user can say which it has, so the control does not just disappear.
      ? `<div class="ctl"><small>想得多深</small><button class="btn secondary" data-levels-edit="${esc(modelKey)}" title="${esc(binding.model)} 没有已知的思考档位；告诉 EasySwitch 它有哪些">档位未知，设置</button></div>`
      : "";
  const backups = selectableModelNames().filter(name => !name.startsWith("pool/"));
  const backup = `<div class="ctl"><small>备用模型</small><select data-fallback-select="${esc(id)}"><option value="">不设置备用</option>${savedModelOption(prefs.fallbackModel, backups)}${backups.map(name=>{const slash=name.indexOf("/"),p=providerById(name.slice(0,slash));return `<option value="${esc(name)}" ${prefs.fallbackModel===name?"selected":""}>${esc(p?.name ?? name.slice(0,slash))} / ${esc(name.slice(slash+1))}</option>`;}).join("")}</select><small>仅来源明确不可用或额度耗尽时，在发送前换用；不重放请求</small></div>`;
  return backup + effort + (modelKey && state.modelEffortNotes?.[modelKey] ? `<small class="hint">${esc(state.modelEffortNotes[modelKey])}</small>` : "") + (can0.tiers ?? []).map(tierCtl).join("");
}

/** The levels editor for the bound model, shown under the row it was opened from. */
function agentEditor(id) {
  const binding = state.bindings?.[id];
  const modelKey = binding ? `${binding.providerId}/${binding.model}` : null;
  if (!modelKey || levelsEditor !== modelKey) return "";
  const has = state.modelEfforts?.[modelKey] ?? [];
  return `<div class="row settings" style="padding-top:0;gap:10px;flex-wrap:wrap" data-levels-editor="${esc(modelKey)}">
      <span class="grow"></span><span class="hint">${esc(binding.model)} 有哪些档位：</span>
      ${ALL_LEVELS.map(l => `<label style="display:flex;gap:4px;align-items:center"><input type="checkbox" value="${l}" ${has.includes(l) ? "checked" : ""}>${esc(EFFORT_LABEL[l] ?? l)}</label>`).join("")}
      <button class="btn" data-levels-save="${esc(modelKey)}">保存</button><button class="btn secondary" data-levels-cancel>取消</button>
    </div>`;
}

function agentRow(harness) {
  const meta = agentMeta(harness);
  const binding = state.bindings?.[harness];
  const provider = binding && providerById(binding.providerId);
  const binary = harness === "codex" ? state.codexPath : state.claudePath;
  const sessions = sessionsOf(harness).length;
  const face = binding
    ? `${provider ? icon(provider.icon) : ""}<span class="label" title="${esc(provider?.name ?? binding.providerId)}">${esc(binding.model)}</span>`
    : `<span class="ic sm"></span><span class="label" title="不经过 EasySwitch">原生</span>`;
  const sub = !binary
    ? `没有找到 ${meta.name} 的命令`
    : harness === "claude" && state.claudeLogin ? "保留你的 Claude 登录，/model 里两类模型都在"
    : binding ? "增强会话用右边的模型" : "选一个模型就能开增强会话";
  return `
    <div class="row agent" data-harness="${harness}">
      <div class="id">${icon(meta.icon, "lg")}
        <div class="grow">
          <div class="title">${meta.name}${sessions ? `<button class="chip accent" data-go="sessions">${sessions} 个增强会话运行中</button>` : ""}</div>
          <div class="sub">${sub}</div>
        </div>
      </div>
      <div class="ctl"><small>主模型</small><button class="popbtn" data-pick="${harness}" title="增强会话用哪个模型">${face}<span class="caret">▾</span></button>${savedModelNotice(binding && `${binding.providerId}/${binding.model}`)}</div>
      ${agentControls(harness)}
      ${typeof automaticPoolEntry === "function" ? automaticPoolEntry(harness) : ""}
      <div class="acts"><button class="btn launch" data-launch="${harness}" title="在 EasySwitch 上启动一个增强会话（只在那个终端窗口里生效）" ${(binding || (harness === "claude" && state.claudeLogin)) && binary ? "" : "disabled"}>启动</button></div>
    </div>${agentEditor(harness)}`;
}

const SUPPORT_CHIP = {
  ready: `<span class="chip ok"><span class="dot"></span>已接入</span>`,
  planned: `<span class="chip accent">接入中</span>`,
  open: `<span class="chip">只能打开</span>`,
};

/** The ChatGPT desktop app: start it on the EasySwitch gateway, or plainly. A restart closes the running app, so it asks first. */
function chatgptCard() {
  const c = chatgptInfo;
  if (!c?.installed) return "";
  const chip = c.enhanced ? `<span class="chip ok"><span class="dot"></span>桌面端已用 EasySwitch 启动</span>`
    : c.running ? `<span class="chip">桌面端运行中 · 普通启动</span>` : `<span class="chip">桌面端未运行</span>`;
  const notice = chatgptConfirm ? `
    <div class="detail" style="display:block">
      <p class="hint">${chatgptConfirm === "enhance"
        ? `这会<b>关闭并重新打开 ChatGPT</b>${c.running ? "（正在运行的任务会中断，对话记录不受影响）" : ""}，重新打开时保留你原来的启动参数（比如代理）。这一次启动里，它的模型菜单会同时有 ChatGPT 自己的模型和你的外接模型；ChatGPT 自己模型的请求仍带着你的登录原样转发给 ChatGPT。${c.staticCatalog ? "<br>检测到 ~/.codex/config.toml 里有别的工具写的固定模型目录，这一次启动会改用 EasySwitch 生成的目录来盖住它（配置文件本身不动）。" : ""}`
        : `这会<b>关闭并重新打开 ChatGPT</b>，不再经过 EasySwitch，恢复成普通启动。`}</p>
      <div class="controls"><button class="btn" data-chatgpt-go="${chatgptConfirm}">确认，重启 ChatGPT</button><button class="btn secondary" data-chatgpt-cancel>取消</button></div>
    </div>` : "";
  return `
    <div class="row agent">
      <div class="id">${icon("openai", "lg")}
        <div class="grow"><div class="title">ChatGPT 桌面端</div><div class="sub">每次启动单独指向 EasySwitch，不改 ~/.codex；退回只要普通地重新打开</div></div>
      </div>
      <div class="acts">${chip}
      ${c.enhanced ? `<button class="btn secondary" data-chatgpt-ask="native">退回普通启动</button>` : `<button class="btn" data-chatgpt-ask="enhance" ${c.launchBlocked ? "disabled" : ""}>${c.launchBlocked ? "等待安全鉴权接入" : "用 EasySwitch 启动"}</button>`}</div>
    </div>${c.launchBlocked ? `<p class="hint">${esc(c.note)}</p>` : ""}${notice}`;
}

/** Desktop launches have their own lifecycle and must never use the CLI Terminal button. */
function claudeDesktopCard() {
  const c = claudeDesktopInfo;
  const names = selectableModelNames();
  const models = names.map(id => {
    const slash = id.indexOf("/"), source = id.slice(0, slash), model = id.slice(slash + 1);
    const pool = source === "pool" ? state.pools?.find(p => p.id === model) : null;
    return { id, name: source === "pool" ? `模型池 · ${pool?.name ?? model}${pool?.strategy === "automatic" ? ` · ${ROUTE["pool-automatic"]}` : ""}` : `${providerById(source)?.name ?? source} · ${model}` };
  });
  if (!claudeDesktopModel) {
    const b = state?.bindings?.["claude-desktop"];
    const saved = b ? `${b.providerId}/${b.model}` : "";
    claudeDesktopModel = saved || models[0]?.id || "";
    claudeDesktopConfirm = false;
  }
  const sessions = c?.sessions ?? [];
  const live = sessions.filter(s => !s.cleaned);
  const labels = { prepared: "等待启动", starting: "正在启动", running: "进程运行中", exited: "已退出", failed: "启动或运行失败", stopped: "已停止", "cleanup-blocked": "退出或清理待处理" };
  const disabled = c?.launchBlocked !== false || !c?.installed || !names.includes(claudeDesktopModel) || claudeDesktopBusy || live.length >= 3;
  const agent = agentList?.find(a => a.id === "claude-desktop");
  return `<div class="section-head"><h2>Claude 桌面端独立窗口</h2><span class="chip warn">${c?.launchBlocked !== false ? "真实启动已暂停" : "实验性 · 仅模拟测试"}</span></div>
    <div class="card" data-claude-desktop-card>
      <div class="row agent"><div class="id">${icon("claude-color", "lg")}<div class="grow">
        <div class="title">官方第三方网关模式</div>
        <div class="sub">隔离启动与停止清理已通过模拟测试；官方签名版 2.19675.1 忽略数据目录覆盖变量，真实目录隔离、模型菜单和消息链路尚未实测</div>${agent ? capStrip(agent) : ""}
      </div></div><span class="chip">${c ? c.installed ? "已检测到应用" : "未检测到应用" : "状态读取中"}</span></div>
      <div class="controls"><label>默认模型 <select data-claude-desktop-model aria-label="Claude 桌面端默认模型" ${claudeDesktopBusy ? "disabled" : ""}>
        ${savedModelOption(claudeDesktopModel, names)}${models.length ? models.map(m => `<option value="${esc(m.id)}" ${m.id === claudeDesktopModel ? "selected" : ""}>${esc(m.name)}</option>`).join("") : !claudeDesktopModel ? `<option value="">先添加模型来源</option>` : ""}
      </select></label><button class="btn" data-claude-desktop-ask ${disabled ? "disabled" : ""}>${claudeDesktopBusy ? "正在处理…" : "打开独立窗口"}</button></div>
      <p class="hint" style="padding:0 18px">${live.length >= 3 ? "已有三个独立会话，请先停止一个。" : "这里只管理 EasySwitch 创建的独立进程；正常 Claude 窗口不需要退出。启动不等于已验证配置生效。"}</p>
      ${c?.launchBlocked !== false ? `<p class="hint" role="status" style="padding:0 18px">${esc(c?.note ?? "读取安全状态前不能启动")}</p>` : ""}
      ${claudeDesktopConfirm ? `<div class="detail" style="display:block"><p class="hint">确认以实验性方式启动？启动器不改原生配置，但真实应用是否完全遵守独立目录仍待验证。应用可能下载并运行自带的 agent helper；发消息会使用你选择的来源及其额度。这个独立窗口只配置外接模型，不借用 Claude 登录。</p><div class="controls"><button class="btn" data-claude-desktop-start ${disabled ? "disabled" : ""}>确认，启动独立窗口</button><button class="btn secondary" data-claude-desktop-cancel>取消</button></div></div>` : ""}
      ${claudeDesktopError ? `<p class="hint" role="alert" style="padding:0 18px;color:var(--bad)">${esc(claudeDesktopError)}</p>` : ""}
      ${sessions.map(s => `<div class="row"><div class="grow"><div class="title">${esc(labels[s.state] ?? s.state)}${s.pid ? ` · PID ${esc(s.pid)}` : ""}</div><div class="sub">${s.cleaned ? "私有目录已清理" : "私有目录保留中"}${s.error ? ` · ${esc(userErrorMessage(s.error,"launch"))}` : ""}</div></div>${s.cleaned ? "" : `<button class="btn secondary" data-claude-desktop-stop="${esc(s.id)}" ${claudeDesktopBusy ? "disabled" : ""}>停止并清理</button>`}</div>`).join("")}
    </div>`;
}

function experimentalAgentsCard() {
  const pending = (claudeDesktopInfo?.sessions ?? []).filter(s => !s.cleaned).length;
  return `<details class="card" data-keep="experimental-agents" ${keepOpen("experimental-agents")} style="margin-top:12px">
    <summary class="row" style="cursor:pointer"><span class="grow title">实验功能</span><span class="hint">Claude 桌面端${pending ? ` · ${esc(pending)} 个会话待停止或清理` : claudeDesktopInfo?.launchBlocked === false ? " · 独立窗口试用" : " · 独立窗口暂未开放"}</span></summary>
    <div style="padding:0 16px 16px">${claudeDesktopCard()}</div></details>`;
}

/** The wider catalog under the two ready rows: what is installed here, then the rest. */
let guideOpen = null; // agent id whose setup guide is shown
let guideData = null; // what /api/agents/:id/setup returned
let guideBusy = false;
let guideReveal = false; // the token is shown masked until asked for

let vertexForm = null; // { message?, busy? } while the Vertex form is open

/** Adding a Google Vertex AI project: its id, a location, and the service account's key file pasted in. */
function renderVertexForm() {
  return `<form id="vertex-form" class="row" style="flex-direction:column;align-items:stretch;gap:8px">
    <div class="title">添加 Google Vertex AI · 服务账号 / Chat</div>
    <div class="sub">在 Google Cloud 里给项目建一个服务账号（角色「Vertex AI 用户」），下载它的 JSON 密钥，把内容整段粘到下面。密钥只存在钥匙串里，我们用它换短期令牌。此模式使用 OpenAI 兼容 Chat API；如只提供短期令牌或 Express Key，请从普通来源预设选择对应 Gemini 模式。</div>
    <input type="text" name="project" placeholder="项目 ID，比如 my-project-123456" required>
    <input type="text" name="location" placeholder="区域，默认 global（也可以是 us-central1）">
    <textarea name="serviceAccount" rows="6" placeholder='{ "type": "service_account", "client_email": "…", "private_key": "-----BEGIN PRIVATE KEY-----…" }' required></textarea>
    <input type="text" name="models" placeholder="模型（可不填；多个用逗号分隔，默认 google/gemini-2.5-pro 等三个）">
    <div class="msg ${vertexForm.message ? "err" : ""}" id="vertex-msg">${esc(vertexForm.message ?? "")}</div>
    <div style="display:flex;gap:8px"><button class="btn" type="submit" ${vertexForm.busy ? "disabled" : ""}>${vertexForm.busy ? "正在验证…" : "验证并添加"}</button><button class="btn secondary" type="button" data-vertex-close>取消</button></div>
  </form>`;
}

/** The manual-setup helper: what to type into an app that has no per-launch override, each value ready to copy. */
function guidePanel(a) {
  const g = guideData;
  if (!g || guideOpen !== a.id) return "";
  const field = (label, value, secret) => `<div class="gfield"><div class="glabel">${esc(label)}</div><code class="gvalue">${esc(secret && !guideReveal ? "•".repeat(12) : value)}</code>${secret ? `<button class="btn secondary" data-guide-reveal>${guideReveal ? "隐藏" : "显示"}</button>` : ""}<button class="btn secondary" data-copy="${esc(value)}">复制</button></div>`;
  return `<div class="row guide"><div class="grow">
    <div class="title">怎么把 EasySwitch 的模型加进 ${esc(g.name)}</div>
    <ol class="gsteps">${g.steps.map(t => `<li>${esc(t)}</li>`).join("")}</ol>
    ${g.fields.map(f => field(f.label, f.value, f.secret)).join("")}
    <div class="gfield"><div class="glabel">模型 ID（要用哪个就加哪个，第一个是你选的默认）</div><div class="gmodels">${g.models.map(m => `<button class="chip" data-copy="${esc(m)}" title="点一下复制">${esc(m)}</button>`).join("") || "<span class=\"hint\">还没有可用的模型：先去「模型来源」里添加并打开一个</span>"}</div></div>
    ${g.file ? `<div class="gfield"><div class="glabel">文件：${esc(g.file.path)}</div><pre class="gfile">${esc(g.file.content)}</pre><button class="btn secondary" data-copy="${esc(g.file.content)}">复制文件内容</button><div class="sub">${esc(g.file.warning)}</div></div>` : ""}
    <div class="sub gcaveat">${esc(g.caveat)}${g.sources?.length ? " · " + g.sources.filter(url => /^https:\/\//.test(url)).map(url => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">官方设置说明</a>`).join(" · ") : ""}</div>
  </div><button class="btn secondary" data-guide-close>收起</button></div>`;
}

function genericAgentRow(a) {
  const can = a.installed && a.can && !a.where?.endsWith(".app") ? a.can : null;
  const binding = state.bindings?.[a.id];
  const provider = binding && providerById(binding.providerId);
  const face = binding
    ? `${provider ? icon(provider.icon) : ""}<span class="label" title="${esc(provider?.name ?? binding.providerId)}">${esc(binding.model)}</span>`
    : `<span class="label">选个模型</span>`;
  return `
  <div class="row agent">
    <div class="id">${icon(a.icon, "lg")}
      <div class="grow"><div class="title">${esc(a.name)} <span class="hint">${esc(a.vendor)}</span> ${SUPPORT_CHIP[a.support]}</div><div class="sub" title="${esc(a.note)}">${esc(a.note)}${can && !can.verified ? " · <b>启动方式按官方文档写的，还没在真实程序上实测</b>" : ""}</div>${capStrip(a)}</div>
    </div>
    ${can ? `<div class="ctl"><small>主模型</small><button class="popbtn" data-pick="${esc(a.id)}">${face}<span class="caret">▾</span></button>${savedModelNotice(binding && `${binding.providerId}/${binding.model}`)}</div>` : ""}
    ${can ? agentControls(a.id) : ""}
    ${can && typeof automaticPoolEntry === "function" ? automaticPoolEntry(a.id) : ""}
    <div class="acts">
      ${a.guide ? `<button class="btn" data-guide="${esc(a.id)}">配置向导</button>` : ""}
      ${can?.interactive ? `<button class="btn" data-agent-launch="${esc(a.id)}" ${binding && !(a.id === "opencode" && typeof automaticToolFlight !== "undefined" && (automaticToolFlight || automaticToolUncertain)) ? "" : "disabled"}>启动</button>` : ""}
      ${can?.interactive && typeof automaticToolEntry === "function" ? automaticToolEntry(a.id) : ""}
      ${a.installed ? `<button class="btn secondary" data-agent-open="${esc(a.id)}">打开</button>` : `<span class="hint">未安装</span>`}
    </div>
  </div>${a.guide ? guidePanel(a) : ""}${can ? agentEditor(a.id) : ""}`;
}

/** Every agent except the two with their own rows, split into installed and not. */
function otherAgents() {
  const rest = (agentList ?? []).filter(a => a.id !== "codex" && a.id !== "claude" && a.id !== "claude-desktop");
  // Those EasySwitch can start come first.
  const rank = a => (a.can?.interactive ? 0 : a.can ? 1 : 2);
  const by = (x, y) => rank(x) - rank(y);
  return { installed: rest.filter(a => a.installed).sort(by), missing: rest.filter(a => !a.installed).sort(by) };
}


/** A model that can only think or not (DeepSeek, Kimi and the like) gets "off / on", not a scale it does not have. */
function levelLabel(level, levels) {
  if (!level) return "默认";
  const switchOnly = levels.length === 2 && levels.some(l => l === "none" || l === "off") && levels.some(l => l !== "none" && l !== "off");
  if (switchOnly) return level === "none" || level === "off" ? "关闭思考" : "开启思考";
  return `${EFFORT_LABEL[level] ?? level}（${esc(level)}）`;
}
const EFFORT_LABEL = { "": "默认", none: "不思考", minimal: "最少", low: "快", medium: "均衡", high: "深", xhigh: "更深", max: "最深", ultra: "极限" };
let profileNaming = false;

/** Profiles: every agent's settings saved under a name, to come back to in one click. */
function profileBar() {
  const list = state.profiles ?? [];
  return `
    <div class="card"><div class="row" style="gap:10px;flex-wrap:wrap">
      <div class="grow"><div class="title">方案</div><div class="sub">${list.length ? "把所有 agent 现在的设置存成一个名字，之后一键切回" : "还没有方案：设好各个 agent 的主模型、档位和小模型后，存成一个方案"}</div>${list.length && state.pools?.some(pool => pool.strategy === "automatic") ? `<p class="hint">方案可能恢复纯文字自动模式，工具请求会被拒绝；切换后请核对主模型和小模型。此限制指普通启动；OpenCode 工具试用仍需另行确认新开会话。</p>` : ""}</div>
      ${list.length ? `<select data-profile-pick>${list.map(p => `<option value="${esc(p.id)}">${esc(p.name)}（${p.agents} 个 agent）</option>`).join("")}</select>
        <button class="btn" data-profile-apply>切换到它</button><button class="btn secondary" data-profile-del>删除</button>` : ""}
      ${profileNaming
        ? `<form data-profile-form style="display:flex;gap:8px"><input type="text" name="name" placeholder="比如 省钱 / 专注" required autofocus><button class="btn" type="submit">保存</button><button class="btn secondary" type="button" data-profile-cancel>取消</button></form>`
        : `<button class="btn secondary" data-profile-new>把现在的设置存成方案</button>`}
    </div></div>`;
}

/** The menu-bar panel: each subscription with its switch, so one can be turned on or off without opening the console. */
function panelSubscriptions() {
  const accounts = (planInfo?.accounts ?? []).filter(a => a.planUsage && !a.needsSignIn);
  if (!accounts.length) return "";
  const row = a => `
    <div class="row">
      ${icon(a.kind === "copilot" ? "github-copilot-color" : a.kind === "kiro" ? "kiro-color" : a.kind === "antigravity" ? "antigravity-color" : "openai", "sm")}
      <div class="grow"><div class="title">${esc(a.label)}</div>${a.on && a.quota ? `<div class="sub ${a.quota.exhaustedUntil ? "quota-out" : "quota"}">${esc(a.quota.text)}</div>` : ""}</div>
      <button class="switch ${a.on ? "on" : ""}" role="switch" aria-checked="${a.on ? "true" : "false"}" data-plan-switch="${esc(a.id)}" data-on="${a.on ? "1" : "0"}"><span class="knob"></span><span class="lbl">${a.on ? "已打开" : "已关闭"}</span></button>
    </div>`;
  return `<div class="section-head"><h2>订阅</h2></div><div class="card">${accounts.map(row).join("")}</div>`;
}

function renderAgents() {
  if (PANEL) {
    const rows = Object.keys(HARNESS).map(agentRow).join("");
    return `
      <div class="card">${rows}</div>
      ${panelSubscriptions()}
      <div class="panel-foot">
        <button data-bridge="openConsole">打开控制台</button>
        <span>
          ${BRIDGE ? `<button data-bridge="backToNative">全部退回原生</button><button data-bridge="quit">退出</button>` : ""}
        </span>
      </div>`;
  }
  if (typeof firstRunVisible === "function" && firstRunVisible()) return firstRunCard();
  const others = otherAgents();
  const codexHere = Boolean(state.codexPath);
  const claudeHere = Boolean(state.claudePath);
  const inst = [
    ...(codexHere ? [agentRow("codex"), chatgptCard()] : []),
    ...(claudeHere ? [agentRow("claude")] : []),
    ...others.installed.map(genericAgentRow),
  ];
  const missing = [
    ...(codexHere ? [] : agentList?.filter(a => a.id === "codex").map(genericAgentRow) ?? []),
    ...(claudeHere ? [] : agentList?.filter(a => a.id === "claude").map(genericAgentRow) ?? []),
    ...others.missing.map(genericAgentRow),
  ];
  return `
    ${profileBar()}
    <div class="section-head"><h2>已安装</h2><span class="aside">${inst.length ? `${agentList ? agentList.filter(a => a.installed).length : inst.length} 个` : ""}；每个 agent 平时都走原生，增强会话只在 EasySwitch 打开的终端窗口里生效</span></div>
    <div class="card">${inst.join("") || `<div class="empty">${agentList ? "这台 Mac 上还没检测到 agent" : "正在检测…"}</div>`}</div>
    <p class="hint">在每个 agent 那一行里选主模型、想得多深、后台小任务和子 agent 用的模型，再点「启动」。会话里输入 <code>/model</code> 可以随时换。选「原生」就是不用 EasySwitch；你平时直接打开的 ChatGPT 和 Claude Code 永远不受影响。「接入中」的 agent 正在逐个接入；「只能打开」的是闭源或绑定登录的，EasySwitch 只负责检测和打开，不会改动它们的任何配置。</p>
    ${state.providers.length ? "" : onboarding()}
    ${experimentalAgentsCard()}
    ${coverageCard()}
    ${missing.length ? `<div class="section-head"><h2>未安装</h2><span class="aside">${missing.length} 个</span></div><div class="card">${missing.join("")}</div>` : ""}`;
}

let autoConfirm = false; // the inline terms notice for auto pick is open

function accountIsResting(a, now = Date.now()) { return Date.parse(a.restUntil) > now; }

function accountRow(a) {
  const resting = accountIsResting(a);
  const state = !a.enabled ? `<span class="chip">不参与自动选号</span>`
    : resting ? `<span class="chip warn"><span class="dot"></span>休息标记 · ${inFuture(a.restUntil)}到期</span>`
    : `<span class="chip">未标记休息</span>`;
  return `
    <div class="row" data-account="${esc(a.id)}">
      ${icon(HARNESS[a.harness].icon, "sm")}
      <div class="grow"><div class="title">${esc(a.label)}</div><div class="sub">${a.lastUsedAt ? `上次用：${ago(a.lastUsedAt)}` : "还没用过；第一次启动要在终端里登录一次"}</div></div>
      ${state}
      <button class="btn" data-acc-launch="${esc(a.id)}" data-h="${a.harness}">手动启动</button>
      <button class="btn secondary" data-acc-rest="${esc(a.id)}" data-on="${resting ? "0" : "1"}">${resting ? "清除休息标记" : "撞限额了"}</button>
      <button class="btn secondary" data-acc-toggle="${esc(a.id)}" data-enabled="${a.enabled ? "0" : "1"}" title="仅影响自动选号，仍可手动启动">${a.enabled ? "停用" : "启用"}</button>
      <button class="btn danger" data-acc-del="${esc(a.id)}">移除</button>
    </div>`;
}

function renderSettings() {
  return (globalThis.EasySwitchTheme?.controls() ?? "") + renderAccounts();
}

function renderAccounts() {
  const accounts = state.accounts ?? [];
  const settings = state.accountSettings ?? { autoPick: false };
  const section = h => {
    const mine = accounts.filter(a => a.harness === h);
    const enabled = mine.filter(a => a.enabled), now = Date.now();
    const ready = enabled.filter(a => !accountIsResting(a, now));
    const allResting = enabled.length > 0 && ready.length === 0;
    const retryAt = allResting ? new Date(Math.min(...enabled.map(a => Date.parse(a.restUntil)))).toISOString() : "";
    const reason = !settings.autoPick ? "先了解说明并开启自动选号" : !enabled.length ? "请添加账号或让已有账号参与自动选号"
      : allResting ? "全部账号都有休息标记，暂不自动启动" : "从未标记休息的账号中选最久没用的；实际登录和额度未核实";
    return `
      <div class="section-head"><h2>${icon(HARNESS[h].icon, "sm")} ${HARNESS[h].name}</h2>
        <span class="aside">${mine.length} 个账号</span></div>
      <div class="card">
        ${mine.map(accountRow).join("") || `<div class="empty">还没有账号</div>`}
        <form class="form" data-add-account="${h}"><div class="controls">
          <input type="text" name="label" placeholder="给这个账号起个名字，例如：个人 Plus" style="flex:1">
          <button class="btn secondary" type="submit">＋ 添加 ${HARNESS[h].name} 账号</button>
          <button class="btn" type="button" data-acc-auto="${h}" ${settings.autoPick && ready.length ? "" : "disabled"} title="${reason}">自动选号启动</button>
        </div></form>
        <p class="hint" data-account-readiness="${h}" ${retryAt ? `data-acc-retry-at="${esc(retryAt)}"` : ""}>${allResting ? `全部参与自动选号的账号都有休息标记，暂不自动启动。最早标记到期：${esc(new Date(retryAt).toLocaleString())}（${inFuture(retryAt)}）。标记时间不代表实际额度恢复；请先核对账号，再手动启动或清除休息标记。` : reason}</p>
      </div>`;
  };
  return `
    <div class="section-head"><h2>订阅账号</h2><span class="aside">一个人的多份订阅；全部在本机，登录令牌不经过 EasySwitch</span></div>
    <div class="card"><div class="row">
      <div class="grow"><div class="title">自动选号</div>
        <div class="sub">${settings.autoPick ? "已开启：启动时只从未标记休息的账号中选最久没用的；不保证实际登录或额度可用" : "未开启：每次自己选账号启动"}</div></div>
      <button class="btn secondary" data-acc-autopick="${settings.autoPick ? "off" : "ask"}">${settings.autoPick ? "关闭" : "开启…"}</button>
    </div>
    ${autoConfirm && !settings.autoPick ? `<div class="detail" style="display:block"><p class="hint">请注意：服务商的条款可能限制「为绕开用量限制而在多个账号之间切换」。自动选号只在<b>启动会话时</b>替你挑账号，不转发请求、不接触任何登录令牌，也不会在会话中途换号；是否符合你所用服务的条款，由你自己确认。</p>
      <div class="controls"><button class="btn" data-acc-autopick="on">我已了解，开启</button><button class="btn secondary" data-acc-autopick="cancel">取消</button></div></div>` : ""}
    </div>
    ${section("codex")}${section("claude")}
    <p class="hint">每个账号有自己的登录目录（ChatGPT用 <code>CODEX_HOME</code>，Claude Code 用 <code>CLAUDE_CONFIG_DIR</code>），只对这一次启动生效，不会改动你平时用的 ~/.codex 和 ~/.claude。移除账号只删记录，目录和登录会保留在 EasySwitch 的数据目录里。</p>`;
}

/** First-run onboarding: paste whatever the vendor handed you, everything else is automatic. */
function onboarding() {
  const saved = importFormOpen ? ($("#import-form textarea")?.value ?? "") : "";
  return `
    <div class="card" id="onboard">
      <div class="section-head"><h2>三步接入</h2><span class="aside">刚买的中转站或新订阅，把它给你的东西整段粘进来</span></div>
      <ol class="steps">
        <li>把<strong>使用说明、地址、Key 或教程链接</strong>整段粘贴到下面的框里（export 命令、JSON、中文说明都行）</li>
        <li>点「一键接入」，EasySwitch 自动识别地址和 Key、测一遍、给 ChatGPT和 Claude Code 接上</li>
        <li>回来点「启动增强会话」</li>
      </ol>
      <form class="form" id="import-form">
        <textarea name="text" rows="4" placeholder="例如：\nexport ANTHROPIC_BASE_URL=https://api.xxx.com\nexport ANTHROPIC_AUTH_TOKEN=sk-xxxx\n或者直接粘贴教程网址、购买页说明……" style="width:100%;resize:vertical">${esc(saved)}</textarea>
        <div class="controls"><button class="btn" type="submit">一键接入</button>
          <button class="btn secondary" type="button" data-go="providers">从预设里选</button></div>
        <p class="msg" id="import-msg"></p>
      </form>
    </div>`;
}

function openPicker(anchor, target) {
  if (typeof automaticPoolInvalidate === "function") automaticPoolInvalidate();
  closePopover();
  const [harness, tier] = target.split("@");
  const main = state.bindings?.[harness];
  const tierName = tier ? state.prefs?.[harness]?.tiers?.[tier] : undefined;
  const binding = tier ? (tierName ? { providerId: tierName.slice(0, tierName.indexOf("/")), model: tierName.slice(tierName.indexOf("/") + 1) } : undefined) : main;
  const savedName = binding ? `${binding.providerId}/${binding.model}` : "";
  const el = document.createElement("div");
  el.className = "popover";
  el.innerHTML = `
    <div class="search"><span>🔍</span><input placeholder="搜索模型或来源…" autocomplete="off"></div>
    ${modelSelectionReason(savedName) ? `<div class="hint" role="status">已保留 ${esc(savedName)}：${esc(modelSelectionReason(savedName))}。可重新选择或保留原设置。</div>` : ""}
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
    const allowed = new Set(selectableModelNames());
    const out = [];
    if (!only && (!q || "原生 native".includes(q))) out.push({ native: true });
    for (const p of state.providers) {
      if (only && p.id !== only) continue;
      const route = harness === "codex" ? p.route : harness === "claude" ? p.messagesRoute ?? "chat-translate" : "chat-translate";
      for (const m of modelsOf(p)) {
        if (!allowed.has(`${p.id}/${m}`)) continue;
        if (q && !m.toLowerCase().includes(q) && !p.name.toLowerCase().includes(q)) continue;
        out.push({ provider: p, model: m, route });
      }
    }
    // Pools are models too: they sit at the end of the list.
    if (!only) for (const pool of state.pools ?? []) {
      if (!allowed.has(`pool/${pool.id}`)) continue;
      if (q && !pool.name.toLowerCase().includes(q) && !"模型池 pool".includes(q)) continue;
      out.push({ provider: POOL_PROVIDER, model: pool.id, route: pool.strategy === "automatic" ? "pool-automatic" : "pool" });
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
        return `<button class="opt native ${i === kb ? "kb" : ""}" data-i="${i}">${icon(agentMeta(harness).icon)}
          <span class="name">${tier ? "跟随主模型" : "原生"}</span><span class="meta">${tier ? "不单独指定，和主模型一样" : `${agentMeta(harness).name} 自带的，不经过 EasySwitch`}</span><span class="tick">${on ? "✓" : ""}</span></button>`;
      }
      const head = o.provider.id !== lastGroup ? `<div class="group">${esc(o.provider.name)}</div>` : "";
      lastGroup = o.provider.id;
      const on = binding && binding.providerId === o.provider.id && binding.model === o.model;
      return `${head}<button class="opt ${i === kb ? "kb" : ""}" data-i="${i}">${icon(o.provider.icon)}
        <span class="name">${esc(o.model)}</span><span class="meta">${harness === "opencode" && o.route === "pool-automatic" ? "普通启动仅纯文字；可另行确认新开普通函数工具试用" : ROUTE[o.route]}</span><span class="tick">${on ? "✓" : ""}</span></button>`;
    }).join("") || `<div class="empty">没有匹配的模型</div>`;
    el.querySelector(".opt.kb")?.scrollIntoView({ block: "nearest" });
    return opts;
  };

  const choose = async o => {
    if (!o) return;
    if (!o.native && !selectableModelNames().includes(`${o.provider.id}/${o.model}`)) {
      toast("模型状态已改变，请重新选择；原设置已保留"); closePopover(); await refresh(true); return;
    }
    closePopover();
    try {
      if (tier) {
        if (o.native) await call("DELETE", `/api/bindings/${harness}/tiers/${tier}`);
        else await call("PUT", `/api/bindings/${harness}/tiers/${tier}`, { providerId: o.provider.id, model: o.model });
        toast(o.native ? "已改为跟随主模型" : `已设为 ${o.model}，下次启动生效`);
      } else if (o.native) {
        await call("DELETE", `/api/bindings/${harness}`);
        toast(`${agentMeta(harness).name}：增强会话已关闭，只用原生`);
      } else {
        await call("PUT", `/api/bindings/${harness}`, { providerId: o.provider.id, model: o.model });
        toast(`${agentMeta(harness).name} 的增强会话将使用 ${o.model}`);
      }
    } catch (error) {
      showError(error);
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

/** How the user pays this provider, and what a model costs: from the table, or the user's own number. */
function billingBlock(p) {
  const s = p.priceSample;
  const sub = p.billing === "subscription";
  const r = s?.rates;
  const own = p.prices?.[s?.model ?? ""];
  const priceText = !s ? "" : r
    ? `${esc(s.model)}：输入 $${r.input} · 输出 $${r.output} · 缓存读 $${r.cacheRead}（每百万 token，${s.source === "user" ? "你填的" : "旧参考表，未按官方现价复核"}）`
    : `${esc(s.model)}：还没有价格，用量页会显示「—」；可以在下面填`;
  return `
    <div class="section-head"><h3>计费</h3><span class="aside">估算用，不是账单</span></div>
    <div class="controls"><label class="hint">计费方式</label>
      <select class="billing-select"><option value="usage" ${sub ? "" : "selected"}>按量（按 token 估算花费）</option><option value="subscription" ${sub ? "selected" : ""}>包月套餐（不估算单次花费）</option></select></div>
    ${sub ? "" : `<div class="hint">${priceText}</div>
    ${s ? `<form class="controls" data-price-form="${esc(s.model)}">
      <span class="hint">自己填 $/百万 token：</span>
      <input type="number" step="any" min="0" name="input" placeholder="输入" value="${own?.input ?? ""}" style="width:90px">
      <input type="number" step="any" min="0" name="output" placeholder="输出" value="${own?.output ?? ""}" style="width:90px">
      <input type="number" step="any" min="0" name="cacheRead" placeholder="缓存读" value="${own?.cacheRead ?? ""}" style="width:90px">
      <button class="btn secondary" type="submit">保存</button>${own ? `<button class="btn secondary" type="button" data-price-clear="${esc(s.model)}">清除</button>` : ""}
    </form>` : ""}`}`;
}

/** The key pool of one provider: each row is a key (an account); the first enabled one answers next. */
function keyList(p) {
  if (p.vertex && (p.vertex.mode === "service-account" || !p.vertex.mode)) return `<p class="hint">服务账号保存在专用钥匙串项中，使用 Chat 协议并自动换取短期令牌；不复用普通 API Key 池。更换身份请从服务账号入口新增来源。</p>`;
  const keys = p.keys ?? [];
  const rows = keys.map(k => {
    const resting = k.restUntil && new Date(k.restUntil).getTime() > Date.now();
    return `<tr><td>${esc(k.label)}</td>
      <td>${resting ? `<span class="chip warn" title="${esc(k.lastError?.reason ?? "")}"><span class="dot"></span>${esc(k.lastError?.reason ?? "休息中")} · ${inFuture(k.restUntil)}恢复</span>` : k.lastError ? `<span class="chip bad">${esc(k.lastError.reason)}</span>` : `<span class="chip ok"><span class="dot"></span>正常</span>`}</td>
      <td class="num"><button class="btn secondary" data-key-patch="${esc(k.id)}" data-enabled="${k.enabled ? "0" : "1"}">${k.enabled ? "停用" : "启用"}</button>
        <button class="btn danger" data-key-del="${esc(k.id)}">删除</button></td></tr>`;
  }).join("");
  return `
    <div class="section-head"><h3>我的 Key 池</h3><span class="aside">你自己的几把 Key 按顺序用；一把被拒或限流，就休息一会儿，别的先上——全部在本机，不经过任何服务器</span></div>
    ${rows ? `<table class="tbl"><tr><th>名称</th><th>状态</th><th class="num"></th></tr>${rows}</table>` : `<div class="hint">这把来源只有一把 Key（老的存法）。</div>`}
    <form class="form" data-add-key>
      <div class="field"><label>备注（比如“主力订阅”）</label><input type="text" name="label" placeholder="Key ${keys.length + 1}"></div>
      <div class="field"><label>API Key（存进 macOS 钥匙串）</label><input type="password" name="apiKey" autocomplete="off" required></div>
      <div class="controls"><button class="btn secondary" type="submit">添加 Key</button></div>
    </form>`;
}

/** "本月约 $1.20 / $5（24%）", and what it means when it is gone. */
function budgetText(b) {
  if (b.configurationInvalid || b.accountingUnavailable) return b.warning || "来源预算账本不可用，已暂停";
  const money = n => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
  const base = `本月约 ${money(b.spent)} / ${money(b.limit)}（${Math.round(b.ratio * 100)}%）`;
  return b.level === "over" ? `${base}，预算用完了${b.stop ? "，已停用到下个月" : "（只提醒，没有停用）"}` : b.level === "near" ? `${base}，快用完了` : base;
}

/** The monthly budget of one source: how much it may cost, and whether it stops when that is gone. The cost is the estimate at the vendor's own prices. */
function budgetBlock(p) {
  if (p.billing === "subscription") return "";
  const b = p.budget;
  return `<form class="controls" data-provider-budget-form="${esc(p.id)}">
    <label class="hint">来源预算（本地日历月，美元估算）</label>
    <input type="number" name="monthlyUsd" min="0" step="0.5" placeholder="不设" value="${b ? esc(String(b.monthlyUsd)) : ""}" style="width:110px">
    <label class="hint" style="display:flex;gap:4px;align-items:center"><input type="checkbox" name="stop" ${b?.stop ? "checked" : ""}> 用完就停用到下个月</label>
    <button class="btn secondary" type="submit">保存</button>
    <span class="hint">${p.budgetStatus ? esc(budgetText(p.budgetStatus)) : "按各家公开的按量价格估算；没设就不限"}</span>
  </form>`;
}

const PROTOCOL = { chat: "Chat", responses: "Responses", messages: "Messages", gemini: "Gemini" };
// Keep in-progress choices through polling, collapsing, or an unrelated refresh.
const protocolDrafts = new Map();
const providerOperations = new Set();
function protocolChoices(p, model = "") {
  const values = p?.modelProtocols?.[model] ?? p?.protocols ?? p?.supportedProtocols ?? ["chat"];
  return Array.isArray(values) ? [...new Set(values.filter(v => Object.hasOwn(PROTOCOL, v)))] : [];
}
function protocolOptions(p, model = "", selected = protocolChoices(p, model)) {
  const order = [...selected, ...Object.keys(PROTOCOL).filter(v => !selected.includes(v))];
  return order.map(v => `<label><input type="checkbox" name="protocols" value="${esc(v)}" ${selected.includes(v) ? "checked" : ""}> ${PROTOCOL[v] ?? esc(v)}</label>`).join(" ");
}
function rememberProtocolForm(form) {
  const id = form?.closest(".detail")?.dataset.provider;
  if (!id) return;
  const f = new FormData(form);
  protocolDrafts.set(id, { model: String(f.get("model") ?? ""), protocols: f.getAll("protocols") });
}
async function withProviderOperation(detail, action) {
  const id = detail?.dataset.provider;
  if (!id || providerOperations.has(id)) return;
  providerOperations.add(id);
  const controls = [...detail.querySelectorAll("button, input, select")];
  const disabled = controls.map(el => el.disabled);
  controls.forEach(el => { el.disabled = true; });
  try { await action(); }
  finally {
    providerOperations.delete(id);
    controls.forEach((el, i) => { el.disabled = disabled[i]; });
    // A manual refresh may have replaced the locked nodes while awaiting the API.
    if (controls.some(el => el.isConnected === false)) render();
  }
}

function providerRow(p) {
  const models = modelsOf(p);
  const used = (p.usedBy ?? []).map(h => icon(agentMeta(h).icon, "sm")).join("");
  const open = openProvider === p.id;
  const checks = (p.probe?.checks ?? []).map(c => `
    <div class="check ${["pass", "fail", "skip"].includes(c.status) ? c.status : ""}"><b>${esc(c.label)}</b>${esc(c.status === "fail" ? userErrorMessage({message:c.detail,status:Number(/HTTP (\d{3})/.exec(c.detail ?? "")?.[1])},"source") : c.detail)}${c.latencyMs != null ? ` · ${esc(c.latencyMs)}ms` : ""}</div>`).join("");
  const options = models.map(m => `<option ${m === p.defaultModel ? "selected" : ""}>${esc(m)}</option>`).join("");
  const fixed = p.plan || p.mimoFree || p.vertex || p.kiro || p.antigravity || p.cursor || p.kimi || p.cliTextBridge;
  const draft = protocolDrafts.get(p.id);
  const scope = draft?.model ?? "";
  const busy = providerOperations.has(p.id);
  const probeBlocked = (state?.budget?.settings?.enabled && state.budget.settings.action === "stop") || p.budget?.stop || p.budgetStatus?.configurationInvalid;
  const detail = open ? `
    <div class="detail" data-provider="${esc(p.id)}">
      <div class="controls">
        <span class="chip">来源协议：${(p.supportedProtocols ?? ["chat"]).map(v => PROTOCOL[v] ?? esc(v)).join(" / ") || "尚不支持"}</span>
      </div>
      ${fixed ? "" : `<details data-keep="protocols:${esc(p.id)}" ${keepOpen(`protocols:${p.id}`)}>
        <summary class="hint" style="cursor:pointer">协议设置 · 通常不用动</summary>
        <form class="form" data-protocol-form><fieldset ${busy ? "disabled" : ""} style="border:0;padding:0;margin:0;display:grid;gap:12px">
        <div class="field"><label>设置范围</label><select name="model" data-protocol-model><option value="">整个来源</option>${[...new Set([...models, ...(scope ? [scope] : [])])].map(m => `<option value="${esc(m)}" ${m === scope ? "selected" : ""}>${esc(m)}${p.modelProtocols?.[m] ? "（单独设置）" : ""}</option>`).join("")}</select></div>
        <div class="controls" data-protocol-options>${protocolOptions(p, scope, draft?.protocols)}</div>
        <div class="hint">按来源文档勾选它支持的协议。与客户端相同的协议优先；需要转换时，按这里的显示顺序选择。单个模型可独立设置。</div>
        <div class="controls"><button class="btn secondary" type="submit">保存协议</button><button class="btn secondary" type="button" data-protocol-auto>恢复默认</button></div>
      </fieldset></form></details>`}
      ${p.cliTextBridge ? `<p class="hint">${esc(cliTextSourceNotice(p))}</p>` : `<div class="controls">
        <label class="hint">测试用模型</label>
        <select class="probe-model">${options || "<option value=''>（没有可选模型）</option>"}</select>
        <button class="btn" data-probe ${probeBlocked ? "disabled title=\"暂停预算开启时不允许未完整计费的探测\"" : busy || !models.length || p.vertex ? "disabled" : ""}>检测一下</button>
        <span class="hint">${p.probe ? `上次测试：${ago(p.probe.at)}` : "还没测过"}</span>
      </div>${p.vertex ? `<p class="hint">此来源使用专用适配器，通用检测暂不适用。</p>` : `<p class="hint">检测会发送测试请求，可能产生费用；目前检查 Chat、Responses 和 Messages，不覆盖 Gemini，也不会覆盖手动保存的协议。</p>`}`}
      ${checks ? `<div class="checks">${checks}</div>` : ""}
      <div class="hint">${p.cliTextBridge ? "本地CLI标识（不是HTTP接口）" : "OpenAI 兼容地址"}：<span class="mono">${esc(p.baseUrl)}</span>${p.anthropicBaseUrl ? ` · Anthropic 地址：<span class="mono">${esc(p.anthropicBaseUrl)}</span>` : ""}</div>
      ${billingBlock(p)}
      ${budgetBlock(p)}
      ${typeof sourceHealthCard === "function" ? sourceHealthCard(p) : ""}
      ${keyList(p)}
      <div><button class="btn danger" data-remove>删除这个来源</button></div>
    </div>` : "";
  return `
    <div class="row clickable ${open ? "open" : ""}" data-toggle="${esc(p.id)}">
      ${icon(p.icon, "lg")}
      <div class="grow"><div class="title">${esc(p.name)}</div><div class="sub">${esc(hostOf(p.baseUrl))} · ${models.length} 个模型${p.sourceHealth ? ` · ${p.sourceHealth.status === "unavailable" ? "轻量检查不可用" : p.sourceHealth.status === "healthy" ? "轻量检查正常" : "轻量检查未知"}` : ""}${p.budgetStatus ? ` · <span class="${p.budgetStatus.level === "ok" ? "quota" : "quota-out"}">${esc(budgetText(p.budgetStatus))}</span>` : ""}${p.quotaSupport ? ` · ${esc(p.quotaSupport.text)}` : ""}${p.quota ? ` · <span class="${p.quota.exhaustedUntil ? "quota-out" : "quota"}">${esc(p.quota.text)}</span>` : ""}</div></div>
      ${used ? `<span title="正在使用的 agent">${used}</span>` : ""}
      <span class="chip ${p.hasKey ? "ok" : "warn"}"><span class="dot"></span>${p.hasKey ? "Key 在钥匙串" : "未设置 Key"}</span>
      ${!p.cliTextBridge&&!p.plan&&!p.kimi&&!p.cursor&&!p.kiro&&!p.antigravity ? `<button class="switch ${p.off ? "" : "on"}" data-source-switch="${esc(p.id)}" data-enabled="${p.off ? "0" : "1"}">${p.off ? "已关闭，点击开启" : "已开启，点击关闭"}</button>` : ""}
      ${p.cliTextBridge ? `<button class="switch ${p.off ? "" : "on"}" data-cli-source-switch="${esc(p.id)}" data-on="${p.off ? "0" : "1"}" ${p.cliTextBridge.kind === "droid" ? "disabled" : ""}>${p.off ? "已关闭，点击开启" : "已开启，点击关闭"}</button><span class="chip warn">实验性 · 仅文字</span>` : ""}
      <span class="chev">›</span>
    </div>${detail}`;
}

let presetQuery = "";

function presetUnavailableNotice(preset) {
  if (!preset?.unavailable) return "";
  const { reason, sourceUrl } = preset.unavailable;
  const source = typeof sourceUrl === "string" && /^https:\/\//.test(sourceUrl) ? ` <a href="${esc(sourceUrl)}" target="_blank" rel="noopener">官方停用说明</a>` : "";
  return `<p class="hint" id="preset-status-${esc(preset.id)}">${esc(preset.name)}：${esc(reason)}${source}</p>`;
}

/** Presets grouped by category, filtered by the search box. */
function presetGroups() {
  const q = presetQuery.trim().toLowerCase();
  const hit = x => !q || `${x.name} ${x.id} ${x.note ?? ""} ${x.baseUrl}`.toLowerCase().includes(q);
  const order = [...new Set(presets.map(x => x.category ?? "其他"))];
  const preset = addForm?.preset;
  const html = order.map(cat => {
    const items = presets.filter(x => (x.category ?? "其他") === cat && hit(x));
    return items.length ? `
      <div class="hint" style="margin:10px 0 4px">${esc(cat)}</div>
      <div class="presets">${items.map(x => `
        <button class="preset ${preset?.id === x.id ? "on" : ""}" data-preset="${esc(x.id)}" ${x.unavailable ? `disabled aria-describedby="preset-status-${esc(x.id)}"` : ""} title="${esc(x.unavailable?.reason ?? x.note ?? x.baseUrl)}">${icon(x.icon, "lg")}<span>${esc(x.name)}${x.unavailable ? ' <span class="chip warn">已停用</span>' : ""}</span></button>`).join("")}
      </div>${items.filter(x => x.unavailable).map(presetUnavailableNotice).join("")}` : "";
  }).join("");
  return `<div id="preset-groups">${html || `<div class="empty">没有匹配的预设；可以选「自定义中转站」手动填</div>`}</div>`;
}

function renderAddForm() {
  const preset = addForm.preset;
  if (preset?.unavailable) return `${presetUnavailableNotice(preset)}<button class="btn secondary" type="button" data-cancel-add>取消</button>`;
  return `
    <div class="field"><input type="search" id="preset-search" style="width:100%" placeholder="搜索 ${presets.length} 个预设：DeepSeek、Kimi、中转站、本地……" value="${esc(presetQuery)}" autocomplete="off"></div>
    ${presetGroups()}
    <form class="form" id="add-form">
      <div class="field"><label>名称</label><input type="text" name="name" required value="${esc(preset && preset.id !== "relay" ? preset.name : "")}" placeholder="例如：我的中转站"></div>
      ${(preset?.urlParams ?? []).map(x => `
      <div class="field"><label>${esc(x.label)}（填进地址里的 {${esc(x.key)}}）</label><input type="text" name="param:${esc(x.key)}" required autocomplete="off" placeholder="${esc(x.example ?? "")}"></div>`).join("")}
      ${preset?.vertexMode ? `<p class="hint">Vertex ${preset.vertexMode === "standard" ? "标准模式：使用你提供的短期访问令牌，不读取或刷新原生登录" : "Express：使用 Google Cloud API Key"}；这里只校验配置，不自动推理探测。</p>${preset.vertexMode === "standard" ? `<div class="field"><label>Google Cloud 项目 ID</label><input name="vertexProject" required></div><div class="field"><label>区域</label><input name="vertexLocation" value="global" required></div>` : ""}<div class="field"><label>Gemini 模型 ID</label><input name="defaultModel" value="${esc(preset.defaultModel ?? "")}" required></div>` : ""}
      <div class="field"><label>${preset?.vertexMode ? "固定 Google API 地址" : "OpenAI 兼容地址"}</label><input type="text" name="baseUrl" required ${preset?.vertexMode ? "readonly" : ""} value="${esc(preset?.baseUrl ?? "")}" placeholder="https://relay.example.com/v1"></div>
      <div class="field"><label>Anthropic 地址（可选，给 Claude Code 原样转发用）</label><input type="text" name="anthropicBaseUrl" value="${esc(preset?.anthropicBaseUrl ?? "")}" placeholder="不填就用上面的地址"></div>
      <div class="field"><label>API Key（存进 macOS 钥匙串）${preset?.keyUrl ? ` · <a href="${esc(preset.keyUrl)}" target="_blank" rel="noopener">去哪里拿 Key</a>` : ""}</label><input type="password" name="apiKey" autocomplete="off"></div>
      <div class="controls"><button class="btn" type="submit">添加并测试</button><button class="btn secondary" type="button" data-cancel-add>取消</button></div>
      <p class="msg" id="add-msg"></p>
    </form>`;
}

let planInfo = null; // /api/plan
let planConfirmOut = null; // account id whose sign-out is waiting for a second click

/** "Continue with ChatGPT": use the ChatGPT plan as a model source (OpenAI's sign-in for local open-source tools). */
function planCard() {
  const accounts = planInfo?.accounts ?? [];
  const si = planInfo?.signIn;
  const row = a => `
    <div class="row">
      ${icon(a.kind === "copilot" ? "github-copilot-color" : a.kind === "kiro" ? "kiro-color" : a.kind === "antigravity" ? "antigravity-color" : a.kind === "cursor" ? "cursor-color" : a.kind === "kimi" ? "kimi-color" : "openai", "lg")}
      <div class="grow"><div class="title">${esc(a.kind === "copilot" ? "GitHub Copilot · " : "")}${esc(a.label)}${a.email && a.email !== a.label ? ` <span class="hint">${esc(a.email)}</span>` : ""}</div>
        <div class="sub">${a.kind === "kimi" ? `用 Kimi 会员账号登录，令牌存在钥匙串。${a.on ? "已打开：它的模型出现在下面的来源里" : "开关是关的：打开后 agent 才能用"}` : a.kind === "cursor" ? `在浏览器里登录 Cursor，令牌存在钥匙串。${a.on ? "已打开：它的模型出现在下面的来源里" : "开关是关的：打开后 agent 才能用"}<br><span class="quota-out">目前只支持纯文字对话（不能让它执行工具）；用第三方工具调用 Cursor 订阅，账号有被限制的风险，请自己决定要不要打开</span>` : a.kind === "antigravity" ? `用 Google 账号登录，令牌存在钥匙串。${a.on ? "已打开：它的模型出现在下面的来源里" : "开关是关的：打开后 agent 才能用"}<br><span class="quota-out">用第三方工具调用 Antigravity 订阅，账号有被限制的风险，请自己决定要不要打开</span>` : a.kind === "kiro" ? `登录在 Kiro CLI 里，我们每次请求时只读它、不保存令牌。${a.on ? "已打开：它的模型出现在下面的来源里" : "开关是关的：打开后 agent 才能用"}<br><span class="quota-out">用第三方工具调用 Kiro 订阅，账号有被限制的风险，请自己决定要不要打开</span>` : a.needsSignIn ? "登录失效了，需要重新登录" : !a.planUsage ? "已登录，但还没有允许使用订阅额度" : a.on ? "已打开：它的模型出现在下面的来源里，所有 agent 都能选" : "已登录，开关是关的：打开后它的模型才会出现，agent 才能用"}${a.quotaSupport ? `<br>${esc(a.quotaSupport.text)}` : ""}${a.quota && a.on && !a.needsSignIn && a.planUsage ? `<br><span class="${a.quota.exhaustedUntil ? "quota-out" : "quota"}">额度：${esc(a.quota.text)}</span>` : ""}</div></div>
      ${a.needsSignIn || !a.planUsage ? `<span class="chip warn">${a.needsSignIn ? "需要重新登录" : "未授权额度"}</span>` : `<button class="switch ${a.on ? "on" : ""}" role="switch" aria-checked="${a.on ? "true" : "false"}" data-plan-switch="${esc(a.id)}" data-on="${a.on ? "1" : "0"}" title="${a.on ? "点一下关掉：哪里都不会用它" : "点一下打开"}"><span class="knob"></span><span class="lbl">${a.on ? "已打开" : "已关闭"}</span></button>${a.on && a.quota?.exhaustedUntil ? `<span class="chip warn">额度用完了</span>` : ""}`}
      ${a.kind === "kimi" ? `<button class="btn secondary" data-kimi-refresh="${esc(a.id)}">刷新模型</button><button class="btn secondary" data-kimi-remove="${esc(a.id)}">${planConfirmOut === a.id ? "再点一次退出登录" : "退出登录"}</button>` : a.kind === "cursor" ? `<button class="btn secondary" data-cursor-refresh="${esc(a.id)}">刷新模型</button><button class="btn secondary" data-cursor-remove="${esc(a.id)}">${planConfirmOut === a.id ? "再点一次退出登录" : "退出登录"}</button>` : a.kind === "antigravity" ? `<button class="btn secondary" data-antigravity-refresh="${esc(a.id)}">刷新模型</button><button class="btn secondary" data-antigravity-remove="${esc(a.id)}">${planConfirmOut === a.id ? "再点一次退出登录" : "退出登录"}</button>` : a.kind === "kiro" ? `<button class="btn secondary" data-kiro-import>刷新模型</button><button class="btn secondary" data-kiro-remove="${esc(a.id)}">${planConfirmOut === a.id ? "再点一次移除" : "移除"}</button>` : `
      <button class="btn secondary" data-plan-signin-again="${esc(a.id)}" data-plan-kind="${esc(a.kind ?? "open")}">${a.needsSignIn || !a.planUsage ? "重新登录" : "重新登录一次"}</button>
      ${a.planUsage && !a.needsSignIn ? `<button class="btn secondary" data-plan-models="${esc(a.id)}">刷新模型</button>` : ""}
      <button class="btn secondary" data-plan-signout="${esc(a.id)}">${planConfirmOut === a.id ? "再点一次退出登录" : "退出登录"}</button>`}
    </div>`;
  return `
    <div class="section-head"><h2>用你的订阅</h2><span class="aside">登录只在这台电脑上，令牌存在钥匙串里</span></div>
    <div class="card">
      ${accounts.map(row).join("")}
      ${si?.status === "waiting" ? `<div class="row"><div class="grow"><div class="title">${si.userCode ? `在浏览器打开的页面里输入这个码：<span class="mono" style="font-size:20px;letter-spacing:2px">${esc(si.userCode)}</span>` : "已在浏览器里打开登录页"}</div><div class="sub">登录并确认后会自动完成，不用回到这里点什么。没有自动打开的话，<a href="${esc(si.url)}" target="_blank" rel="noopener">点这里打开</a>。</div></div><button class="btn secondary" data-plan-cancel>取消</button></div>` : ""}
      ${si?.status === "error" ? `<div class="row"><div class="grow"><div class="title">没有登录成功</div><div class="sub">${esc(userErrorMessage(si.message ?? "", "source"))}</div></div></div>` : ""}
      ${si?.status === "done" && si.message ? `<div class="row"><div class="grow"><div class="sub">${esc(si.message)}</div></div></div>` : ""}
      <button class="add-row" data-plan-signin>${icon("openai", "sm")} Continue with ChatGPT</button>
      <button class="add-row" data-plan-signin data-plan-mode="copilot">${icon("github-copilot-color", "sm")} 用 GitHub Copilot 订阅</button>
      <button class="add-row" data-kimi-signin>${icon("kimi-color", "sm")} 用 Kimi 会员（设备码登录）</button>
      <button class="add-row" data-cursor-signin>${icon("cursor-color", "sm")} 用 Cursor 订阅（浏览器登录，纯文字）</button>
      <button class="add-row" data-antigravity-signin>${icon("antigravity-color", "sm")} 用 Antigravity 订阅（Google 登录）</button>
      ${(planInfo?.accounts ?? []).some(a => a.kind === "kiro") ? "" : `<button class="add-row" data-kiro-import>${icon("kiro-color", "sm")} 用 Kiro 订阅（读取本机 Kiro CLI 的登录）</button>`}
    </div>
    <p class="hint">ChatGPT 这边用 Codex 的登录身份一步完成（Hermes、opencodex 也是这样做的；这不是 OpenAI 给第三方工具的官方登记方式，所以 OpenAI 以后可能调整）。GitHub Copilot 同理，用的是 VS Code Copilot 插件的登录身份，GitHub 对 Copilot 在官方客户端之外的用法管得比较严，高频自动化调用有被限流的可能。额度和你的 ChatGPT 订阅共用，登录只在这台电脑上，令牌存在钥匙串里。Claude 的订阅不在这里用。</p>`;
}

let poolForm = null; // { id?, name, strategy, members: [] } while the pool form is open
let poolConfirmDel = null;

/** Existing observations only. Unknowns never become a green availability verdict. */
function poolSignalsDetails(pool, nameOf) {
  if (pool.strategy === "automatic") return `<p class="hint">只使用当前已确认身份的被动失败记录，全部等待时暂停；旧额度和失败标记不参与自动选择。未知不代表可用或额度充足。</p>`;
  const signals = Array.isArray(pool.signals?.members) ? pool.signals.members : [];
  if (!signals.length) return `<div class="hint">尚无择源信号；推理可用性未验证。</div>`;
  const moment = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8.64e15 ? new Date(value).toLocaleString() : "时间未知";
  const waiting = (evidence, label) => evidence?.state === "active" ? `${label}至 ${moment(evidence.until)}，不保证届时恢复`
    : evidence?.state === "elapsed" ? `${label}已到期；未验证恢复`
    : evidence?.state === "unknown" ? `${label}时间无法核实` : "";
  const evidence = member => {
    const s = signals.find(item => item.member === member);
    if (!s) return `<p class="hint">${esc(nameOf(member))}：信号未提供；推理可用性未验证。</p>`;
    const effect = { excluded: "配置不允许参与选择，请检查上方原因", later: "现有规则暂时后置，仍可能被尝试", normal: "按原有顺序或轮流策略尝试" };
    const q = s.quota, lines = [Object.hasOwn(effect, s.effect) ? effect[s.effect] : "选择影响未知"];
    const rest = waiting(s.failureWait, "本地失败等待标记"); if (rest) lines.push(rest);
    lines.push(q?.state === "stale" ? "额度记录已过期，当前额度未知" : q?.state === "recorded" ? "有历史额度记录，当前额度未知" : "额度未知，未验证剩余量");
    for (const w of Array.isArray(q?.windows) ? q.windows : []) {
      if (!["primary", "secondary"].includes(w.id) || typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100) continue;
      lines.push(`${w.id === "primary" ? "主" : "次"}窗口历史已用 ${Math.round(w.usedPercent)}%${w.state === "stale" ? "（窗口已过期）" : "（时效未核验）"}${w.vendorResetAt === undefined ? "" : `；厂商曾报告重置时间 ${moment(w.vendorResetAt)}，不保证恢复`}`);
    }
    const quotaWait = waiting(q?.wait, q?.wait?.basis === "vendor_reset" ? "额度记录等待标记（厂商重置提示）" : "额度记录重试等待标记");
    if (quotaWait) lines.push(quotaWait);
    if (q?.updatedAt !== undefined) lines.push(`额度状态记录更新于 ${moment(q.updatedAt)}，不代表各窗口观测时间`);
    const metadata = { passed: "模型列表检查通过，仅为元数据检查", failed: "模型列表连续检查失败，不代表所有生成请求都会失败", stale: "模型列表检查记录已过期", unknown: "模型列表检查结果未知" };
    lines.push(Object.hasOwn(metadata, s.metadata?.state) ? metadata[s.metadata.state] : metadata.unknown);
    if (s.metadata?.checkedAt !== undefined) lines.push(`模型列表检查时间 ${moment(s.metadata.checkedAt)}`);
    lines.push("推理可用性未验证");
    return `<p class="hint"><strong>${esc(nameOf(member))}</strong><br>${lines.map(esc).join("<br>")}</p>`;
  };
  return `<details data-keep="pool-signals:${esc(pool.id)}" ${keepOpen(`pool-signals:${pool.id}`)}>
    <summary class="hint">查看选择依据（当前可用性未验证）</summary>
    <p class="hint">只读取已有记录，不发送检查请求。等待标记和额度记录未核验当前账号、Key或端点；未知不等于有余量。全部成员有等待标记时，现有策略仍可能尝试，不会自动改成暂停。</p>
    ${pool.members.map(evidence).join("")}
  </details>`;
}

/** Model pools: catalog eligibility and attempts are not proof of live availability. */
function poolsCard() {
  const pools = state.pools ?? [];
  const nameOf = key => { const i = key.indexOf("/"); const p = providerById(key.slice(0, i)); return `${key.slice(i + 1)}${p ? `（${p.name}）` : ""}`; };
  const reasons = { catalog_eligible: "配置允许参与选择", source_missing: "找不到来源记录", source_disabled: "来源已关闭", budget_blocked: "预算暂停，请检查预算和记账状态", model_missing: "当前目录未列出此模型", unsupported: "当前传输尚不支持", unknown_excluded: "暂不参与选择，原因未提供" };
  const memberText = (p, member) => {
    const status = p.memberStates?.find(s => s.member === member);
    const reason = status && Object.hasOwn(reasons, status.reason) ? reasons[status.reason]
      : p.live?.includes(member) ? reasons.catalog_eligible : reasons.unknown_excluded;
    return `${esc(nameOf(member))} · ${reason}`;
  };
  const row = p => `
    <div class="row">
      <span class="ic lg" style="display:grid;place-items:center;background:var(--pill);border-radius:10px;width:34px;height:34px">▦</span>
      <div class="grow"><div class="title">${esc(p.name)} <span class="hint">pool/${esc(p.id)}</span> <span class="chip">${p.strategy === "automatic" ? "已确认名单内自动选择" : p.strategy === "rotate" ? "轮流优先尝试" : "按顺序尝试"}</span></div>
        <div class="sub">${p.members.map(m => memberText(p, m)).join(" → ")}</div>${poolSignalsDetails(p, nameOf)}</div>
      ${p.strategy === "automatic" ? `<button class="btn secondary" data-automatic-manage="${esc(p.id)}">重新确认来源</button>` : `<button class="btn secondary" data-pool-edit="${esc(p.id)}">编辑</button>`}
      <button class="btn secondary" data-pool-del="${esc(p.id)}">${poolConfirmDel === p.id ? "再点一次删除" : "删除"}</button>
    </div>`;
  const options = state.providers.map(p => `
    <div class="field"><label>${esc(p.name)}</label>
      <div class="controls">${modelsOf(p).map(m => `<label style="display:flex;gap:4px;align-items:center"><input type="checkbox" name="members" value="${esc(`${p.id}/${m}`)}" ${poolForm?.members.includes(`${p.id}/${m}`) ? "checked" : ""}>${esc(m)}</label>`).join("") || `<span class="hint">还没有模型</span>`}</div></div>`).join("");
  const form = poolForm ? `
    <form class="form" data-pool-form>
      <div class="field"><label>名字（agent 里会看到 pool/名字）</label><input type="text" name="name" value="${esc(poolForm.name)}" required placeholder="比如 sonnet"></div>
      <div class="field"><label>怎么选</label><select name="strategy"><option value="order" ${poolForm.strategy === "order" ? "selected" : ""}>按顺序：优先尝试前面的来源</option><option value="rotate" ${poolForm.strategy === "rotate" ? "selected" : ""}>轮流：轮换优先尝试的来源</option></select></div>
      ${options}
      <div class="controls"><button class="btn" type="submit">保存</button><button class="btn secondary" type="button" data-pool-cancel>取消</button></div>
      ${poolForm.error ? `<p class="hint" style="color:var(--bad)">${esc(poolForm.error)}</p>` : ""}
    </form>` : "";
  return `
    <div class="section-head"><h2>模型池</h2><span class="aside">同一个模型的多个来源合成一个名字</span></div>
    <p class="hint">可参与选择只代表配置允许，不代表来源实际可用或额度充足。仅在开始回复前遇到可重试错误时改试其他候选；不是每次失败都会切换，也不保证重试成功。</p>
    <div class="card">
      ${pools.map(row).join("")}
      ${typeof poolSuggestionsCard === "function" ? poolSuggestionsCard() : ""}
      ${form}
      ${poolForm ? "" : `<button class="add-row" data-pool-new>＋ 新建模型池</button>`}
    </div>`;
}

function renderProviders() {
  return `
    ${planCard()}
    ${typeof cliTextSourcesCard === "function" ? cliTextSourcesCard() : ""}
    ${typeof subscriptionSupportCard === "function" ? subscriptionSupportCard() : ""}
    <div class="section-head"><h2>模型来源</h2><span class="aside">支持中转站、官方 API 和本地模型；导入后请核对并开启</span></div>
    <div class="card">
      ${state.providers.map(providerRow).join("") || `<div class="empty">还没有模型来源</div>`}
      ${typeof providerImportCard === "function" ? providerImportCard() : ""}
      ${vertexForm ? renderVertexForm() : ""}
      ${addForm ? renderAddForm() : `<button class="add-row" data-add>＋ 添加模型来源</button><button class="add-row" data-vertex-open>${icon("gemini-color", "sm")} 添加 Google Vertex AI（服务账号）</button><button class="add-row" data-provider-import-open>从其他工具导入</button>`}
    </div>
    ${state.providers.length ? poolsCard() : ""}`;
}

async function submitAdd(form) {
  if (addForm?.preset?.unavailable) { render(); return; }
  const data = Object.fromEntries(new FormData(form));
  // Placeholder values travel as their own object; the preset (not the page) decides the wire details.
  data.urlParams = Object.fromEntries(Object.entries(data).filter(([k]) => k.startsWith("param:")).map(([k, v]) => [k.slice(6), v]));
  for (const k of Object.keys(data)) if (k.startsWith("param:")) delete data[k];
  if (addForm.preset) data.presetId = addForm.preset.id;
  if (addForm.preset?.vertexMode) {
    data.vertex = addForm.preset.vertexMode === "standard" ? { mode: "standard", auth: "access-token", project: data.vertexProject, location: data.vertexLocation } : { mode: "express", auth: "api-key" };
    delete data.vertexProject; delete data.vertexLocation;
  }
  const msg = $("#add-msg");
  msg.className = "msg";
  msg.textContent = "正在添加并读取模型列表…";
  try {
    const p = await call("POST", "/api/providers", data);
    const want = addForm.preset?.defaultModel;
    const model = want && p.models.includes(want) ? want : p.models.length === 1 ? p.models[0] : null;
    addForm = null;
    openProvider = p.id;
    if (model && !p.vertex) {
      toast(`已添加「${p.name}」，正在用 ${model} 做一致性测试…`);
      await call("POST", `/api/providers/${p.id}/probe`, { model });
    } else {
      toast(`已添加「${p.name}」，读到 ${p.models.length} 个模型；选一个做一致性测试`);
    }
  } catch (error) {
    msg.className = "msg bad";
    msg.textContent = userErrorMessage(error);
    return;
  }
  await refresh(true);
}

// ---------------------------------------------------------------- sessions

function explain(e) {
  // Any agent can be in the log, not just the two with their own rows.
  const harness = HARNESS[e.harness ?? "codex"] ?? { ...agentMeta(e.harness), protocol: "Chat" };
  const provider = providerById(e.providerId ?? e.model.split("/")[0]);
  const pname = provider?.name ?? e.providerId ?? "未知来源";
  const parts = [];
  if (e.pool) {
    parts.push(`走的是模型池 ${e.pool}，第 ${e.attempt}/${e.attempts} 个候选`);
    // Only the subsequent handler's own evidence proves it was attempted. An
    // earlier failed log, a candidate count or an old record cannot prove that.
    if (e.retryFrom && Number.isInteger(e.attempt) && e.attempt > 1 && e.retryFrom.attempt === e.attempt - 1
      && ([401, 403, 429].includes(e.retryFrom.status) || Number.isInteger(e.retryFrom.status) && e.retryFrom.status >= 500 && e.retryFrom.status <= 599))
      parts.push(`上个候选在开始回复前失败，本次已改试第 ${e.attempt} 个候选；不代表已向来源发出请求或重试成功`);
  }
  if (e.inboundProtocol && e.outboundProtocol) parts.push(e.inboundProtocol === e.outboundProtocol
    ? `来源支持 ${PROTOCOL[e.inboundProtocol]}，保留原生请求与回复`
    : `${PROTOCOL[e.inboundProtocol]} → ${PROTOCOL[e.outboundProtocol]}，按来源转换请求与回复`);
  else if (e.route === "chat-translate") parts.push(`这个来源不支持 ${harness.protocol} 协议，EasySwitch 把请求翻译成 Chat 协议转发`);
  else parts.push(`这个来源原生支持 ${harness.protocol} 协议，请求原样转发`);
  if (e.dropped?.length) parts.push(`去掉了${e.dropped.map(d => TOOL_NAMES[d] ?? d.replace(/^tool:/, "")).join("、")}（目标协议不支持这些内容或参数）`);
  if(e.fallback)parts.push(`发送前换用备用：${e.fallback.fromModel} → ${e.fallback.toModel}（${e.fallback.reason === "quota_exhausted" ? "主来源额度暂不可用" : "主来源轻量检查不可用"}）`);
  if (e.note) parts.push(e.status >= 400 ? userErrorMessage({status:e.status,message:e.note},"source") : e.note);
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
  // The two with their own rows, plus any other agent that has made a request lately.
  const flowAgents = [...new Set([...Object.keys(HARNESS), ...recent.map(e => e.harness).filter(h => h && h !== "chat")])];
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
      <div class="col">${flowAgents.map(h => `
        <div class="node ${agentActive(h) ? "active" : "idle"}" data-node="a:${esc(h)}">${icon(agentMeta(h).icon, "lg")}
          <div><div class="t">${esc(agentMeta(h).name)}</div><div class="s">${sessionsOf(h).length ? `${sessionsOf(h).length} 个增强会话` : agentActive(h) ? "正在用 EasySwitch" : "原生"}</div></div></div>`).join("")}
      </div>
      <div class="col"><div class="node hub" data-node="hub"><span class="logo">⇄</span><div class="t">EasySwitch</div><div class="s">127.0.0.1:${state.port}</div></div></div>
      <div class="col">${providerIds.map(providerNode).join("") || `<div class="hint">还没有用到任何模型来源</div>`}</div>
    </div></div>

    <div class="section-head"><h2>运行中的增强会话</h2></div>
    <div class="card">${running.length ? `<table class="tbl"><tr><th>Agent</th><th>模型</th><th>启动于</th><th>进程</th><th></th></tr>
      ${running.map(s => `<tr><td>${icon(agentMeta(s.harness).icon, "sm")} ${esc(agentMeta(s.harness).name)}</td><td class="mono">${esc(s.model ?? "")}</td>
        <td>${s.startedAt ? ago(s.startedAt) : "—"}</td><td class="mono">${s.pid}</td>
        <td class="num"><span class="hint">关闭对应终端后，在 Agent 页撤销令牌</span></td></tr>`).join("")}</table>`
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
  for (const h of [...new Set([...Object.keys(HARNESS), ...state.log.map(e => e.harness).filter(x => x && x !== "chat")])]) {
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
  const cost = chartMetric === "cost";
  const values = days.map(d => cost ? d.costUsd : d.inputTokens + d.outputTokens);
  const fmt = v => cost ? usageMoney(v, state?.display, v >= 1 ? 0 : 2) : compact(v);
  const W = host.clientWidth - 36, H = 200, left = 46, bottom = 22, top = 8;
  const plotW = W - left, plotH = H - bottom - top;
  const max = niceMax(Math.max(...values, 0));
  const slot = plotW / Math.max(days.length, 1);
  const bw = Math.min(24, slot * 0.62);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => max * f);
  const y = v => top + plotH - (v / max) * plotH;
  const labelEvery = Math.max(1, Math.ceil(days.length / 7));
  const svg = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${cost ? "每日已记录估算费用柱状图" : "每日 token 用量柱状图"}">
      <g class="grid">${ticks.map(t => `<line x1="${left}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/>`).join("")}</g>
      <g class="axis">${ticks.map(t => `<text x="${left - 8}" y="${y(t) + 4}" text-anchor="end">${fmt(t)}</text>`).join("")}
        ${days.map((d, i) => i % labelEvery === 0 ? `<text x="${left + slot * i + slot / 2}" y="${H - 4}" text-anchor="middle">${d.day.slice(5).replace("-", "/")}</text>` : "").join("")}</g>
      ${values.map((v, i) => v > 0 ? `<path class="bar" d="${barPath(left + slot * i + (slot - bw) / 2, y(v), bw, top + plotH - y(v))}"/>` : "").join("")}
      ${days.map((d, i) => `<rect class="bar-hit" data-i="${i}" x="${left + slot * i}" y="${top}" width="${slot}" height="${plotH}"/>`).join("")}
    </svg>`;
  host.innerHTML = `${svg}${values.every(v => v === 0) ? `<div class="empty" style="position:absolute;inset:0;display:grid;place-items:center;pointer-events:none">${esc(cost ? usageCostPresentation(usage.totals, state?.display).text : usage.totals.calls ? "已记录 token 为 0" : "这段时间还没有调用记录")}</div>` : ""}`;
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  host.append(tip);
  host.querySelector("svg").addEventListener("mousemove", e => {
    const hit = e.target.closest(".bar-hit");
    if (!hit) { tip.hidden = true; return; }
    const d = days[Number(hit.dataset.i)];
    const price = usageCostPresentation(d, state?.display);
    tip.innerHTML = `<b>${esc(d.day)}</b><br>${thousands(d.inputTokens + d.outputTokens)} tokens · ${d.calls} 次调用<br>${esc(price.text)}${price.provenance ? `<br>${esc(price.provenance)}` : ""}<br>${esc(usageCoverage(d))}`;
    const hb = host.getBoundingClientRect();
    tip.style.left = `${e.clientX - hb.left}px`;
    tip.style.top = `${e.clientY - hb.top - 10}px`;
    tip.hidden = false;
  });
  host.querySelector("svg").addEventListener("mouseleave", () => { tip.hidden = true; });
}

/** Historical evidence only: current provider billing must never hide old money. */
function costCell(v) {
  const price = usageCostPresentation(v, state?.display);
  const evidence = [price.provenance, usageCoverage(v)].filter(Boolean).join(" · ");
  return `<span title="${esc(evidence)}">${esc(price.headline)}${price.details.map(detail => `<br><span class="hint">${esc(detail)}</span>`).join("")}</span>`;
}

function renderUsage() {
  const pending = !!usageRequest;
  const header = `<div class="section-head"><h2>用量</h2>
    <span style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <nav class="seg" id="currency"><button data-currency="CNY" class="${state?.display?.currency === "CNY" ? "on" : ""}">¥</button><button data-currency="USD" class="${state?.display?.currency !== "CNY" ? "on" : ""}">$</button></nav>
      <nav class="seg" id="range">${Object.entries(usageRanges).map(([k, v]) => `<button data-range="${k}" class="${usageRange === k ? "on" : ""}">${v}</button>`).join("")}</nav>
      <button class="btn secondary" data-usage-retry aria-disabled="${pending}" ${pending ? 'style="opacity:.55;cursor:wait"' : ""}>${pending ? "正在读取…" : usageError ? "重试" : "刷新用量"}</button>
    </span></div>`;
  const status = usageError ? `${usageError}${usage ? "当前显示上次成功读取的数据，可能已过期。" : "请重试或选择其他时间范围。"}`
    : pending ? usage ? "正在刷新用量，当前显示上次成功读取的数据。" : "正在读取用量…" : "";
  const notice = status ? `<div class="${usage ? "hint" : "card empty"}" role="status" ${usageError ? 'style="color:var(--bad)"' : ""}>${esc(status)}</div>` : "";
  if (!usage) return `${header}${notice || '<div class="card empty">正在读取用量…</div>'}`;
  const t = usage.totals;
  const hit = usage.cacheHitRate == null ? "—" : `${Math.round(usage.cacheHitRate * 100)}%`;
  const providerRows = Object.entries(usage.byProvider).sort((a, b) => b[1].calls - a[1].calls).map(([id, v]) => {
    const p = providerById(id);
    return `<tr><td>${p ? icon(p.icon, "sm") : ""} ${esc(p?.name ?? id)}</td><td class="num">${thousands(v.calls)}</td>
      <td class="num">${compact(v.inputTokens)}</td><td class="num">${compact(v.outputTokens)}</td>
      <td class="num">${v.inputTokens ? `${Math.round((v.cachedTokens / v.inputTokens) * 100)}%` : "—"}</td><td class="num">${v.errors}</td>
      <td class="num">${costCell(v)}</td></tr>`;
  }).join("");
  const harnessRows = Object.entries(usage.byHarness).map(([h, v]) => `
    <tr><td>${icon(HARNESS[h]?.icon ?? "newapi-color", "sm")} ${HARNESS[h]?.name ?? esc(h)}</td><td class="num">${thousands(v.calls)}</td>
      <td class="num">${compact(v.inputTokens)}</td><td class="num">${compact(v.outputTokens)}</td><td class="num">${v.errors}</td>
      <td class="num">${costCell(v)}</td></tr>`).join("");
  const price = usageCostPresentation(t, state?.display);
  const costTile = `<div class="tile"><div class="v">${esc(price.value)}</div><div class="l">已记录估算费用</div><div class="d">${esc([...price.details, price.provenance].filter(Boolean).join(" · ") || (t.calls ? "仅显示日志记录金额" : "还没有调用记录"))}</div></div>`;
  return `${header}${notice}
    <div class="card tiles">
      <div class="tile"><div class="v">${compact(t.inputTokens + t.outputTokens)}</div><div class="l">Token</div><div class="d">输入 ${compact(t.inputTokens)} · 输出 ${compact(t.outputTokens)}</div></div>
      <div class="tile"><div class="v">${compact(t.cachedTokens)}</div><div class="l">缓存读取</div><div class="d">命中率 ${hit}</div></div>
      <div class="tile"><div class="v">${thousands(t.calls)}</div><div class="l">调用次数</div><div class="d">${esc(usageCoverage(t))}</div></div>
      ${costTile}
      <div class="tile"><div class="v">${thousands(t.errors)}</div><div class="l">失败</div><div class="d">${t.calls ? `占 ${Math.round((t.errors / t.calls) * 100)}%` : "—"}</div></div>
    </div>
    <p class="hint">${esc(usageDisplayLimits(state?.display))}</p>
    <div class="card"><div class="section-head" style="padding:12px 18px 0"><span class="hint">每日</span>
        <nav class="seg" id="metric"><button data-metric="tokens" class="${chartMetric === "tokens" ? "on" : ""}">Token</button><button data-metric="cost" class="${chartMetric === "cost" ? "on" : ""}">花费</button></nav></div>
      <div class="chart" id="chart"></div>
      <details data-keep="usage-days" ${keepOpen("usage-days")} style="padding:0 18px 12px"><summary class="hint">查看每日数据表</summary>
        <table class="tbl"><tr><th>日期</th><th class="num">输入</th><th class="num">输出</th><th class="num">调用</th><th class="num">估算花费</th></tr>
        ${usage.days.map(d => `<tr><td>${d.day}</td><td class="num">${thousands(d.inputTokens)}</td><td class="num">${thousands(d.outputTokens)}</td><td class="num">${d.calls}</td><td class="num">${costCell(d)}</td></tr>`).join("")}</table>
      </details>
    </div>
    <div class="section-head"><h2>按模型来源</h2></div>
    <div class="card">${providerRows ? `<table class="tbl"><tr><th>来源</th><th class="num">调用</th><th class="num">输入</th><th class="num">输出</th><th class="num">缓存命中</th><th class="num">失败</th><th class="num">估算花费</th></tr>${providerRows}</table>` : `<div class="empty">还没有用量</div>`}</div>
    <div class="section-head"><h2>按 Agent</h2></div>
    <div class="card">${harnessRows ? `<table class="tbl"><tr><th>Agent</th><th class="num">调用</th><th class="num">输入</th><th class="num">输出</th><th class="num">失败</th><th class="num">估算花费</th></tr>${harnessRows}</table>` : `<div class="empty">还没有用量</div>`}</div>`;
}

/** Replace only usage output: budget fields and other pages keep their live DOM/focus. */
function updateUsageView() {
  if (page !== "usage") return;
  const host = $("#usage-content");
  if (!host) return;
  const active = document.activeElement;
  const focused = host.contains?.(active);
  const focusKey = focused ? ["range", "currency", "metric", "usageRetry"].find(key => Object.hasOwn(active?.dataset ?? {}, key)) : null;
  const focusKeep = focused && active?.tagName === "SUMMARY" ? active.parentElement?.dataset.keep : null;
  const focusValue = focusKey ? active.dataset[focusKey] : null;
  host.innerHTML = renderUsage();
  // Keep keyboard selection on the same control when its data/status changes.
  if (focusKey) [...host.querySelectorAll("button")].find(button => Object.hasOwn(button.dataset, focusKey) && button.dataset[focusKey] === focusValue)?.focus({ preventScroll: true });
  if (focusKeep) [...host.querySelectorAll("details[data-keep]")].find(details => details.dataset.keep === focusKeep)?.querySelector("summary")?.focus({ preventScroll: true });
  requestAnimationFrame(drawChart);
}

/** Aborting a read never cancels any model request or changes the ledger. */
function cancelUsageLoad() {
  const request = usageRequest;
  if (!request) return;
  usageRequest = null;
  clearTimeout(request.timer);
  request.controller.abort();
  request.cancel();
}

function loadUsage() {
  if (page !== "usage") return Promise.resolve();
  const range = usageRange, navigation = pageNavigationVersion;
  if (usageRequest?.range === range && usageRequest.navigation === navigation) return usageRequest.promise;
  cancelUsageLoad();
  if (usage?.range !== range) usage = null;
  usageError = "";
  const request = { range, navigation, controller: new AbortController(), promise: null, timer: null, cancel: null, timedOut: false };
  usageRequest = request;
  const current = () => usageRequest === request && page === "usage" && pageNavigationVersion === navigation && usageRange === range;
  const deadline = new Promise((_, reject) => {
    request.cancel = () => reject(new Error("Usage read cancelled"));
    request.timer = setTimeout(() => {
      request.timedOut = true;
      request.controller.abort();
      reject(new Error("Usage read timed out"));
    }, 10_000);
  });
  request.promise = (async () => {
    try {
      const next = await Promise.race([call("GET", `/api/usage?range=${range}`, undefined, { signal: request.controller.signal }), deadline]);
      if (!current()) return;
      if (next?.range !== range || !next.totals || !Array.isArray(next.days) || !next.byProvider || !next.byHarness) throw new Error("Invalid usage response");
      usage = next;
    } catch (error) {
      if (current()) usageError = error?.code === "usage_range_too_large"
        ? errorPresentation({ code: "usage_range_too_large" }).message
        : `${usage ? "刷新" : "读取用量"}${request.timedOut ? "超时" : "失败"}。`;
    } finally {
      clearTimeout(request.timer);
      if (usageRequest === request) {
        usageRequest = null;
        updateUsageView();
      }
    }
  })();
  updateUsageView();
  return request.promise;
}

// ---------------------------------------------------------------- render loop

// Restore only an unambiguous, still-enabled action on the same rendered page.
// Never use its position or visible label: either can now belong to another record.
let renderedPage = null;
function preserveActionFocus(main) {
  const active = document.activeElement;
  if (renderedPage !== page || !main?.contains?.(active) || !active?.matches?.("button, a, summary")) return () => {};
  const identity = element => {
    const parts = [];
    for (let node = element; node && node !== main; node = node.parentElement) {
      const keys = Object.entries(node.dataset ?? {}).sort(([a], [b]) => a.localeCompare(b));
      const id = node.getAttribute?.("id"), href = node.getAttribute?.("href");
      if (id || href || keys.length) parts.push([node.tagName, id, href, keys]);
    }
    // These actions get their target from a nearby selection, not their own data attributes.
    // A redraw may reset that selection; never carry keyboard activation onto another target.
    if (element.matches?.("[data-profile-apply], [data-profile-del]")) parts.push(["profile", main.querySelector("[data-profile-pick]")?.value]);
    if (element.matches?.("[data-probe], [data-protocol-auto]")) {
      const detail = element.closest?.("[data-provider]");
      const selector = element.matches("[data-probe]") ? ".probe-model" : "[data-protocol-model]";
      parts.push(["model", detail?.querySelector(selector)?.value]);
    }
    return parts.length ? JSON.stringify([element.tagName, parts]) : null;
  };
  const key = identity(active);
  const candidates = () => [...main.querySelectorAll("button, a, summary")].filter(node => identity(node) === key);
  if (!key || candidates().length !== 1) return () => {};
  return () => {
    const matches = candidates();
    const target = matches.length === 1 ? matches[0] : null;
    if (target && !target.disabled && target.getAttribute?.("aria-disabled") !== "true" && !target.closest?.("[hidden], [inert]")) target.focus({ preventScroll: true });
  };
}

function render() {
  renderHeader();
  const main = $("#page");
  const restoreFocus = preserveActionFocus(main);
  renderedPage = page;
  try {
    if (page === "doctor" && typeof renderDoctor === "function") {main.innerHTML=(typeof firstRunResumeCard === "function" ? firstRunResumeCard() : "") + renderDoctor();return;}
    if (!state && page !== "usage") {
      main.innerHTML = `${page === "settings" ? globalThis.EasySwitchTheme?.controls() ?? "" : ""}<div class="card empty">连不上 EasySwitch 核心服务。从菜单栏启动它，或在终端运行 <code>node core/src/main.ts</code>。</div>`;
      return;
    }
    const views = { agents: renderAgents, providers: renderProviders, settings: renderSettings, accounts: renderSettings, sessions: renderSessions, usage: renderUsage, doctor: typeof renderDoctor === "function" ? renderDoctor : renderAgents };
    main.innerHTML = page === "usage" ? `<section id="usage-content">${renderUsage()}</section>` : (views[page] ?? renderAgents)();
    if (typeof automaticToolCard === "function" && page === "agents") main.innerHTML = automaticToolCard() + main.innerHTML;
    if (typeof automaticPoolCard === "function" && page === "agents") main.innerHTML = automaticPoolCard() + main.innerHTML;
    if (typeof firstRunResumeCard === "function") main.innerHTML = firstRunResumeCard() + main.innerHTML;
    if (!PANEL && page === "agents" && typeof gatewaySessionsCard === "function") main.innerHTML += gatewaySessionsCard();
    if (page === "usage" && typeof budgetSettingsCard === "function") main.innerHTML += budgetSettingsCard();
    if (page === "sessions") requestAnimationFrame(drawFlowLines);
    if (page === "usage") requestAnimationFrame(drawChart);
  } finally { restoreFocus(); }
}

/** Re-render unless the user is in the middle of something we would wipe out. */
function busy() {
  return (typeof automaticToolFlight !== "undefined" && automaticToolFlight) || (typeof automaticPoolReview !== "undefined" && automaticPoolReview?.busy) || (typeof providerImportOpen !== "undefined" && (providerImportOpen || providerImportBusy)) || (typeof poolSuggestionBusy !== "undefined" && poolSuggestionBusy) || (typeof doctorBusy !== "undefined" && doctorBusy) || (typeof firstRun !== "undefined" && firstRun.busy) || providerOperations.size > 0 || (typeof cliTextBusy !== "undefined" && cliTextBusy) || (typeof cliTextFormOpen !== "undefined" && cliTextFormOpen) || guideBusy || (typeof budgetSaving !== "undefined" && budgetSaving) || claudeDesktopBusy || claudeDesktopConfirm || popover || addForm || vertexForm || importFormOpen || poolForm || profileNaming || document.activeElement?.matches("input, select, textarea, [data-theme-choice]");
}
document.addEventListener("change", async e => {
  const fallback=e.target.closest?.("[data-fallback-select]");
  if(fallback){fallback.disabled=true;try{await call("PUT",`/api/bindings/${encodeURIComponent(fallback.dataset.fallbackSelect)}/fallback`,{model:fallback.value});toast(fallback.value?"已保存备用模型":"已取消备用模型");}catch(error){showError(error);}finally{fallback.disabled=false;await refresh(true);}return;}
  const health=e.target.closest?.("[data-source-health]");
  if(health){health.disabled=true;try{await call("PUT",`/api/providers/${encodeURIComponent(health.dataset.sourceHealth)}/health`,{enabled:health.checked});toast(health.checked?"已允许轻量检查；请点击检查一次完成验证":"已关闭轻量检查");}catch(error){showError(error);}finally{health.disabled=false;await refresh(true);}return;}
  const desktopModel = e.target.closest?.("[data-claude-desktop-model]");
  if (desktopModel) { claudeDesktopModel = desktopModel.value; claudeDesktopConfirm = false; claudeDesktopError = ""; render(); return; }
  const sel = e.target.closest?.("[data-effort-select]");
  if (!sel) return;
  try {
    await call("PUT", `/api/bindings/${sel.dataset.effortSelect}/effort`, { effort: sel.value });
    toast(sel.value ? `推理档位设为 ${sel.value}，下次启动生效` : "推理档位恢复为它自己的默认");
  } catch (error) { showError(error); }
  await refresh(true);
});
/** The onboarding card keeps its state between renders (the user is typing into it). */
let importFormOpen = false;

/** Result covers the core snapshot (or the dedicated doctor/usage read), not every optional panel. */
async function refresh(force = false) {
  const navigation = pageNavigationVersion;
  if (page !== "usage") cancelUsageLoad();
  else if (!$("#usage-content")) render();
  // Start the bounded read immediately, even if the general state read is slow.
  const usageRefresh = page === "usage" ? loadUsage() : null;
  if (page === "doctor" && typeof loadDoctor === "function") {
    if (doctorBusy) return false;
    if (force || !doctorReport) await loadDoctor();
    if (navigation !== pageNavigationVersion) return false;
    render(); return !!doctorReport && !doctorError;
  }
  let nextState;
  try {
    nextState = await call("GET", "/api/state");
  } catch {
    nextState = null;
  }
  if (navigation !== pageNavigationVersion) return false;
  state = nextState;
  if (typeof automaticToolSync === "function") automaticToolSync();
  if (state && !PANEL && !state.providers.length && !presets.length) presets = await call("GET", "/api/presets").catch(() => []);
  if (navigation !== pageNavigationVersion) return false;
  if (typeof firstRunSync === "function" && state) firstRunSync();
  if (page === "providers" || PANEL) planInfo = await call("GET", "/api/plan").catch(() => planInfo);
  if (page === "agents" && !PANEL) {
    chatgptInfo = await call("GET", "/api/chatgpt").catch(() => chatgptInfo);
    claudeDesktopInfo = await call("GET", "/api/claude-desktop").catch(() => null);
  }
  if (page === "agents" && !PANEL && !agentList) {
    agentList = await loadAgents();
    if (agentList) force = true;
  }
  if (page === "doctor" && typeof loadDoctor === "function" && !doctorBusy && (force || !doctorReport)) await loadDoctor();
  if (navigation !== pageNavigationVersion) return false;
  if (page === "usage") {
    const host = $("#usage-content");
    if (!host || (!busy() && !host.contains?.(document.activeElement))) render();
    else { renderHeader(); updateUsageView(); }
    await usageRefresh;
    return navigation === pageNavigationVersion && !!usage && !usageError;
  }
  if (force || !busy()) render();
  else renderHeader();
  return !!nextState;
}

// Explicit navigation adds one visit; hashchange handles Back/Forward without adding another.
async function navigatePage(value) {
  const next = pageOf(value);
  if (next === page) return;
  claudeDesktopConfirm = false;
  if (typeof automaticPoolInvalidate === "function") automaticPoolInvalidate();
  if (typeof cancelDoctorCheck === "function" && page === "doctor") cancelDoctorCheck();
  pageNavigationVersion++;
  cancelUsageLoad();
  page = next;
  if (!PANEL && location.hash !== `#${page}`) {
    const writeHistory = history.pushState ?? history.replaceState;
    writeHistory.call(history, null, "", `#${page}`);
  }
  closePopover();
  if (page === "usage") render();
  await refresh(true);
}

// ---------------------------------------------------------------- events

document.addEventListener("click", async e => {
  if(e.target.closest?.("[data-skip-content]")){e.preventDefault();$("#page")?.focus?.();return;}
  const theme=e.target.closest?.("[data-theme-choice]");
  if(theme){globalThis.EasySwitchTheme?.set(theme.dataset.themeChoice);return;}

  const sourceSwitch=e.target.closest?.("[data-source-switch]");
  if(sourceSwitch){e.stopImmediatePropagation();if(sourceSwitch.disabled)return;sourceSwitch.disabled=true;try{await call("PUT",`/api/providers/${encodeURIComponent(sourceSwitch.dataset.sourceSwitch)}/switch`,{on:sourceSwitch.dataset.enabled!=="1"});await refresh(true);}catch(error){showError(error);}finally{sourceSwitch.disabled=false;}return;}

  const healthCheck=e.target.closest?.("[data-source-health-check]");
  if(healthCheck){e.stopImmediatePropagation();if(healthCheck.disabled)return;healthCheck.disabled=true;try{await call("POST",`/api/providers/${encodeURIComponent(healthCheck.dataset.sourceHealthCheck)}/health/check`,{});await refresh(true);}catch(error){showError(error);}finally{healthCheck.disabled=false;}return;}

  const t = e.target;
  if (popover && !popover.contains(t) && !t.closest("[data-pick], #guard-chip")) closePopover();

  const nav = t.closest("#nav button, [data-go]");
  if (nav) {
    if (nav.disabled || nav.getAttribute?.("aria-disabled") === "true") return;
    await navigatePage(nav.dataset.page ?? nav.dataset.go);
    return;
  }
  if (t.closest("#refresh")) {
    const navigation = pageNavigationVersion;
    const refreshed = await refresh(true);
    if (navigation === pageNavigationVersion && page !== "usage") {
      const subject = page === "doctor" ? "自检状态" : "核心状态";
      toast(refreshed ? `${subject}已刷新` : `${subject}未刷新，请稍后重试`);
    }
    return;
  }
  if (t.closest("#guard-chip")) { if (popover) closePopover(); else if (state) openGuard($("#guard-chip")); return; }

  const pick = t.closest("[data-pick]");
  if (pick) { if (popover) closePopover(); else openPicker(pick, pick.dataset.pick); return; }

  const launch = t.closest("[data-launch]");
  if (launch) {
    launch.disabled = true;
    try {
      const { model } = await call("POST", `/api/launch/${launch.dataset.launch}`);
      toast(`已在终端里打开 ${HARNESS[launch.dataset.launch].name} 增强会话（${model}）`);
    } catch (error) { showError(error); }
    setTimeout(() => refresh(true), 1500);
    return;
  }

  const bridge = t.closest("[data-bridge]");
  if (bridge) {
    if (BRIDGE) BRIDGE.postMessage(bridge.dataset.bridge);
    else if (bridge.dataset.bridge === "openConsole") window.open("/", "_blank");
    return;
  }

  const accLaunch = t.closest("[data-acc-launch]");
  if (accLaunch) {
    try { const r = await call("POST", "/api/accounts/launch", { harness: accLaunch.dataset.h, accountId: accLaunch.dataset.accLaunch }); toast(`已在终端里打开「${r.account.label}」`); } catch (error) { showError(error); }
    setTimeout(() => refresh(true), 800);
    return;
  }
  const accAuto = t.closest("[data-acc-auto]");
  if (accAuto) {
    if (accAuto.disabled) return;
    accAuto.disabled = true;
    try { const r = await call("POST", "/api/accounts/launch", { harness: accAuto.dataset.accAuto }); toast(`自动选了「${r.account.label}」`); } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  const accRest = t.closest("[data-acc-rest]");
  if (accRest) {
    try { await call("PATCH", `/api/accounts/${accRest.dataset.accRest}`, { rest: accRest.dataset.on === "1" }); } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  const accToggle = t.closest("[data-acc-toggle]");
  if (accToggle) {
    try { await call("PATCH", `/api/accounts/${accToggle.dataset.accToggle}`, { enabled: accToggle.dataset.enabled === "1" }); } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  const accDel = t.closest("[data-acc-del]");
  if (accDel) {
    try { const r = await call("DELETE", `/api/accounts/${accDel.dataset.accDel}`); toast("已移除；登录目录仍保留在 " + r.keptDirectory); } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  const accAutoPick = t.closest("[data-acc-autopick]");
  if (accAutoPick) {
    const mode = accAutoPick.dataset.accAutopick;
    if (mode === "ask") { autoConfirm = true; render(); return; }
    if (mode === "cancel") { autoConfirm = false; render(); return; }
    autoConfirm = false;
    try { await call("PUT", "/api/accounts/settings", { autoPick: mode === "on" }); } catch (error) { showError(error); }
    await refresh(true);
    return;
  }

  const gAsk = t.closest("[data-chatgpt-ask]");
  if (gAsk) { chatgptConfirm = gAsk.dataset.chatgptAsk; render(); return; }
  if (t.closest("[data-chatgpt-cancel]")) { chatgptConfirm = null; render(); return; }
  const gGo = t.closest("[data-chatgpt-go]");
  if (gGo) {
    const mode = gGo.dataset.chatgptGo;
    chatgptConfirm = null;
    gGo.disabled = true;
    toast("正在重启 ChatGPT…");
    try {
      const r = await call("POST", `/api/chatgpt/${mode}`, { restart: true });
      toast(mode === "enhance" ? "ChatGPT 已用 EasySwitch 启动：打开模型菜单就能看到外接模型" : "ChatGPT 已恢复普通启动");
      void r;
    } catch (error) { showError(error); }
    await refresh(true);
    return;
  }

  if (t.closest("[data-claude-desktop-ask]")) {
    if (claudeDesktopBusy || claudeDesktopInfo?.launchBlocked !== false || !claudeDesktopInfo?.installed || !selectableModelNames().includes(claudeDesktopModel)) return;
    claudeDesktopConfirm = true; claudeDesktopError = ""; render(); return;
  }
  if (t.closest("[data-claude-desktop-cancel]")) { claudeDesktopConfirm = false; render(); return; }
  const desktopStart = t.closest("[data-claude-desktop-start]");
  const desktopStop = t.closest("[data-claude-desktop-stop]");
  if (desktopStart || desktopStop) {
    if (claudeDesktopBusy || (desktopStart && (!claudeDesktopConfirm || claudeDesktopInfo?.launchBlocked !== false || !selectableModelNames().includes(claudeDesktopModel)))) return;
    claudeDesktopBusy = true; claudeDesktopConfirm = false; claudeDesktopError = ""; render();
    try {
      if (desktopStop) {
        await call("POST", `/api/claude-desktop/sessions/${desktopStop.dataset.claudeDesktopStop}/stop`, {});
        toast("这个独立会话已停止，私有目录已清理");
      } else {
        await call("POST", "/api/claude-desktop/sessions", { experimental: true, model: claudeDesktopModel });
        toast("独立进程已启动，真实窗口和模型连接仍需确认");
      }
    } catch (error) { claudeDesktopError = userErrorMessage(error); }
    finally { claudeDesktopBusy = false; }
    await refresh(true); return;
  }

  const agentLaunch = t.closest("[data-agent-launch]");
  if (agentLaunch) {
    if (agentLaunch.disabled || (agentLaunch.dataset.agentLaunch === "opencode" && typeof automaticToolFlight !== "undefined" && (automaticToolFlight || automaticToolUncertain))) return;
    if (typeof automaticToolInvalidate === "function") automaticToolInvalidate();
    try { const r = await call("POST", `/api/agents/${agentLaunch.dataset.agentLaunch}/launch`, {}); toast(`已在终端里启动（${r.model}）`); } catch (error) { showError(error); }
    return;
  }
  if (t.closest("[data-plan-signin]") || t.closest("[data-plan-signin-again]")) {
    const againBtn = t.closest("[data-plan-signin-again]");
    // A Codex-identity account just signs in again the same way; one made with OpenAI's own route signs in again with its own client.
    const again = againBtn && againBtn.dataset.planKind !== "codex" ? againBtn.dataset.planSigninAgain : undefined;
    const mode = againBtn?.dataset.planKind === "copilot" ? "copilot" : t.closest("[data-plan-mode]")?.dataset.planMode;
    try { await call("POST", "/api/plan/signin", again ? { accountId: again, mode: "open" } : mode ? { mode } : {}); } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  if (t.closest("[data-plan-cancel]")) { await call("POST", "/api/plan/signin", { cancelOnly: true }).catch(() => {}); await refresh(true); return; }
  const planModels = t.closest("[data-plan-models]");
  if (planModels) {
    try { const r = await call("POST", `/api/plan/${planModels.dataset.planModels}/models`); toast(`模型已更新：${r.models.length} 个`); } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  if (t.closest("[data-vertex-open]")) { vertexForm = {}; render(); return; }
  if (t.closest("[data-vertex-close]")) { if (vertexForm?.busy) return; vertexForm = null; render(); return; }
  const guideBtn = t.closest("[data-guide]");
  if (guideBtn) {
    const id = guideBtn.dataset.guide;
    if (guideBusy) return;
    if (guideOpen === id) { guideOpen = null; guideData = null; render(); return; }
    guideBusy = true;
    try { guideData = await call("POST", `/api/agents/${id}/setup`, {}); guideOpen = id; guideReveal = false; } catch (error) { showError(error); } finally { guideBusy = false; }
    render();
    return;
  }
  if (t.closest("[data-guide-close]")) { guideOpen = null; guideData = null; render(); return; }
  if (t.closest("[data-guide-reveal]")) { guideReveal = !guideReveal; render(); return; }
  const copyBtn = t.closest("[data-copy]");
  if (copyBtn) {
    try { await navigator.clipboard.writeText(copyBtn.dataset.copy); toast("已复制"); } catch { toast("复制失败：请手动选中复制"); }
    return;
  }
  if (t.closest("[data-kimi-signin]")) {
    try { await call("POST", "/api/kimi/signin", {}); toast("已在浏览器里打开 Kimi 登录页，确认页面上的码"); } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  const kmRefresh = t.closest("[data-kimi-refresh]");
  if (kmRefresh) {
    try { const r = await call("POST", `/api/kimi/${kmRefresh.dataset.kimiRefresh}/refresh`, {}); toast(`模型列表已更新，有 ${r.models.length} 个`); } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  const kmOut = t.closest("[data-kimi-remove]");
  if (kmOut) {
    const id = kmOut.dataset.kimiRemove;
    if (planConfirmOut !== id) { planConfirmOut = id; render(); return; }
    planConfirmOut = null;
    try { await call("DELETE", `/api/kimi/${id}`); toast("已退出登录，令牌已从钥匙串删除"); } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  if (t.closest("[data-cursor-signin]")) {
    try { await call("POST", "/api/cursor/signin", {}); toast("已在浏览器里打开 Cursor 登录页"); } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  const cuRefresh = t.closest("[data-cursor-refresh]");
  if (cuRefresh) {
    try { const r = await call("POST", `/api/cursor/${cuRefresh.dataset.cursorRefresh}/refresh`, {}); toast(`模型列表已更新，有 ${r.models.length} 个`); } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  const cuOut = t.closest("[data-cursor-remove]");
  if (cuOut) {
    const id = cuOut.dataset.cursorRemove;
    if (planConfirmOut !== id) { planConfirmOut = id; render(); return; }
    planConfirmOut = null;
    try { await call("DELETE", `/api/cursor/${id}`); toast("已退出登录，令牌已从钥匙串删除"); } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  if (t.closest("[data-antigravity-signin]")) {
    try { await call("POST", "/api/antigravity/signin", {}); toast("已在浏览器里打开 Google 登录页"); } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  const agRefresh = t.closest("[data-antigravity-refresh]");
  if (agRefresh) {
    try { const r = await call("POST", `/api/antigravity/${agRefresh.dataset.antigravityRefresh}/refresh`, {}); toast(`模型列表已更新，有 ${r.models.length} 个`); } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  const agOut = t.closest("[data-antigravity-remove]");
  if (agOut) {
    const id = agOut.dataset.antigravityRemove;
    if (planConfirmOut !== id) { planConfirmOut = id; render(); return; }
    planConfirmOut = null;
    try { await call("DELETE", `/api/antigravity/${id}`); toast("已退出登录，令牌已从钥匙串删除"); } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  if (t.closest("[data-kiro-import]")) {
    try { const r = await call("POST", "/api/kiro/import", {}); toast(`已读到 Kiro 的登录，有 ${r.models} 个模型；开关是关的，打开后才能用`); } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  const kiroOut = t.closest("[data-kiro-remove]");
  if (kiroOut) {
    const id = kiroOut.dataset.kiroRemove;
    if (planConfirmOut !== id) { planConfirmOut = id; render(); return; }
    planConfirmOut = null;
    try { await call("DELETE", `/api/kiro/${id}`); toast("已移除这个来源；Kiro CLI 自己的登录没有动"); } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  const planSwitch = t.closest("[data-plan-switch]");
  if (planSwitch) {
    const turnOn = planSwitch.dataset.on !== "1";
    try { await call("PUT", `/api/plan/${planSwitch.dataset.planSwitch}/switch`, { on: turnOn }); toast(turnOn ? "已打开：它的模型现在可以选了" : "已关闭：哪里都不会再用它"); } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  const planOut = t.closest("[data-plan-signout]");
  if (planOut) {
    const id = planOut.dataset.planSignout;
    if (planConfirmOut !== id) { planConfirmOut = id; render(); return; }
    planConfirmOut = null;
    try { await call("DELETE", `/api/plan/${id}`); toast("已退出登录，并在 OpenAI 那边撤销了这次登录"); } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  if (t.closest("[data-profile-new]")) { profileNaming = true; render(); return; }
  if (t.closest("[data-profile-cancel]")) { profileNaming = false; render(); return; }
  if (t.closest("[data-profile-apply]")) {
    if (typeof automaticPoolInvalidate === "function") automaticPoolInvalidate();
    const id = document.querySelector("[data-profile-pick]")?.value;
    try { const r = await call("POST", `/api/profiles/${id}/apply`); toast(`已切换到「${r.name}」：下次启动的会话就用这套设置`); } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  if (t.closest("[data-profile-del]")) {
    const id = document.querySelector("[data-profile-pick]")?.value;
    try { await call("DELETE", `/api/profiles/${id}`); toast("已删除这个方案"); } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  if (t.closest("[data-pool-new]")) { poolForm = { name: "", strategy: "order", members: [] }; render(); return; }
  if (t.closest("[data-pool-cancel]")) { poolForm = null; render(); return; }
  const poolEdit = t.closest("[data-pool-edit]");
  if (poolEdit) { const p = (state.pools ?? []).find(x => x.id === poolEdit.dataset.poolEdit); if (p) { if (p.strategy === "automatic") { toast("请在 Agent 页重新选择直接来源，再确认自动来源名单；不能在旧编辑器修改。"); return; } poolForm = { id: p.id, name: p.name, strategy: p.strategy, members: [...p.members] }; render(); } return; }
  const poolDel = t.closest("[data-pool-del]");
  if (poolDel) {
    const id = poolDel.dataset.poolDel;
    if (poolConfirmDel !== id) { poolConfirmDel = id; render(); return; }
    poolConfirmDel = null;
    try { await call("DELETE", `/api/pools/${id}`); toast("已删除模型池；绑定了它的 agent 回到原生"); } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  const lvEdit = t.closest("[data-levels-edit]");
  if (lvEdit) { levelsEditor = lvEdit.dataset.levelsEdit; render(); return; }
  if (t.closest("[data-levels-cancel]")) { levelsEditor = null; render(); return; }
  const lvSave = t.closest("[data-levels-save]");
  if (lvSave) {
    const key = lvSave.dataset.levelsSave;
    const slash = key.indexOf("/");
    const levels = [...document.querySelectorAll(`[data-levels-editor="${CSS.escape(key)}"] input[type=checkbox]:checked`)].map(i => i.value);
    try { await call("PUT", `/api/providers/${key.slice(0, slash)}/model-efforts`, { model: key.slice(slash + 1), levels }); toast(levels.length ? "已记下这个模型的档位" : "已清除这个模型的档位"); } catch (error) { showError(error); }
    levelsEditor = null;
    await refresh(true);
    return;
  }
  const agentOpen = t.closest("[data-agent-open]");
  if (agentOpen) {
    try { await call("POST", `/api/agents/${agentOpen.dataset.agentOpen}/open`); toast("已打开"); } catch (error) { showError(error); }
    return;
  }

  const currency = t.closest("[data-currency]");
  if (currency) { try { await call("PUT", "/api/display", { currency: currency.dataset.currency }); } catch (error) { showError(error); } await refresh(true); return; }
  const metric = t.closest("[data-metric]");
  if (metric) { chartMetric = metric.dataset.metric; updateUsageView(); return; }

  if (t.closest("[data-usage-retry]")) { if (!usageRequest) await loadUsage(); return; }
  const range = t.closest("[data-range]");
  if (range) {
    if (page !== "usage" || !Object.hasOwn(usageRanges, range.dataset.range)) return;
    usageRange = range.dataset.range;
    await loadUsage();
    return;
  }

  const stop = t.closest("[data-stop]");
  if (stop) {
    try { await call("POST", `/api/sessions/${stop.dataset.stop}/stop`); toast("已结束这个增强会话"); } catch (error) { showError(error); }
    setTimeout(() => refresh(true), 800);
    return;
  }

  if (t.closest("[data-add]")) {
    if (!presets.length) presets = await call("GET", "/api/presets").catch(() => []);
    addForm = { preset: null };
    if (typeof resetProviderImport === "function") resetProviderImport(false);
    render();
    return;
  }
  const preset = t.closest("[data-preset]");
  if (preset) {
    const selected = presets.find(x => x.id === preset.dataset.preset);
    if (preset.disabled || !selected || selected.unavailable) return;
    addForm = { preset: selected }; render(); return;
  }
  if (t.closest("[data-cancel-add]")) { addForm = null; render(); return; }

  const detail = t.closest(".detail");
  if (detail) {
    const id = detail.dataset.provider;
    const priceClear = t.closest("[data-price-clear]");
    if (priceClear) {
      try { await call("PUT", `/api/providers/${id}/prices`, { model: priceClear.dataset.priceClear, rates: null }); toast("已清除，改用价格表"); } catch (error) { showError(error); }
      await refresh(true);
      return;
    }
    const keyPatch = t.closest("[data-key-patch]");
    if (keyPatch) {
      try { await call("PATCH", `/api/providers/${id}/keys/${keyPatch.dataset.keyPatch}`, { enabled: keyPatch.dataset.enabled === "1" }); } catch (error) { showError(error); }
      await refresh(true);
      return;
    }
    const keyDel = t.closest("[data-key-del]");
    if (keyDel) {
      try { await call("DELETE", `/api/providers/${id}/keys/${keyDel.dataset.keyDel}`); toast("已删除这把 Key"); } catch (error) { showError(error); }
      await refresh(true);
      return;
    }
    const button = t.closest("button");
    if (!button || button.disabled || providerOperations.has(id)) return;
    if (button.type === "submit" && button.closest("form")) return;
    if (button.hasAttribute("data-probe") || button.hasAttribute("data-protocol-auto")) {
      const form = detail.querySelector("[data-protocol-form]");
      rememberProtocolForm(form);
      const label = button.textContent;
      let saved = false;
      await withProviderOperation(detail, async () => {
        try {
          if (button.hasAttribute("data-probe")) {
            const model = detail.querySelector(".probe-model")?.value;
            if (!model) { toast("先选一个模型再检测"); return; }
            button.textContent = "检测中…";
            await call("POST", `/api/providers/${encodeURIComponent(id)}/probe`, { model });
            toast("检测完成，结果在来源下方；手动协议设置未更改");
          } else {
            const model = detail.querySelector("[data-protocol-model]")?.value ?? "";
            await call("PUT", `/api/providers/${encodeURIComponent(id)}/protocols`, { protocols: null, ...(model ? { model } : {}) });
            protocolDrafts.delete(id);
            toast(model ? "模型已恢复来源设置" : "来源已恢复自动识别");
          }
          saved = true;
        } catch (error) { showError(error); }
        finally { button.textContent = label; }
      });
      if (saved) await refresh(true);
      return;
    }
    button.disabled = true;
    try {
      if (button.hasAttribute("data-remove")) {
        if (!window.confirm("删除这个模型来源？钥匙串里的 Key 也会一起删除。")) { button.disabled = false; return; }
        await call("DELETE", `/api/providers/${id}`);
        protocolDrafts.delete(id);
        openProvider = null;
      }
    } catch (error) { showError(error); }
    await refresh(true);
    return;
  }

  const toggle = t.closest("[data-toggle]");
  if (toggle) { openProvider = openProvider === toggle.dataset.toggle ? null : toggle.dataset.toggle; render(); }
});

document.addEventListener("change", async e => {
  if (e.target.matches("[data-protocol-model]")) {
    const detail = e.target.closest(".detail");
    if (!detail || providerOperations.has(detail.dataset.provider)) return;
    const protocols = protocolChoices(providerById(detail.dataset.provider), e.target.value);
    protocolDrafts.set(detail.dataset.provider, { model: e.target.value, protocols });
    const options = detail.querySelector("[data-protocol-options]");
    if (options) options.innerHTML = protocolOptions(null, "", protocols);
    return;
  }
  const protocolForm = e.target.closest?.("[data-protocol-form]");
  if (protocolForm) { rememberProtocolForm(protocolForm); return; }
  if (!e.target.matches(".billing-select")) return;
  const id = e.target.closest(".detail")?.dataset.provider;
  try { await call("PUT", `/api/providers/${id}/billing`, { billing: e.target.value }); toast(e.target.value === "subscription" ? "已改为包月套餐" : "已改为按量计费"); } catch (error) { showError(error); }
  await refresh(true);
});

document.addEventListener("input", e => {
  if (e.target.matches("#import-form textarea")) importFormOpen = true;
  if (e.target.id === "preset-search") {
    presetQuery = e.target.value;
    const box = $("#preset-groups");
    if (box) box.outerHTML = presetGroups();
  }
});
document.addEventListener("submit", async e => {
  if (e.target.matches("[data-protocol-form]")) {
    e.preventDefault();
    const form = e.target;
    if (form.dataset.saving) return;
    const detail = form.closest(".detail");
    const id = detail?.dataset.provider;
    if (!id || providerOperations.has(id)) return;
    const f = new FormData(form); const model = f.get("model");
    const protocols = f.getAll("protocols");
    if (!protocols.length) { toast("请至少选择一个来源支持的协议"); return; }
    rememberProtocolForm(form);
    form.dataset.saving = "1";
    let saved = false;
    try {
      await withProviderOperation(detail, async () => {
        await call("PUT", `/api/providers/${encodeURIComponent(id)}/protocols`, { protocols, ...(model ? { model } : {}) });
        protocolDrafts.delete(id); saved = true;
        toast(model ? "模型协议已保存" : "来源协议已保存");
      });
    } catch (error) { showError(error); }
    finally { delete form.dataset.saving; }
    if (saved) await refresh(true);
    return;
  }
  if (e.target.id === "add-form") { e.preventDefault(); submitAdd(e.target); return; }
  if (e.target.dataset?.providerBudgetForm) {
    e.preventDefault();
    const f = new FormData(e.target);
    const usd = String(f.get("monthlyUsd") ?? "").trim();
    try {
      await call("PUT", `/api/providers/${e.target.dataset.providerBudgetForm}/budget`, { monthlyUsd: usd === "" ? null : Number(usd), stop: f.get("stop") === "on" });
      toast(usd === "" ? "已取消预算" : "预算已保存");
    } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  if (e.target.id === "vertex-form") {
    e.preventDefault();
    if (!vertexForm || vertexForm.busy) return;
    const f = new FormData(e.target);
    const models = String(f.get("models") ?? "").split(",").map(x => x.trim()).filter(Boolean);
    vertexForm = { busy: true };
    render();
    try {
      const out = await call("POST", "/api/vertex", { project: String(f.get("project")).trim(), location: String(f.get("location") ?? "").trim() || "global", serviceAccount: String(f.get("serviceAccount")), ...(models.length ? { models } : {}) });
      vertexForm = null;
      toast(`已添加，有 ${out.models} 个模型`);
    } catch (error) {
      vertexForm = { message: userErrorMessage(error) };
    }
    await refresh(true);
    return;
  }
  if (e.target.id === "import-form") {
    e.preventDefault();
    const msg = $("#import-msg");
    msg.className = "msg";
    msg.textContent = "正在识别、添加并测试…";
    try {
      const text = new FormData(e.target).get("text");
      const out = await call("POST", "/api/import", { text });
      msg.className = "msg ok";
      msg.textContent = out.summary;
      importFormOpen = false;
      e.target.querySelector("textarea").value = "";
    } catch (error) {
      msg.className = "msg bad";
      msg.textContent = userErrorMessage(error);
    }
    await refresh(true);
    return;
  }
  const profileFormEl = e.target.closest("form[data-profile-form]");
  if (profileFormEl) {
    e.preventDefault();
    try { await call("POST", "/api/profiles", { name: new FormData(profileFormEl).get("name") }); toast("方案已保存"); profileNaming = false; } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  const poolFormEl = e.target.closest("form[data-pool-form]");
  if (poolFormEl) {
    e.preventDefault();
    if (poolForm?.strategy === "automatic" || state.pools?.find(p => p.id === poolForm?.id)?.strategy === "automatic") { poolForm = null; toast("自动来源名单需要在 Agent 页重新确认，未修改原模型池。"); render(); return; }
    const f = new FormData(poolFormEl);
    const body = { name: f.get("name"), strategy: f.get("strategy"), members: f.getAll("members") };
    try {
      await call(poolForm?.id ? "PUT" : "POST", poolForm?.id ? `/api/pools/${poolForm.id}` : "/api/pools", body);
      poolForm = null;
      toast("模型池已保存");
    } catch (error) {
      poolForm = { ...poolForm, name: body.name, strategy: body.strategy, members: body.members, error: userErrorMessage(error) };
    }
    await refresh(true);
    return;
  }
  const priceForm = e.target.closest("form[data-price-form]");
  if (priceForm) {
    e.preventDefault();
    const f = new FormData(priceForm);
    const num = k => Number(f.get(k) || 0);
    const id = priceForm.closest(".detail")?.dataset.provider;
    try { await call("PUT", `/api/providers/${id}/prices`, { model: priceForm.dataset.priceForm, rates: { input: num("input"), output: num("output"), cacheRead: num("cacheRead"), cacheWrite: 0 } }); toast("已保存价格"); } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  const accForm = e.target.closest("form[data-add-account]");
  if (accForm) {
    e.preventDefault();
    try {
      await call("POST", "/api/accounts", { harness: accForm.dataset.addAccount, label: new FormData(accForm).get("label") });
      toast("已添加；点「启动」，第一次在终端里登录一次");
    } catch (error) { showError(error); }
    await refresh(true);
    return;
  }
  const form = e.target.closest("form[data-add-key]");
  if (!form) return;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const id = form.closest(".detail")?.dataset.provider;
  try {
    await call("POST", `/api/providers/${id}/keys`, data);
    toast("已添加 Key，下一次请求开始使用");
  } catch (error) { showError(error); }
  await refresh(true);
});
document.addEventListener("keydown", e => { if (e.key === "Escape") { closePopover(); if (claudeDesktopConfirm) { claudeDesktopConfirm = false; render(); } } });
// "toggle" does not bubble, so listen in the capture phase.
document.addEventListener("toggle", e => {
  const id = e.target?.dataset?.keep;
  if (!id) return;
  if (e.target.open) openDetails.add(id); else openDetails.delete(id);
  if (id === "experimental-agents" && !e.target.open && claudeDesktopConfirm) { claudeDesktopConfirm = false; render(); }
}, true);
window.addEventListener("hashchange",()=>{if(PANEL)return;const next=pageFromHash();if(next===page)return;claudeDesktopConfirm=false;if(typeof automaticPoolInvalidate==="function")automaticPoolInvalidate();pageNavigationVersion++;cancelUsageLoad();if(page==="doctor"&&typeof cancelDoctorCheck==="function")cancelDoctorCheck();page=next;closePopover();if(page==="usage")render();void refresh(true);});
window.addEventListener("resize", () => { if (page === "sessions") drawFlowLines(); if (page === "usage") drawChart(); });

if (PANEL) document.body.classList.add("panel");
if (PANEL) {
  $("#nav").remove();
  $("#refresh").remove();
}
fetch("icons/manifest.json").then(r => r.json()).then(m => { monoIcons = new Set(m.mono); if (state) render(); }).catch(() => {});
refresh(true);
setInterval(() => refresh(), 3000);
