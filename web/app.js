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
const ROUTE = { "responses-native": "原样转发", "anthropic-native": "原样转发", "chat-translate": "协议转换", pool: "按池里的顺序" };
const TOOL_NAMES = { "tool:web_search": "网页搜索", "tool:namespace:multi_agent_v1": "子 agent 工具" };

let state = null;
let page = PANEL ? "agents" : (location.hash.slice(1) || "agents");
let usageRange = "7d";
let chartMetric = "tokens"; // "tokens" | "cost"
let usage = null;
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

let taskList = null; // /api/tasks
const taskOpenIds = new Set(); // task ids whose output is expanded
let taskNote = "";
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
let ocxImport = null; // { candidates, chosen:Set } while the opencodex import panel is open
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

let monoIcons = null; // Set of single-colour icon names, once icons/manifest.json is loaded

function icon(name, cls = "") {
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

function toast(text) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}

/** Name and icon of any agent: the two built-in rows, or an entry of the wider catalog. */
function agentMeta(id) {
  return HARNESS[id] ?? agentList?.find(a => a.id === id) ?? { name: id, icon: `letter:${id[0]?.toUpperCase() ?? "?"}` };
}

const POOL_PROVIDER = { id: "pool", name: "模型池", icon: "letter:池", models: [] };
const providerById = id => (id === "pool" ? POOL_PROVIDER : state.providers.find(p => p.id === id));
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
    const face = provider
      ? `${icon(provider.icon)}<span class="label">${esc(name.slice(slash + 1))}</span>`
      : `<span class="label">跟随主模型</span>`;
    return `<div class="ctl" title="${esc(t.hint)}"><small>${esc(t.label)}</small><button class="popbtn" data-pick="${esc(id)}@${esc(t.id)}">${face}<span class="caret">▾</span></button></div>`;
  };
  const effort = levels.length
    ? `<div class="ctl"><small>想得多深</small><select data-effort-select="${esc(id)}" title="只对这个 agent 生效">
        ${["", ...levels].map(l => `<option value="${esc(l)}" ${(prefs.effort ?? "") === l ? "selected" : ""}>${levelLabel(l, levels)}</option>`).join("")}</select></div>`
    : modelKey
      // A model EasySwitch knows no levels for: the user can say which it has, so the control does not just disappear.
      ? `<div class="ctl"><small>想得多深</small><button class="btn secondary" data-levels-edit="${esc(modelKey)}" title="${esc(binding.model)} 没有已知的思考档位；告诉 EasySwitch 它有哪些">档位未知，设置</button></div>`
      : "";
  return effort + (modelKey && state.modelEffortNotes?.[modelKey] ? `<small class="hint">${esc(state.modelEffortNotes[modelKey])}</small>` : "") + (can0.tiers ?? []).map(tierCtl).join("");
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
  const face = binding && provider
    ? `${icon(provider.icon)}<span class="label" title="${esc(provider.name)}">${esc(binding.model)}</span>`
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
      <div class="ctl"><small>主模型</small><button class="popbtn" data-pick="${harness}" title="增强会话用哪个模型">${face}<span class="caret">▾</span></button></div>
      ${agentControls(harness)}
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
  const models = [
    ...(state?.providers ?? []).flatMap(p => modelsOf(p).map(m => ({ id: `${p.id}/${m}`, name: `${p.name} · ${m}` }))),
    ...(state?.pools ?? []).filter(p => p.live?.length).map(p => ({ id: `pool/${p.id}`, name: `模型池 · ${p.name}` })),
  ];
  if (!models.some(m => m.id === claudeDesktopModel)) {
    const b = state?.bindings?.["claude-desktop"];
    const saved = b ? `${b.providerId}/${b.model}` : "";
    claudeDesktopModel = models.find(m => m.id === saved)?.id ?? models[0]?.id ?? "";
    claudeDesktopConfirm = false;
  }
  const sessions = c?.sessions ?? [];
  const live = sessions.filter(s => !s.cleaned);
  const labels = { prepared: "等待启动", starting: "正在启动", running: "进程运行中", exited: "已退出", failed: "启动或运行失败", stopped: "已停止", "cleanup-blocked": "退出或清理待处理" };
  const disabled = c?.launchBlocked !== false || !c?.installed || !models.length || claudeDesktopBusy || live.length >= 3;
  const agent = agentList?.find(a => a.id === "claude-desktop");
  return `<div class="section-head"><h2>Claude 桌面端独立窗口</h2><span class="chip warn">${c?.launchBlocked !== false ? "真实启动已暂停" : "实验性 · 仅模拟测试"}</span></div>
    <div class="card" data-claude-desktop-card>
      <div class="row agent"><div class="id">${icon("claude-color", "lg")}<div class="grow">
        <div class="title">官方第三方网关模式</div>
        <div class="sub">隔离启动与停止清理已通过模拟测试；官方签名版 2.19675.1 忽略数据目录覆盖变量，真实目录隔离、模型菜单和消息链路尚未实测</div>${agent ? capStrip(agent) : ""}
      </div></div><span class="chip">${c ? c.installed ? "已检测到应用" : "未检测到应用" : "状态读取中"}</span></div>
      <div class="controls"><label>默认模型 <select data-claude-desktop-model aria-label="Claude 桌面端默认模型" ${claudeDesktopBusy ? "disabled" : ""}>
        ${models.length ? models.map(m => `<option value="${esc(m.id)}" ${m.id === claudeDesktopModel ? "selected" : ""}>${esc(m.name)}</option>`).join("") : `<option value="">先添加模型来源</option>`}
      </select></label><button class="btn" data-claude-desktop-ask ${disabled ? "disabled" : ""}>${claudeDesktopBusy ? "正在处理…" : "打开独立窗口"}</button></div>
      <p class="hint" style="padding:0 18px">${live.length >= 3 ? "已有三个独立会话，请先停止一个。" : "这里只管理 EasySwitch 创建的独立进程；正常 Claude 窗口不需要退出。启动不等于已验证配置生效。"}</p>
      ${c?.launchBlocked !== false ? `<p class="hint" role="status" style="padding:0 18px">${esc(c?.note ?? "读取安全状态前不能启动")}</p>` : ""}
      ${claudeDesktopConfirm ? `<div class="detail" style="display:block"><p class="hint">确认以实验性方式启动？启动器不改原生配置，但真实应用是否完全遵守独立目录仍待验证。应用可能下载并运行自带的 agent helper；发消息会使用你选择的来源及其额度。这个独立窗口只配置外接模型，不借用 Claude 登录。</p><div class="controls"><button class="btn" data-claude-desktop-start ${disabled ? "disabled" : ""}>确认，启动独立窗口</button><button class="btn secondary" data-claude-desktop-cancel>取消</button></div></div>` : ""}
      ${claudeDesktopError ? `<p class="hint" role="alert" style="padding:0 18px;color:var(--bad)">${esc(claudeDesktopError)}</p>` : ""}
      ${sessions.map(s => `<div class="row"><div class="grow"><div class="title">${esc(labels[s.state] ?? s.state)}${s.pid ? ` · PID ${esc(s.pid)}` : ""}</div><div class="sub">${s.cleaned ? "私有目录已清理" : "私有目录保留中"}${s.error ? ` · ${esc(s.error)}` : ""}</div></div>${s.cleaned ? "" : `<button class="btn secondary" data-claude-desktop-stop="${esc(s.id)}" ${claudeDesktopBusy ? "disabled" : ""}>停止并清理</button>`}</div>`).join("")}
    </div>`;
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
  const face = binding && provider
    ? `${icon(provider.icon)}<span class="label" title="${esc(provider.name)}">${esc(binding.model)}</span>`
    : `<span class="label">选个模型</span>`;
  return `
  <div class="row agent">
    <div class="id">${icon(a.icon, "lg")}
      <div class="grow"><div class="title">${esc(a.name)} <span class="hint">${esc(a.vendor)}</span> ${SUPPORT_CHIP[a.support]}</div><div class="sub" title="${esc(a.note)}">${esc(a.note)}${can && !can.verified ? " · <b>启动方式按官方文档写的，还没在真实程序上实测</b>" : ""}</div>${capStrip(a)}</div>
    </div>
    ${can ? `<div class="ctl"><small>主模型</small><button class="popbtn" data-pick="${esc(a.id)}">${face}<span class="caret">▾</span></button></div>` : ""}
    ${can ? agentControls(a.id) : ""}
    <div class="acts">
      ${a.guide ? `<button class="btn" data-guide="${esc(a.id)}">配置向导</button>` : ""}
      ${can?.interactive ? `<button class="btn" data-agent-launch="${esc(a.id)}" ${binding ? "" : "disabled"}>启动</button>` : ""}
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
const taskForm = { agent: "", effort: "", task: "", model: "", cwd: "" };
let ruleForm = null; // { name, words, minChars, maxChars, cwdPrefix, agent, model, effort, error } while the rule form is open
let ruleTest = { task: "", result: null };
const AUTO = "auto";
const TASK_STATUS = { running: ["运行中", "ok"], done: ["完成", "ok"], failed: ["失败", "warn"], stopped: ["已停止", ""], timeout: ["超时", "warn"] };

function renderTasks() {
  const agents = (agentList ?? []).filter(a => a.installed && a.can?.headless && (!a.where?.endsWith(".app") || ["codex", "claude"].includes(a.id)));
  const models = (state.providers ?? []).flatMap(p => modelsOf(p).map(m => `${p.id}/${m}`));
  const list = taskList?.tasks ?? [];
  const nameOf = id => (agentList ?? []).find(a => a.id === id)?.name ?? id;
  const keep = (k, d = "") => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const rules = state.rules ?? [];
  // "自动" is the default once the user has written rules; otherwise the first agent that can work.
  const wanted = taskForm.agent || keep("es.taskAgent") || (rules.length ? AUTO : "");
  const auto = wanted === AUTO && agents.length > 0;
  const chosen = auto ? null : (agents.find(a => a.id === wanted) ?? agents[0]);
  const levels = chosen?.can?.efforts ?? [];
  const effort = levels.includes(taskForm.effort) ? taskForm.effort : "";
  const form = agents.length ? `
    <form class="form card" data-task-form style="padding:16px 18px">
      <textarea name="task" rows="3" required style="font-size:15px" placeholder="想让谁做什么？比如：读一下 README，告诉我这个项目是做什么的">${esc(taskForm.task)}</textarea>
      <div class="controls" style="margin-top:10px;flex-wrap:wrap">
        <button type="button" class="btn ${auto ? "" : "secondary"}" data-task-agent="${AUTO}" title="按下面的「派活规则」自动决定交给谁、用哪个模型、想多深">自动</button>
        ${agents.map(a => `<button type="button" class="btn ${chosen && a.id === chosen.id ? "" : "secondary"}" data-task-agent="${esc(a.id)}">${esc(a.name)}</button>`).join("")}
        <span class="grow"></span>
        <button class="btn" type="submit">派出去</button>
      </div>
      ${auto ? `<p class="hint" style="margin:8px 0 0">${rules.length ? `按下面 ${rules.length} 条派活规则决定交给谁；没有规则接的任务交给第一个能接活的 agent。` : "还没有派活规则，会交给第一个能接活的 agent；在下面写几条规则就能按任务类型分工。"}</p>` : ""}
      ${!auto && levels.length ? `<div class="controls" style="margin-top:8px;flex-wrap:wrap"><span class="hint">想得多深</span>
        ${["", ...levels].map(l => `<button type="button" class="btn ${l === effort ? "" : "secondary"}" data-task-effort="${esc(l)}" title="${l ? `${esc(chosen?.name ?? "")} 的「${esc(l)}」档` : "不指定，用它自己的默认"}">${EFFORT_LABEL[l] ?? l}</button>`).join("")}</div>` : ""}
      <details data-keep="task-more" ${keepOpen("task-more")} style="margin-top:10px"><summary class="hint" style="cursor:pointer">更多选项（模型、工作目录）</summary>
        <div class="field"><label>用哪个模型</label><select name="model"><option value="">${auto ? "按规则（没写就用它自己的）" : state.bindings?.[chosen.id] ? "它自己的模型" : "自动选一个"}</option>${models.map(m => `<option value="${esc(m)}" ${m === taskForm.model ? "selected" : ""}>${esc(m)}</option>`).join("")}</select></div>
        <div class="field"><label>在哪个文件夹里干活（绝对路径；不填是一个空的临时文件夹）</label><input type="text" name="cwd" value="${esc(taskForm.cwd)}" placeholder="/Users/你/项目"></div>
      </details>
      ${taskNote ? `<p class="hint" style="color:var(--bad)">${esc(taskNote)}</p>` : ""}
    </form>` : `<div class="card empty">${agentList ? "还没有可以接活的 agent：到 Agent 页确认已安装" : "正在检测…"}</div>`;
  const row = t => {
    const [label, tone] = TASK_STATUS[t.status] ?? [t.status, ""];
    const open = taskOpenIds.has(t.id);
    return `
    <div class="row" style="cursor:pointer" data-task-toggle="${esc(t.id)}">
      <div class="grow"><div class="title">${esc(t.task.length > 80 ? t.task.slice(0, 80) + "…" : t.task)}</div>
        <div class="sub">${t.from === "console" ? "你" : esc(nameOf(t.from))} → ${esc(nameOf(t.agent))} · ${esc(t.model)} · ${new Date(t.at).toLocaleTimeString()}${t.ms ? ` · ${(t.ms / 1000).toFixed(1)} 秒` : ""}</div>
        ${t.why ? `<div class="sub" title="${esc(t.why)}">${esc(t.why)}</div>` : ""}</div>
      <span class="chip ${tone}">${label}</span>
      ${t.status === "running" ? `<button class="btn secondary" data-task-stop="${esc(t.id)}">停止</button>` : ""}
    </div>
    ${open ? `<div style="padding:0 18px 14px">${t.status === "running" ? `<p class="hint">正在做，做完会出现在这里。</p>` : `<pre class="mono" style="white-space:pre-wrap;max-height:360px;overflow:auto;background:var(--pill);padding:10px;border-radius:9px">${esc(t.output || "(没有输出)")}</pre>`}</div>` : ""}`;
  };
  return `
    <div class="section-head"><h2>交给 Agent 一个任务</h2><span class="aside">它在后台做，你和其他 agent 都能看到进度</span></div>
    ${form}
    <div class="section-head"><h2>任务</h2><span class="aside">${list.length ? `${list.length} 条${taskList.running ? `，${taskList.running} 条在运行` : ""}` : ""} ${list.some(t => t.status !== "running") ? `<button class="btn secondary" data-task-clear>清空已完成</button>` : ""}</span></div>
    <div class="card">${list.map(row).join("") || `<div class="empty">还没有任务。你在这里派的、以及 agent 之间互相派的，都会记在这里。</div>`}</div>
    <p class="hint">任务里的 agent 按它们各自默认的只读权限运行：能读文件、搜索、思考，不会擅自改文件。</p>
    ${rulesCard(agents, models)}`;
}

/** Dispatch rules: which agent, model and level a task goes to, tried in order. */
function rulesCard(agents, models) {
  const rules = state.rules ?? [];
  const nameOf = id => (agentList ?? []).find(a => a.id === id)?.name ?? id;
  const row = (r, i) => `
    <div class="row">
      <div class="grow"><div class="title">${esc(r.name)} ${r.enabled ? "" : `<span class="chip">已停用</span>`}</div>
        <div class="sub">${esc(r.summary)} → ${esc(nameOf(r.then.agent))}${r.then.model ? ` · ${esc(r.then.model)}` : ""}${r.then.effort ? ` · ${esc(EFFORT_LABEL[r.then.effort] ?? r.then.effort)}档` : ""}</div></div>
      <button class="btn secondary" data-rule-move="up" data-rule="${esc(r.id)}" ${i === 0 ? "disabled" : ""} title="提前：前面的规则先匹配">↑</button>
      <button class="btn secondary" data-rule-move="down" data-rule="${esc(r.id)}" ${i === rules.length - 1 ? "disabled" : ""} title="靠后">↓</button>
      <button class="btn secondary" data-rule-toggle="${esc(r.id)}">${r.enabled ? "停用" : "启用"}</button>
      <button class="btn secondary" data-rule-del="${esc(r.id)}">删除</button>
    </div>`;
  const f = ruleForm;
  const form = f ? `
    <form class="form" data-rule-form>
      <div class="field"><label>规则名</label><input type="text" name="name" required value="${esc(f.name)}" placeholder="比如：写测试交给 Claude Code"></div>
      <div class="field"><label>任务里提到这些词之一（用逗号隔开，不填就不限）</label><input type="text" name="words" value="${esc(f.words)}" placeholder="测试, pytest, 单测"></div>
      <div class="controls">
        <label class="hint">任务至少</label><input type="text" name="minChars" size="4" value="${esc(f.minChars)}" placeholder="字数"> <span class="hint">字，至多</span><input type="text" name="maxChars" size="4" value="${esc(f.maxChars)}" placeholder="字数"> <span class="hint">字</span>
      </div>
      <div class="field"><label>工作文件夹以此开头（绝对路径，不填就不限）</label><input type="text" name="cwdPrefix" value="${esc(f.cwdPrefix)}" placeholder="/Users/你/项目"></div>
      <div class="controls">
        <span class="hint">就交给</span>
        <select name="agent">${agents.map(a => `<option value="${esc(a.id)}" ${a.id === f.agent ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select>
        <span class="hint">用</span>
        <select name="model"><option value="">它自己的模型</option>${models.map(m => `<option value="${esc(m)}" ${m === f.model ? "selected" : ""}>${esc(m)}</option>`).join("")}${(state.pools ?? []).map(p => `<option value="pool/${esc(p.id)}" ${f.model === `pool/${p.id}` ? "selected" : ""}>pool/${esc(p.id)}（模型池）</option>`).join("")}</select>
        <span class="hint">想得</span>
        <select name="effort"><option value="">默认</option>${["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(l => `<option value="${l}" ${f.effort === l ? "selected" : ""}>${EFFORT_LABEL[l]}（${l}）</option>`).join("")}</select>
      </div>
      <div class="controls"><button class="btn" type="submit">保存规则</button><button class="btn secondary" type="button" data-rule-cancel>取消</button></div>
      ${f.error ? `<p class="hint" style="color:var(--bad)">${esc(f.error)}</p>` : ""}
    </form>` : "";
  return `
    <div class="section-head"><h2>派活规则</h2><span class="aside">从上往下找，第一条符合的决定交给谁；「自动」任务和 agent 之间的 auto 调用都用它</span></div>
    <div class="card">
      ${rules.map(row).join("") || `<div class="empty">还没有规则。比如：提到「测试」的交给 Claude Code 想深一点，短任务交给便宜的模型。</div>`}
      ${form}
      ${f || !agents.length ? "" : `<button class="add-row" data-rule-new>＋ 新建规则</button>`}
    </div>
    <div class="card" style="margin-top:12px"><div class="row" style="gap:10px;flex-wrap:wrap">
      <input type="text" data-rule-test-input style="flex:1;min-width:220px" placeholder="试一下：写一个任务，看会交给谁" value="${esc(ruleTest.task)}">
      <button class="btn secondary" data-rule-test>看看会交给谁</button>
    </div>${ruleTest.result ? `<div style="padding:0 18px 14px"><p class="hint">${ruleTest.result.error ? esc(ruleTest.result.error) : `${esc(ruleTest.result.why)}${ruleTest.result.model ? ` · 模型 ${esc(ruleTest.result.model)}` : ""}${ruleTest.result.effort ? ` · ${esc(ruleTest.result.effort)} 档` : ""}`}</p></div>` : ""}</div>`;
}

let profileNaming = false;

/** Profiles: every agent's settings saved under a name, to come back to in one click. */
/** The first thing on the Agent page: hand something to an agent in one line. "Auto" follows the rules written on the Tasks page. */
function quickTask() {
  return `<form class="card" data-quick-task style="display:flex;gap:8px;align-items:center;padding:10px 14px">
    <input type="text" name="task" placeholder="交给 agent 做点什么，比如：给这个项目的登录函数补上单元测试" required style="flex:1;min-width:0">
    <button class="btn" type="submit">派出去（自动选）</button>
  </form>
  <div class="hint" style="margin:4px 6px 12px">按「任务」页里写的规则分给合适的 agent；没有规则就交给第一个能接活的。结果在「任务」页看。</div>`;
}

function profileBar() {
  const list = state.profiles ?? [];
  return `
    <div class="card"><div class="row" style="gap:10px;flex-wrap:wrap">
      <div class="grow"><div class="title">方案</div><div class="sub">${list.length ? "把所有 agent 现在的设置存成一个名字，之后一键切回" : "还没有方案：设好各个 agent 的主模型、档位和小模型后，存成一个方案"}</div></div>
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
    ${quickTask()}
    ${profileBar()}
    <div class="section-head"><h2>已安装</h2><span class="aside">${inst.length ? `${agentList ? agentList.filter(a => a.installed).length : inst.length} 个` : ""}；每个 agent 平时都走原生，增强会话只在 EasySwitch 打开的终端窗口里生效</span></div>
    <div class="card">${inst.join("") || `<div class="empty">${agentList ? "这台 Mac 上还没检测到 agent" : "正在检测…"}</div>`}</div>
    <p class="hint">在每个 agent 那一行里选主模型、想得多深、后台小任务和子 agent 用的模型，再点「启动」。会话里输入 <code>/model</code> 可以随时换。选「原生」就是不用 EasySwitch；你平时直接打开的 ChatGPT 和 Claude Code 永远不受影响。「接入中」的 agent 正在逐个接入；「只能打开」的是闭源或绑定登录的，EasySwitch 只负责检测和打开，不会改动它们的任何配置。</p>
    ${state.providers.length ? "" : onboarding()}
    ${claudeDesktopCard()}
    ${coverageCard()}
    ${missing.length ? `<div class="section-head"><h2>未安装</h2><span class="aside">${missing.length} 个</span></div><div class="card">${missing.join("")}</div>` : ""}`;
}

let autoConfirm = false; // the inline terms notice for auto pick is open

function accountRow(a) {
  const resting = a.resting;
  const state = !a.enabled ? `<span class="chip">已停用</span>`
    : resting ? `<span class="chip warn"><span class="dot"></span>限额中 · ${inFuture(a.restUntil)}恢复</span>`
    : `<span class="chip ok"><span class="dot"></span>可用</span>`;
  return `
    <div class="row" data-account="${esc(a.id)}">
      ${icon(HARNESS[a.harness].icon, "sm")}
      <div class="grow"><div class="title">${esc(a.label)}</div><div class="sub">${a.lastUsedAt ? `上次用：${ago(a.lastUsedAt)}` : "还没用过；第一次启动要在终端里登录一次"}</div></div>
      ${state}
      <button class="btn" data-acc-launch="${esc(a.id)}" data-h="${a.harness}">启动</button>
      <button class="btn secondary" data-acc-rest="${esc(a.id)}" data-on="${resting ? "0" : "1"}">${resting ? "恢复" : "撞限额了"}</button>
      <button class="btn secondary" data-acc-toggle="${esc(a.id)}" data-enabled="${a.enabled ? "0" : "1"}">${a.enabled ? "停用" : "启用"}</button>
      <button class="btn danger" data-acc-del="${esc(a.id)}">移除</button>
    </div>`;
}

function renderAccounts() {
  const accounts = state.accounts ?? [];
  const settings = state.accountSettings ?? { autoPick: false };
  const section = h => {
    const mine = accounts.filter(a => a.harness === h);
    return `
      <div class="section-head"><h2>${icon(HARNESS[h].icon, "sm")} ${HARNESS[h].name}</h2>
        <span class="aside">${mine.length} 个账号</span></div>
      <div class="card">
        ${mine.map(accountRow).join("") || `<div class="empty">还没有账号</div>`}
        <form class="form" data-add-account="${h}"><div class="controls">
          <input type="text" name="label" placeholder="给这个账号起个名字，例如：个人 Plus" style="flex:1">
          <button class="btn secondary" type="submit">＋ 添加 ${HARNESS[h].name} 账号</button>
          <button class="btn" type="button" data-acc-auto="${h}" ${settings.autoPick && mine.some(a => a.enabled) ? "" : "disabled"} title="${settings.autoPick ? "挑一个没撞限额、最久没用的" : "先开启自动选号"}">自动选号启动</button>
        </div></form>
      </div>`;
  };
  return `
    <div class="section-head"><h2>订阅账号</h2><span class="aside">一个人的多份订阅；全部在本机，登录令牌不经过 EasySwitch</span></div>
    <div class="card"><div class="row">
      <div class="grow"><div class="title">自动选号</div>
        <div class="sub">${settings.autoPick ? "已开启：点「自动选号启动」时，自动挑一个没撞限额、最久没用的账号" : "未开启：每次自己选账号启动"}</div></div>
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
  closePopover();
  const [harness, tier] = target.split("@");
  const main = state.bindings?.[harness];
  const tierName = tier ? main?.tiers?.[tier] : undefined;
  const binding = tier ? (tierName ? { providerId: tierName.slice(0, tierName.indexOf("/")), model: tierName.slice(tierName.indexOf("/") + 1) } : undefined) : main;
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
      const route = harness === "codex" ? p.route : harness === "claude" ? p.messagesRoute ?? "chat-translate" : "chat-translate";
      for (const m of modelsOf(p)) {
        if (q && !m.toLowerCase().includes(q) && !p.name.toLowerCase().includes(q)) continue;
        out.push({ provider: p, model: m, route });
      }
    }
    // Pools are models too: they sit at the end of the list.
    if (!only) for (const pool of state.pools ?? []) {
      if (q && !pool.name.toLowerCase().includes(q) && !"模型池 pool".includes(q)) continue;
      out.push({ provider: POOL_PROVIDER, model: pool.id, route: "pool" });
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
        <span class="name">${esc(o.model)}</span><span class="meta">${ROUTE[o.route]}</span><span class="tick">${on ? "✓" : ""}</span></button>`;
    }).join("") || `<div class="empty">没有匹配的模型</div>`;
    el.querySelector(".opt.kb")?.scrollIntoView({ block: "nearest" });
    return opts;
  };

  const choose = async o => {
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

/** How the user pays this provider, and what a model costs: from the table, or the user's own number. */
function billingBlock(p) {
  const s = p.priceSample;
  const sub = p.billing === "subscription";
  const r = s?.rates;
  const own = p.prices?.[s?.model ?? ""];
  const priceText = !s ? "" : r
    ? `${esc(s.model)}：输入 $${r.input} · 输出 $${r.output} · 缓存读 $${r.cacheRead}（每百万 token，${s.source === "user" ? "你填的" : "价格表"}）`
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
function protocolOptions(p, model = "") {
  const selected = p.modelProtocols?.[model] ?? p.protocols ?? p.supportedProtocols ?? ["chat"];
  const order = [...selected, ...Object.keys(PROTOCOL).filter(v => !selected.includes(v))];
  return order.map(v => `<label><input type="checkbox" name="protocols" value="${esc(v)}" ${selected.includes(v) ? "checked" : ""}> ${PROTOCOL[v] ?? esc(v)}</label>`).join(" ");
}

function providerRow(p) {
  const models = modelsOf(p);
  const used = p.usedBy.map(h => icon(agentMeta(h).icon, "sm")).join("");
  const open = openProvider === p.id;
  const checks = (p.probe?.checks ?? []).map(c => `
    <div class="check ${c.status}"><b>${esc(c.label)}</b>${esc(c.detail)}${c.latencyMs != null ? ` · ${c.latencyMs}ms` : ""}</div>`).join("");
  const options = models.map(m => `<option ${m === p.defaultModel ? "selected" : ""}>${esc(m)}</option>`).join("");
  const fixed = p.plan || p.mimoFree || p.vertex || p.kiro || p.antigravity || p.cursor || p.kimi;
  const detail = open ? `
    <div class="detail" data-provider="${esc(p.id)}">
      <div class="controls">
        <span class="chip">来源协议：${(p.supportedProtocols ?? ["chat"]).map(v => PROTOCOL[v] ?? esc(v)).join(" / ") || "尚不支持"}</span>
      </div>
      ${fixed ? "" : `<form class="form" data-protocol-form>
        <div class="field"><label>设置范围</label><select name="model" data-protocol-model><option value="">整个来源</option>${models.map(m => `<option value="${esc(m)}">${esc(m)}${p.modelProtocols?.[m] ? "（单独设置）" : ""}</option>`).join("")}</select></div>
        <div class="controls" data-protocol-options>${protocolOptions(p)}</div>
        <div class="hint">按来源文档勾选它支持的协议。与客户端相同的协议优先；需要转换时，按这里的显示顺序选择。单个模型可独立设置。</div>
        <div class="controls"><button class="btn secondary" type="submit">保存协议</button><button class="btn secondary" type="button" data-protocol-auto>恢复默认</button></div>
      </form>`}
      <div class="controls">
        <label class="hint">测试用模型</label>
        <select class="probe-model">${options || "<option value=''>（没有可选模型）</option>"}</select>
        <button class="btn" data-probe ${((state.budget?.settings.enabled && state.budget.settings.action === "stop") || p.budget?.stop || p.budgetStatus?.configurationInvalid) ? "disabled title=\"暂停预算开启时不允许未完整计费的探测\"" : ""}>一致性测试</button>
        <span class="hint">${p.probe ? `上次测试：${ago(p.probe.at)}` : "还没测过"}</span>
      </div>
      ${checks ? `<div class="checks">${checks}</div>` : ""}
      <div class="hint">OpenAI 兼容地址：<span class="mono">${esc(p.baseUrl)}</span>${p.anthropicBaseUrl ? ` · Anthropic 地址：<span class="mono">${esc(p.anthropicBaseUrl)}</span>` : ""}</div>
      ${billingBlock(p)}
      ${budgetBlock(p)}
      ${keyList(p)}
      <div><button class="btn danger" data-remove>删除这个来源</button></div>
    </div>` : "";
  return `
    <div class="row clickable ${open ? "open" : ""}" data-toggle="${esc(p.id)}">
      ${icon(p.icon, "lg")}
      <div class="grow"><div class="title">${esc(p.name)}</div><div class="sub">${esc(hostOf(p.baseUrl))} · ${models.length} 个模型${p.budgetStatus ? ` · <span class="${p.budgetStatus.level === "ok" ? "quota" : "quota-out"}">${esc(budgetText(p.budgetStatus))}</span>` : ""}${p.quota ? ` · <span class="${p.quota.exhaustedUntil ? "quota-out" : "quota"}">${esc(p.quota.text)}</span>` : ""}</div></div>
      ${used ? `<span title="正在使用的 agent">${used}</span>` : ""}
      <span class="chip ${p.hasKey ? "ok" : "warn"}"><span class="dot"></span>${p.hasKey ? "Key 在钥匙串" : "未设置 Key"}</span>
      <span class="chev">›</span>
    </div>${detail}`;
}

let presetQuery = "";

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
        <button class="preset ${preset?.id === x.id ? "on" : ""}" data-preset="${esc(x.id)}" title="${esc(x.note ?? x.baseUrl)}">${icon(x.icon, "lg")}<span>${esc(x.name)}</span></button>`).join("")}
      </div>` : "";
  }).join("");
  return `<div id="preset-groups">${html || `<div class="empty">没有匹配的预设；可以选「自定义中转站」手动填</div>`}</div>`;
}

function renderAddForm() {
  const preset = addForm.preset;
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

function renderOcxImport() {
  const cands = ocxImport.candidates;
  const usable = cands.filter(c => !c.skipReason);
  return `
    <div class="detail" style="display:block">
      <div class="controls"><b>从 opencodex 导入</b><span class="hint">读 ~/.opencodex/config.json；Key 直接进钥匙串，不会显示或保存明文</span></div>
      ${cands.length ? usable.map(c => `
        <label class="row" style="cursor:pointer">
          <input type="checkbox" data-ocx="${esc(c.sourceId)}" ${ocxImport.chosen.has(c.sourceId) ? "checked" : ""}>
          ${icon(c.icon ?? "newapi-color", "sm")}
          <div class="grow"><div class="title">${esc(c.name)}</div><div class="sub">${esc(c.baseUrl)} · ${c.keys} 把 Key · ${c.models.length} 个模型</div></div>
        </label>`).join("") : ""}
        ${cands.filter(c => c.skipReason).map(c => `<div class="hint">· ${esc(c.name)}：${esc(c.skipReason)}</div>`).join("")}
      <div class="controls"><button class="btn" data-ocx-go ${usable.length ? "" : "disabled"}>导入选中的来源</button>
        <button class="btn secondary" data-ocx-cancel>取消</button></div>
    </div>`;
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
        <div class="sub">${a.kind === "kimi" ? `用 Kimi 会员账号登录，令牌存在钥匙串。${a.on ? "已打开：它的模型出现在下面的来源里" : "开关是关的：打开后 agent 才能用"}` : a.kind === "cursor" ? `在浏览器里登录 Cursor，令牌存在钥匙串。${a.on ? "已打开：它的模型出现在下面的来源里" : "开关是关的：打开后 agent 才能用"}<br><span class="quota-out">目前只支持纯文字对话（不能让它执行工具）；用第三方工具调用 Cursor 订阅，账号有被限制的风险，请自己决定要不要打开</span>` : a.kind === "antigravity" ? `用 Google 账号登录，令牌存在钥匙串。${a.on ? "已打开：它的模型出现在下面的来源里" : "开关是关的：打开后 agent 才能用"}<br><span class="quota-out">用第三方工具调用 Antigravity 订阅，账号有被限制的风险，请自己决定要不要打开</span>` : a.kind === "kiro" ? `登录在 Kiro CLI 里，我们每次请求时只读它、不保存令牌。${a.on ? "已打开：它的模型出现在下面的来源里" : "开关是关的：打开后 agent 才能用"}<br><span class="quota-out">用第三方工具调用 Kiro 订阅，账号有被限制的风险，请自己决定要不要打开</span>` : a.needsSignIn ? "登录失效了，需要重新登录" : !a.planUsage ? "已登录，但还没有允许使用订阅额度" : a.on ? "已打开：它的模型出现在下面的来源里，所有 agent 都能选" : "已登录，开关是关的：打开后它的模型才会出现，agent 才能用"}${a.quota && a.on && !a.needsSignIn && a.planUsage ? `<br><span class="${a.quota.exhaustedUntil ? "quota-out" : "quota"}">额度：${esc(a.quota.text)}</span>` : ""}</div></div>
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
      ${si?.status === "error" ? `<div class="row"><div class="grow"><div class="title">没有登录成功</div><div class="sub">${esc(si.message ?? "")}</div></div></div>` : ""}
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

/** Model pools: one name for several places to get a model from; a failing member is skipped. */
function poolsCard() {
  const pools = state.pools ?? [];
  // The same model offered by several sources: a pool is the obvious thing to make of it.
  const seen = new Map();
  for (const p of state.providers) for (const m of modelsOf(p)) { const k = m.toLowerCase(); (seen.get(k) ?? seen.set(k, []).get(k)).push(`${p.id}/${m}`); }
  const taken = new Set(pools.map(p => p.name.toLowerCase()));
  const suggestions = [...seen.entries()].filter(([name, list]) => list.length >= 2 && !taken.has(name)).slice(0, 4);
  const nameOf = key => { const i = key.indexOf("/"); const p = providerById(key.slice(0, i)); return `${key.slice(i + 1)}${p ? `（${p.name}）` : ""}`; };
  const row = p => `
    <div class="row">
      <span class="ic lg" style="display:grid;place-items:center;background:var(--pill);border-radius:10px;width:34px;height:34px">▦</span>
      <div class="grow"><div class="title">${esc(p.name)} <span class="hint">pool/${esc(p.id)}</span> <span class="chip">${p.strategy === "rotate" ? "轮流用" : "按顺序，前面的挂了再用后面的"}</span></div>
        <div class="sub">${p.members.map(m => esc(nameOf(m))).join(" → ")}${p.live.length < p.members.length ? " · <b>有来源已经不存在了</b>" : ""}</div></div>
      <button class="btn secondary" data-pool-edit="${esc(p.id)}">编辑</button>
      <button class="btn secondary" data-pool-del="${esc(p.id)}">${poolConfirmDel === p.id ? "再点一次删除" : "删除"}</button>
    </div>`;
  const options = state.providers.map(p => `
    <div class="field"><label>${esc(p.name)}</label>
      <div class="controls">${modelsOf(p).map(m => `<label style="display:flex;gap:4px;align-items:center"><input type="checkbox" name="members" value="${esc(`${p.id}/${m}`)}" ${poolForm?.members.includes(`${p.id}/${m}`) ? "checked" : ""}>${esc(m)}</label>`).join("") || `<span class="hint">还没有模型</span>`}</div></div>`).join("");
  const form = poolForm ? `
    <form class="form" data-pool-form>
      <div class="field"><label>名字（agent 里会看到 pool/名字）</label><input type="text" name="name" value="${esc(poolForm.name)}" required placeholder="比如 sonnet"></div>
      <div class="field"><label>怎么选</label><select name="strategy"><option value="order" ${poolForm.strategy === "order" ? "selected" : ""}>按顺序：先用勾在前面的，它挂了再用后面的</option><option value="rotate" ${poolForm.strategy === "rotate" ? "selected" : ""}>轮流：大家轮着来，分摊额度</option></select></div>
      ${options}
      <div class="controls"><button class="btn" type="submit">保存</button><button class="btn secondary" type="button" data-pool-cancel>取消</button></div>
      ${poolForm.error ? `<p class="hint" style="color:var(--bad)">${esc(poolForm.error)}</p>` : ""}
    </form>` : "";
  return `
    <div class="section-head"><h2>模型池</h2><span class="aside">同一个模型有多个来源时合成一个名字，一个挂了自动换下一个</span></div>
    <div class="card">
      ${pools.map(row).join("")}
      ${suggestions.map(([name, list]) => `<div class="row"><div class="grow"><div class="title">${esc(name)}</div><div class="sub">在 ${list.length} 个来源里都有：可以合成一个池</div></div><button class="btn secondary" data-pool-merge="${esc(name)}">合成一个池</button></div>`).join("")}
      ${form}
      ${poolForm ? "" : `<button class="add-row" data-pool-new>＋ 新建模型池</button>`}
    </div>`;
}

function renderProviders() {
  return `
    ${planCard()}
    ${typeof subscriptionSupportCard === "function" ? subscriptionSupportCard() : ""}
    <div class="section-head"><h2>模型来源</h2><span class="aside">中转站、官方 API、本地模型都可以；加进来先自动测一遍</span></div>
    <div class="card">
      ${state.providers.map(providerRow).join("") || `<div class="empty">还没有模型来源</div>`}
      ${ocxImport ? renderOcxImport() : ""}
      ${vertexForm ? renderVertexForm() : ""}
      ${addForm ? renderAddForm() : `<button class="add-row" data-add>＋ 添加模型来源</button><button class="add-row" data-vertex-open>${icon("gemini-color", "sm")} 添加 Google Vertex AI（服务账号）</button><button class="add-row" data-ocx-open>从 opencodex 导入</button>`}
    </div>
    ${state.providers.length ? poolsCard() : ""}`;
}

async function submitAdd(form) {
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
    msg.textContent = error.message;
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
  if (e.pool) parts.push(`走的是模型池 ${e.pool}，第 ${e.attempt}/${e.attempts} 个来源${e.status >= 400 && e.attempt < e.attempts ? "，它没答上，已经换下一个" : ""}`);
  if (e.inboundProtocol && e.outboundProtocol) parts.push(e.inboundProtocol === e.outboundProtocol
    ? `来源支持 ${PROTOCOL[e.inboundProtocol]}，保留原生请求与回复`
    : `${PROTOCOL[e.inboundProtocol]} → ${PROTOCOL[e.outboundProtocol]}，按来源转换请求与回复`);
  else if (e.route === "chat-translate") parts.push(`这个来源不支持 ${harness.protocol} 协议，EasySwitch 把请求翻译成 Chat 协议转发`);
  else parts.push(`这个来源原生支持 ${harness.protocol} 协议，请求原样转发`);
  if (e.dropped?.length) parts.push(`去掉了${e.dropped.map(d => TOOL_NAMES[d] ?? d.replace(/^tool:/, "")).join("、")}（目标协议不支持这些内容或参数）`);
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
  const fmt = v => cost ? money(v, v >= 1 ? 0 : 2) : compact(v);
  const W = host.clientWidth - 36, H = 200, left = 46, bottom = 22, top = 8;
  const plotW = W - left, plotH = H - bottom - top;
  const max = niceMax(Math.max(...values, 0));
  const slot = plotW / Math.max(days.length, 1);
  const bw = Math.min(24, slot * 0.62);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => max * f);
  const y = v => top + plotH - (v / max) * plotH;
  const labelEvery = Math.max(1, Math.ceil(days.length / 7));
  const svg = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${cost ? "每日估算花费柱状图" : "每日 token 用量柱状图"}">
      <g class="grid">${ticks.map(t => `<line x1="${left}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/>`).join("")}</g>
      <g class="axis">${ticks.map(t => `<text x="${left - 8}" y="${y(t) + 4}" text-anchor="end">${fmt(t)}</text>`).join("")}
        ${days.map((d, i) => i % labelEvery === 0 ? `<text x="${left + slot * i + slot / 2}" y="${H - 4}" text-anchor="middle">${d.day.slice(5).replace("-", "/")}</text>` : "").join("")}</g>
      ${values.map((v, i) => v > 0 ? `<path class="bar" d="${barPath(left + slot * i + (slot - bw) / 2, y(v), bw, top + plotH - y(v))}"/>` : "").join("")}
      ${days.map((d, i) => `<rect class="bar-hit" data-i="${i}" x="${left + slot * i}" y="${top}" width="${slot}" height="${plotH}"/>`).join("")}
    </svg>`;
  host.innerHTML = `${svg}${values.every(v => v === 0) ? `<div class="empty" style="position:absolute;inset:0;display:grid;place-items:center">${cost ? "这段时间没有可估价的用量" : "这段时间还没有用量"}</div>` : ""}`;
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  host.append(tip);
  host.querySelector("svg").addEventListener("mousemove", e => {
    const hit = e.target.closest(".bar-hit");
    if (!hit) { tip.hidden = true; return; }
    const d = days[Number(hit.dataset.i)];
    tip.innerHTML = `<b>${d.day}</b><br>${thousands(d.inputTokens + d.outputTokens)} tokens · ${d.calls} 次调用${d.costUsd ? `<br>估算 ${money(d.costUsd)}` : ""}`;
    const hb = host.getBoundingClientRect();
    tip.style.left = `${e.clientX - hb.left}px`;
    tip.style.top = `${e.clientY - hb.top - 10}px`;
    tip.hidden = false;
  });
  host.querySelector("svg").addEventListener("mouseleave", () => { tip.hidden = true; });
}

/** One table cell of money: a subscription says so, an unpriced model says "—", never a false zero. */
function costCell(v, provider) {
  if (provider?.billing === "subscription" || (v.subscription && !v.costUsd)) return `<span class="hint">包月</span>`;
  if (!v.costUsd) return v.unpriced ? `<span class="hint" title="这个模型没有价格，可以在模型来源里自己填">—</span>` : "—";
  return `${money(v.costUsd)}${v.unpriced ? `<span class="hint" title="另有 ${v.unpriced} 次没有价格，没有计入"> +</span>` : ""}`;
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
      <td class="num">${v.inputTokens ? `${Math.round((v.cachedTokens / v.inputTokens) * 100)}%` : "—"}</td><td class="num">${v.errors}</td>
      <td class="num">${costCell(v, p)}</td></tr>`;
  }).join("");
  const harnessRows = Object.entries(usage.byHarness).map(([h, v]) => `
    <tr><td>${icon(HARNESS[h]?.icon ?? "newapi-color", "sm")} ${HARNESS[h]?.name ?? esc(h)}</td><td class="num">${thousands(v.calls)}</td>
      <td class="num">${compact(v.inputTokens)}</td><td class="num">${compact(v.outputTokens)}</td><td class="num">${v.errors}</td>
      <td class="num">${costCell(v)}</td></tr>`).join("");
  const costTile = t.subscription && !t.costUsd
    ? `<div class="tile"><div class="v">包月</div><div class="l">估算花费</div><div class="d">${t.subscription} 次调用在套餐内</div></div>`
    : `<div class="tile"><div class="v">${t.costUsd || !t.unpriced ? money(t.costUsd) : "—"}</div><div class="l">估算花费</div><div class="d">${[t.unpriced ? `${t.unpriced} 次没有价格` : "", t.subscription ? `${t.subscription} 次在套餐内` : ""].filter(Boolean).join(" · ") || "按各家公开的按量价格估算"}</div></div>`;
  return `
    <div class="section-head"><h2>用量</h2>
      <span style="display:flex;gap:10px;align-items:center">
        <nav class="seg" id="currency"><button data-currency="CNY" class="${state.display?.currency !== "USD" ? "on" : ""}">¥</button><button data-currency="USD" class="${state.display?.currency === "USD" ? "on" : ""}">$</button></nav>
        <nav class="seg" id="range">${Object.entries(ranges).map(([k, v]) => `<button data-range="${k}" class="${usageRange === k ? "on" : ""}">${v}</button>`).join("")}</nav></span>
    </div>
    <div class="card tiles">
      <div class="tile"><div class="v">${compact(t.inputTokens + t.outputTokens)}</div><div class="l">Token</div><div class="d">输入 ${compact(t.inputTokens)} · 输出 ${compact(t.outputTokens)}</div></div>
      <div class="tile"><div class="v">${compact(t.cachedTokens)}</div><div class="l">缓存读取</div><div class="d">命中率 ${hit}</div></div>
      <div class="tile"><div class="v">${thousands(t.calls)}</div><div class="l">调用次数</div><div class="d">${t.unmetered ? `${t.unmetered} 次原样转发未计量` : "全部已计量"}</div></div>
      ${costTile}
      <div class="tile"><div class="v">${thousands(t.errors)}</div><div class="l">失败</div><div class="d">${t.calls ? `占 ${Math.round((t.errors / t.calls) * 100)}%` : "—"}</div></div>
    </div>
    <div class="card"><div class="section-head" style="padding:12px 18px 0"><span class="hint">每日</span>
        <nav class="seg" id="metric"><button data-metric="tokens" class="${chartMetric === "tokens" ? "on" : ""}">Token</button><button data-metric="cost" class="${chartMetric === "cost" ? "on" : ""}">花费</button></nav></div>
      <div class="chart" id="chart"></div>
      <details data-keep="usage-days" ${keepOpen("usage-days")} style="padding:0 18px 12px"><summary class="hint">查看每日数据表</summary>
        <table class="tbl"><tr><th>日期</th><th class="num">输入</th><th class="num">输出</th><th class="num">调用</th><th class="num">估算花费</th></tr>
        ${usage.days.map(d => `<tr><td>${d.day}</td><td class="num">${thousands(d.inputTokens)}</td><td class="num">${thousands(d.outputTokens)}</td><td class="num">${d.calls}</td><td class="num">${d.costUsd ? money(d.costUsd) : "—"}</td></tr>`).join("")}</table>
      </details>
    </div>
    <div class="section-head"><h2>按模型来源</h2></div>
    <div class="card">${providerRows ? `<table class="tbl"><tr><th>来源</th><th class="num">调用</th><th class="num">输入</th><th class="num">输出</th><th class="num">缓存命中</th><th class="num">失败</th><th class="num">估算花费</th></tr>${providerRows}</table>` : `<div class="empty">还没有用量</div>`}</div>
    <div class="section-head"><h2>按 Agent</h2></div>
    <div class="card">${harnessRows ? `<table class="tbl"><tr><th>Agent</th><th class="num">调用</th><th class="num">输入</th><th class="num">输出</th><th class="num">失败</th><th class="num">估算花费</th></tr>${harnessRows}</table>` : `<div class="empty">还没有用量</div>`}</div>`;
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
  const views = { agents: renderAgents, tasks: renderTasks, providers: renderProviders, accounts: renderAccounts, sessions: renderSessions, usage: renderUsage };
  main.innerHTML = (views[page] ?? renderAgents)();
  if (!PANEL && page === "agents" && typeof gatewaySessionsCard === "function") main.innerHTML += gatewaySessionsCard();
  if (page === "usage" && typeof budgetSettingsCard === "function") main.innerHTML += budgetSettingsCard();
  if (page === "sessions") requestAnimationFrame(drawFlowLines);
  if (page === "usage") requestAnimationFrame(drawChart);
}

/** Re-render unless the user is in the middle of something we would wipe out. */
function busy() {
  return guideBusy || (typeof budgetSaving !== "undefined" && budgetSaving) || claudeDesktopBusy || claudeDesktopConfirm || popover || addForm || vertexForm || ocxImport || importFormOpen || poolForm || profileNaming || ruleForm || document.activeElement?.matches("input, select, textarea");
}
/** Typing survives a re-render: copy what is in the task form into taskForm first. */
function syncTaskForm() {
  const f = document.querySelector("form[data-task-form]");
  if (!f) return;
  taskForm.task = f.elements.task?.value ?? "";
  taskForm.model = f.elements.model?.value ?? "";
  taskForm.cwd = f.elements.cwd?.value ?? "";
}
document.addEventListener("input", e => { if (e.target.closest?.("form[data-task-form]")) syncTaskForm(); });
document.addEventListener("change", async e => {
  const desktopModel = e.target.closest?.("[data-claude-desktop-model]");
  if (desktopModel) { claudeDesktopModel = desktopModel.value; claudeDesktopConfirm = false; claudeDesktopError = ""; render(); return; }
  const sel = e.target.closest?.("[data-effort-select]");
  if (!sel) return;
  try {
    await call("PUT", `/api/bindings/${sel.dataset.effortSelect}/effort`, { effort: sel.value });
    toast(sel.value ? `推理档位设为 ${sel.value}，下次启动生效` : "推理档位恢复为它自己的默认");
  } catch (error) { toast(error.message); }
  await refresh(true);
});
/** The onboarding card keeps its state between renders (the user is typing into it). */
let importFormOpen = false;

async function refresh(force = false) {
  try {
    state = await call("GET", "/api/state");
  } catch {
    state = null;
  }
  if (page === "providers" || PANEL) planInfo = await call("GET", "/api/plan").catch(() => planInfo);
  if (page === "agents" && !PANEL) {
    chatgptInfo = await call("GET", "/api/chatgpt").catch(() => chatgptInfo);
    claudeDesktopInfo = await call("GET", "/api/claude-desktop").catch(() => null);
  }
  if (page === "tasks") {
    taskList = await call("GET", "/api/tasks").catch(() => taskList);
    if (!agentList) agentList = await loadAgents();
  }
  if (page === "agents" && !PANEL && !agentList) {
    agentList = await loadAgents();
    if (agentList) force = true;
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
    claudeDesktopConfirm = false;
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

  const accLaunch = t.closest("[data-acc-launch]");
  if (accLaunch) {
    try { const r = await call("POST", "/api/accounts/launch", { harness: accLaunch.dataset.h, accountId: accLaunch.dataset.accLaunch }); toast(`已在终端里打开「${r.account.label}」`); } catch (error) { toast(error.message); }
    setTimeout(() => refresh(true), 800);
    return;
  }
  const accAuto = t.closest("[data-acc-auto]");
  if (accAuto) {
    try { const r = await call("POST", "/api/accounts/launch", { harness: accAuto.dataset.accAuto }); toast(`自动选了「${r.account.label}」${r.note ? `（${r.note}）` : ""}`); } catch (error) { toast(error.message); }
    setTimeout(() => refresh(true), 800);
    return;
  }
  const accRest = t.closest("[data-acc-rest]");
  if (accRest) {
    try { await call("PATCH", `/api/accounts/${accRest.dataset.accRest}`, { rest: accRest.dataset.on === "1" }); } catch (error) { toast(error.message); }
    await refresh(true);
    return;
  }
  const accToggle = t.closest("[data-acc-toggle]");
  if (accToggle) {
    try { await call("PATCH", `/api/accounts/${accToggle.dataset.accToggle}`, { enabled: accToggle.dataset.enabled === "1" }); } catch (error) { toast(error.message); }
    await refresh(true);
    return;
  }
  const accDel = t.closest("[data-acc-del]");
  if (accDel) {
    try { const r = await call("DELETE", `/api/accounts/${accDel.dataset.accDel}`); toast("已移除；登录目录仍保留在 " + r.keptDirectory); } catch (error) { toast(error.message); }
    await refresh(true);
    return;
  }
  const accAutoPick = t.closest("[data-acc-autopick]");
  if (accAutoPick) {
    const mode = accAutoPick.dataset.accAutopick;
    if (mode === "ask") { autoConfirm = true; render(); return; }
    if (mode === "cancel") { autoConfirm = false; render(); return; }
    autoConfirm = false;
    try { await call("PUT", "/api/accounts/settings", { autoPick: mode === "on" }); } catch (error) { toast(error.message); }
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
    } catch (error) { toast(error.message); }
    await refresh(true);
    return;
  }

  if (t.closest("[data-claude-desktop-ask]")) {
    if (claudeDesktopBusy || claudeDesktopInfo?.launchBlocked !== false || !claudeDesktopInfo?.installed || !claudeDesktopModel) return;
    claudeDesktopConfirm = true; claudeDesktopError = ""; render(); return;
  }
  if (t.closest("[data-claude-desktop-cancel]")) { claudeDesktopConfirm = false; render(); return; }
  const desktopStart = t.closest("[data-claude-desktop-start]");
  const desktopStop = t.closest("[data-claude-desktop-stop]");
  if (desktopStart || desktopStop) {
    if (claudeDesktopBusy || (desktopStart && (!claudeDesktopConfirm || claudeDesktopInfo?.launchBlocked !== false))) return;
    claudeDesktopBusy = true; claudeDesktopConfirm = false; claudeDesktopError = ""; render();
    try {
      if (desktopStop) {
        await call("POST", `/api/claude-desktop/sessions/${desktopStop.dataset.claudeDesktopStop}/stop`, {});
        toast("这个独立会话已停止，私有目录已清理");
      } else {
        await call("POST", "/api/claude-desktop/sessions", { experimental: true, model: claudeDesktopModel });
        toast("独立进程已启动，真实窗口和模型连接仍需确认");
      }
    } catch (error) { claudeDesktopError = error.message; }
    finally { claudeDesktopBusy = false; }
    await refresh(true); return;
  }

  const agentLaunch = t.closest("[data-agent-launch]");
  if (agentLaunch) {
    try { const r = await call("POST", `/api/agents/${agentLaunch.dataset.agentLaunch}/launch`, {}); toast(`已在终端里启动（${r.model}）`); } catch (error) { toast(error.message); }
    return;
  }
  const pickAgent = t.closest("[data-task-agent]");
  if (pickAgent) { syncTaskForm(); taskForm.agent = pickAgent.dataset.taskAgent; taskForm.effort = ""; try { localStorage.setItem("es.taskAgent", taskForm.agent); } catch {} render(); return; }
  const pickEffort = t.closest("[data-task-effort]");
  if (pickEffort) { syncTaskForm(); taskForm.effort = pickEffort.dataset.taskEffort; render(); return; }
  if (t.closest("[data-rule-new]")) {
    const first = (agentList ?? []).find(a => a.installed && a.can?.headless);
    ruleForm = { name: "", words: "", minChars: "", maxChars: "", cwdPrefix: "", agent: first?.id ?? "", model: "", effort: "" };
    render();
    return;
  }
  if (t.closest("[data-rule-cancel]")) { ruleForm = null; render(); return; }
  const ruleMove = t.closest("[data-rule-move]");
  if (ruleMove) { await call("POST", `/api/rules/${ruleMove.dataset.rule}/move`, { direction: ruleMove.dataset.ruleMove }).catch(error => toast(error.message)); await refresh(true); return; }
  const ruleToggle = t.closest("[data-rule-toggle]");
  if (ruleToggle) {
    const r = (state.rules ?? []).find(x => x.id === ruleToggle.dataset.ruleToggle);
    if (r) await call("PUT", `/api/rules/${r.id}`, { name: r.name, enabled: !r.enabled, when: r.when, then: r.then }).catch(error => toast(error.message));
    await refresh(true);
    return;
  }
  const ruleDel = t.closest("[data-rule-del]");
  if (ruleDel) { await call("DELETE", `/api/rules/${ruleDel.dataset.ruleDel}`).catch(error => toast(error.message)); await refresh(true); return; }
  if (t.closest("[data-rule-test]")) {
    const task = document.querySelector("[data-rule-test-input]")?.value ?? "";
    ruleTest.task = task;
    try { ruleTest.result = await call("POST", "/api/rules/test", { task }); } catch (error) { ruleTest.result = { error: error.message }; }
    render();
    return;
  }
  const taskToggle = t.closest("[data-task-toggle]");
  if (taskToggle) { const id = taskToggle.dataset.taskToggle; if (taskOpenIds.has(id)) taskOpenIds.delete(id); else taskOpenIds.add(id); render(); return; }
  const taskStop = t.closest("[data-task-stop]");
  if (taskStop) { await call("POST", `/api/tasks/${taskStop.dataset.taskStop}/stop`).catch(() => {}); await refresh(true); return; }
  if (t.closest("[data-task-clear]")) { await call("DELETE", "/api/tasks").catch(() => {}); await refresh(true); return; }

  if (t.closest("[data-plan-signin]") || t.closest("[data-plan-signin-again]")) {
    const againBtn = t.closest("[data-plan-signin-again]");
    // A Codex-identity account just signs in again the same way; one made with OpenAI's own route signs in again with its own client.
    const again = againBtn && againBtn.dataset.planKind !== "codex" ? againBtn.dataset.planSigninAgain : undefined;
    const mode = againBtn?.dataset.planKind === "copilot" ? "copilot" : t.closest("[data-plan-mode]")?.dataset.planMode;
    try { await call("POST", "/api/plan/signin", again ? { accountId: again, mode: "open" } : mode ? { mode } : {}); } catch (error) { toast(error.message); }
    await refresh(true);
    return;
  }
  if (t.closest("[data-plan-cancel]")) { await call("POST", "/api/plan/signin", { cancelOnly: true }).catch(() => {}); await refresh(true); return; }
  const planModels = t.closest("[data-plan-models]");
  if (planModels) {
    try { const r = await call("POST", `/api/plan/${planModels.dataset.planModels}/models`); toast(`模型已更新：${r.models.length} 个`); } catch (error) { toast(error.message); }
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
    try { guideData = await call("POST", `/api/agents/${id}/setup`, {}); guideOpen = id; guideReveal = false; } catch (error) { toast(error.message); } finally { guideBusy = false; }
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
    try { await call("POST", "/api/kimi/signin", {}); toast("已在浏览器里打开 Kimi 登录页，确认页面上的码"); } catch (error) { toast(error.message); }
    await refresh(true);
    return;
  }
  const kmRefresh = t.closest("[data-kimi-refresh]");
  if (kmRefresh) {
    try { const r = await call("POST", `/api/kimi/${kmRefresh.dataset.kimiRefresh}/refresh`, {}); toast(`模型列表已更新，有 ${r.models.length} 个`); } catch (error) { toast(error.message); }
    await refresh(true);
    return;
  }
  const kmOut = t.closest("[data-kimi-remove]");
  if (kmOut) {
    const id = kmOut.dataset.kimiRemove;
    if (planConfirmOut !== id) { planConfirmOut = id; render(); return; }
    planConfirmOut = null;
    try { await call("DELETE", `/api/kimi/${id}`); toast("已退出登录，令牌已从钥匙串删除"); } catch (error) { toast(error.message); }
    await refresh(true);
    return;
  }
  if (t.closest("[data-cursor-signin]")) {
    try { await call("POST", "/api/cursor/signin", {}); toast("已在浏览器里打开 Cursor 登录页"); } catch (error) { toast(error.message); }
    await refresh(true);
    return;
  }
  const cuRefresh = t.closest("[data-cursor-refresh]");
  if (cuRefresh) {
    try { const r = await call("POST", `/api/cursor/${cuRefresh.dataset.cursorRefresh}/refresh`, {}); toast(`模型列表已更新，有 ${r.models.length} 个`); } catch (error) { toast(error.message); }
    await refresh(true);
    return;
  }
  const cuOut = t.closest("[data-cursor-remove]");
  if (cuOut) {
    const id = cuOut.dataset.cursorRemove;
    if (planConfirmOut !== id) { planConfirmOut = id; render(); return; }
    planConfirmOut = null;
    try { await call("DELETE", `/api/cursor/${id}`); toast("已退出登录，令牌已从钥匙串删除"); } catch (error) { toast(error.message); }
    await refresh(true);
    return;
  }
  if (t.closest("[data-antigravity-signin]")) {
    try { await call("POST", "/api/antigravity/signin", {}); toast("已在浏览器里打开 Google 登录页"); } catch (error) { toast(error.message); }
    await refresh(true);
    return;
  }
  const agRefresh = t.closest("[data-antigravity-refresh]");
  if (agRefresh) {
    try { const r = await call("POST", `/api/antigravity/${agRefresh.dataset.antigravityRefresh}/refresh`, {}); toast(`模型列表已更新，有 ${r.models.length} 个`); } catch (error) { toast(error.message); }
    await refresh(true);
    return;
  }
  const agOut = t.closest("[data-antigravity-remove]");
  if (agOut) {
    const id = agOut.dataset.antigravityRemove;
    if (planConfirmOut !== id) { planConfirmOut = id; render(); return; }
    planConfirmOut = null;
    try { await call("DELETE", `/api/antigravity/${id}`); toast("已退出登录，令牌已从钥匙串删除"); } catch (error) { toast(error.message); }
    await refresh(true);
    return;
  }
  if (t.closest("[data-kiro-import]")) {
    try { const r = await call("POST", "/api/kiro/import", {}); toast(`已读到 Kiro 的登录，有 ${r.models} 个模型；开关是关的，打开后才能用`); } catch (error) { toast(error.message); }
    await refresh(true);
    return;
  }
  const kiroOut = t.closest("[data-kiro-remove]");
  if (kiroOut) {
    const id = kiroOut.dataset.kiroRemove;
    if (planConfirmOut !== id) { planConfirmOut = id; render(); return; }
    planConfirmOut = null;
    try { await call("DELETE", `/api/kiro/${id}`); toast("已移除这个来源；Kiro CLI 自己的登录没有动"); } catch (error) { toast(error.message); }
    await refresh(true);
    return;
  }
  const planSwitch = t.closest("[data-plan-switch]");
  if (planSwitch) {
    const turnOn = planSwitch.dataset.on !== "1";
    try { await call("PUT", `/api/plan/${planSwitch.dataset.planSwitch}/switch`, { on: turnOn }); toast(turnOn ? "已打开：它的模型现在可以选了" : "已关闭：哪里都不会再用它"); } catch (error) { toast(error.message); }
    await refresh(true);
    return;
  }
  const planOut = t.closest("[data-plan-signout]");
  if (planOut) {
    const id = planOut.dataset.planSignout;
    if (planConfirmOut !== id) { planConfirmOut = id; render(); return; }
    planConfirmOut = null;
    try { await call("DELETE", `/api/plan/${id}`); toast("已退出登录，并在 OpenAI 那边撤销了这次登录"); } catch (error) { toast(error.message); }
    await refresh(true);
    return;
  }
  if (t.closest("[data-profile-new]")) { profileNaming = true; render(); return; }
  if (t.closest("[data-profile-cancel]")) { profileNaming = false; render(); return; }
  if (t.closest("[data-profile-apply]")) {
    const id = document.querySelector("[data-profile-pick]")?.value;
    try { const r = await call("POST", `/api/profiles/${id}/apply`); toast(`已切换到「${r.name}」：下次启动的会话就用这套设置`); } catch (error) { toast(error.message); }
    await refresh(true);
    return;
  }
  if (t.closest("[data-profile-del]")) {
    const id = document.querySelector("[data-profile-pick]")?.value;
    try { await call("DELETE", `/api/profiles/${id}`); toast("已删除这个方案"); } catch (error) { toast(error.message); }
    await refresh(true);
    return;
  }
  if (t.closest("[data-pool-new]")) { poolForm = { name: "", strategy: "order", members: [] }; render(); return; }
  if (t.closest("[data-pool-cancel]")) { poolForm = null; render(); return; }
  const poolEdit = t.closest("[data-pool-edit]");
  if (poolEdit) { const p = (state.pools ?? []).find(x => x.id === poolEdit.dataset.poolEdit); if (p) { poolForm = { id: p.id, name: p.name, strategy: p.strategy, members: [...p.members] }; render(); } return; }
  const poolMerge = t.closest("[data-pool-merge]");
  if (poolMerge) {
    const name = poolMerge.dataset.poolMerge;
    const members = state.providers.flatMap(p => modelsOf(p).filter(m => m.toLowerCase() === name).map(m => `${p.id}/${m}`));
    try { await call("POST", "/api/pools", { name, strategy: "order", members }); toast(`已合成 pool/${name}，顺序是来源列表的顺序，可以再编辑`); } catch (error) { toast(error.message); }
    await refresh(true);
    return;
  }
  const poolDel = t.closest("[data-pool-del]");
  if (poolDel) {
    const id = poolDel.dataset.poolDel;
    if (poolConfirmDel !== id) { poolConfirmDel = id; render(); return; }
    poolConfirmDel = null;
    try { await call("DELETE", `/api/pools/${id}`); toast("已删除模型池；绑定了它的 agent 回到原生"); } catch (error) { toast(error.message); }
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
    try { await call("PUT", `/api/providers/${key.slice(0, slash)}/model-efforts`, { model: key.slice(slash + 1), levels }); toast(levels.length ? "已记下这个模型的档位" : "已清除这个模型的档位"); } catch (error) { toast(error.message); }
    levelsEditor = null;
    await refresh(true);
    return;
  }
  const agentOpen = t.closest("[data-agent-open]");
  if (agentOpen) {
    try { await call("POST", `/api/agents/${agentOpen.dataset.agentOpen}/open`); toast("已打开"); } catch (error) { toast(error.message); }
    return;
  }

  const currency = t.closest("[data-currency]");
  if (currency) { try { await call("PUT", "/api/display", { currency: currency.dataset.currency }); } catch (error) { toast(error.message); } await refresh(true); return; }
  const metric = t.closest("[data-metric]");
  if (metric) { chartMetric = metric.dataset.metric; render(); return; }

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
    ocxImport = null;
    render();
    return;
  }
  if (t.closest("[data-ocx-open]")) {
    try {
      const { candidates } = await call("GET", "/api/import/opencodex");
      ocxImport = { candidates: candidates ?? [], chosen: new Set((candidates ?? []).filter(c => !c.skipReason).map(c => c.sourceId)) };
    } catch (error) {
      ocxImport = { candidates: [], chosen: new Set() };
      toast(error.message);
    }
    addForm = null;
    render();
    return;
  }
  if (t.closest("[data-ocx-cancel]")) { ocxImport = null; render(); return; }
  const ocxBox = t.closest('[data-ocx]');
  if (ocxBox) {
    ocxImport.chosen.has(ocxBox.dataset.ocx) ? ocxImport.chosen.delete(ocxBox.dataset.ocx) : ocxImport.chosen.add(ocxBox.dataset.ocx);
    return;
  }
  if (t.closest("[data-ocx-go]")) {
    try {
      const result = await call("POST", "/api/import/opencodex", { chosen: [...ocxImport.chosen] });
      const ok = result.imported.length;
      const bad = result.failed.map(f => `${f.sourceId}: ${f.reason}`).join("；");
      toast(ok ? `已导入 ${ok} 个来源${bad ? `；失败的：${bad}` : ""}` : `导入失败：${bad}`);
      ocxImport = null;
    } catch (error) { toast(error.message); }
    await refresh(true);
    return;
  }
  const preset = t.closest("[data-preset]");
  if (preset) { addForm = { preset: presets.find(x => x.id === preset.dataset.preset) }; render(); return; }
  if (t.closest("[data-cancel-add]")) { addForm = null; render(); return; }

  const detail = t.closest(".detail");
  if (detail) {
    const id = detail.dataset.provider;
    const priceClear = t.closest("[data-price-clear]");
    if (priceClear) {
      try { await call("PUT", `/api/providers/${id}/prices`, { model: priceClear.dataset.priceClear, rates: null }); toast("已清除，改用价格表"); } catch (error) { toast(error.message); }
      await refresh(true);
      return;
    }
    const keyPatch = t.closest("[data-key-patch]");
    if (keyPatch) {
      try { await call("PATCH", `/api/providers/${id}/keys/${keyPatch.dataset.keyPatch}`, { enabled: keyPatch.dataset.enabled === "1" }); } catch (error) { toast(error.message); }
      await refresh(true);
      return;
    }
    const keyDel = t.closest("[data-key-del]");
    if (keyDel) {
      try { await call("DELETE", `/api/providers/${id}/keys/${keyDel.dataset.keyDel}`); toast("已删除这把 Key"); } catch (error) { toast(error.message); }
      await refresh(true);
      return;
    }
    const button = t.closest("button");
    if (!button) return;
    if (button.type === "submit" && button.closest("form")) return;
    button.disabled = true;
    try {
      if (button.hasAttribute("data-probe")) {
        button.textContent = "测试中…";
        await call("POST", `/api/providers/${id}/probe`, { model: detail.querySelector(".probe-model").value });
      } else if (button.hasAttribute("data-protocol-auto")) {
        const model = detail.querySelector("[data-protocol-model]").value;
        await call("PUT", `/api/providers/${id}/protocols`, { protocols: null, ...(model ? { model } : {}) });
        toast(model ? "模型已恢复来源设置" : "来源已恢复自动识别");
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

document.addEventListener("change", async e => {
  if (e.target.matches("[data-protocol-model]")) {
    const detail = e.target.closest(".detail");
    detail.querySelector("[data-protocol-options]").innerHTML = protocolOptions(providerById(detail.dataset.provider), e.target.value);
    return;
  }
  if (!e.target.matches(".billing-select")) return;
  const id = e.target.closest(".detail")?.dataset.provider;
  try { await call("PUT", `/api/providers/${id}/billing`, { billing: e.target.value }); toast(e.target.value === "subscription" ? "已改为包月套餐" : "已改为按量计费"); } catch (error) { toast(error.message); }
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
    const f = new FormData(form); const model = f.get("model");
    const protocols = f.getAll("protocols");
    if (!protocols.length) { toast("请至少选择一个来源支持的协议"); return; }
    const id = form.closest(".detail").dataset.provider;
    form.dataset.saving = "1";
    form.querySelectorAll("button, input, select").forEach(el => { el.disabled = true; });
    try {
      await call("PUT", `/api/providers/${id}/protocols`, { protocols, ...(model ? { model } : {}) });
      toast(model ? "模型协议已保存" : "来源协议已保存");
      await refresh(true);
    } catch (error) { toast(error.message); }
    finally { delete form.dataset.saving; form.querySelectorAll("button, input, select").forEach(el => { el.disabled = false; }); }
    return;
  }
  if (e.target.id === "add-form") { e.preventDefault(); submitAdd(e.target); return; }
  if (e.target.matches?.("[data-quick-task]")) {
    e.preventDefault();
    const text = String(new FormData(e.target).get("task") ?? "").trim();
    if (!text) return;
    try {
      await call("POST", "/api/tasks", { agent: AUTO, task: text });
      toast("已派出去，结果在「任务」页");
      page = "tasks";
      if (!PANEL) history.replaceState(null, "", "#tasks");
    } catch (error) { toast(`没有派出去：${error.message}`); }
    await refresh(true);
    return;
  }
  if (e.target.dataset?.providerBudgetForm) {
    e.preventDefault();
    const f = new FormData(e.target);
    const usd = String(f.get("monthlyUsd") ?? "").trim();
    try {
      await call("PUT", `/api/providers/${e.target.dataset.providerBudgetForm}/budget`, { monthlyUsd: usd === "" ? null : Number(usd), stop: f.get("stop") === "on" });
      toast(usd === "" ? "已取消预算" : "预算已保存");
    } catch (error) { toast(error.message); }
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
      vertexForm = { message: error.message };
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
      msg.textContent = error.message;
    }
    await refresh(true);
    return;
  }
  const profileFormEl = e.target.closest("form[data-profile-form]");
  if (profileFormEl) {
    e.preventDefault();
    try { await call("POST", "/api/profiles", { name: new FormData(profileFormEl).get("name") }); toast("方案已保存"); profileNaming = false; } catch (error) { toast(error.message); }
    await refresh(true);
    return;
  }
  const ruleFormEl = e.target.closest("form[data-rule-form]");
  if (ruleFormEl) {
    e.preventDefault();
    const f = new FormData(ruleFormEl);
    const body = {
      name: f.get("name"),
      when: { anyWords: f.get("words"), minChars: f.get("minChars"), maxChars: f.get("maxChars"), cwdPrefix: f.get("cwdPrefix") },
      then: { agent: f.get("agent"), model: f.get("model"), effort: f.get("effort") },
    };
    try {
      await call("POST", "/api/rules", body);
      ruleForm = null;
      toast("规则已保存");
    } catch (error) {
      ruleForm = { name: String(f.get("name")), words: String(f.get("words")), minChars: String(f.get("minChars")), maxChars: String(f.get("maxChars")), cwdPrefix: String(f.get("cwdPrefix")), agent: String(f.get("agent")), model: String(f.get("model")), effort: String(f.get("effort")), error: error.message };
    }
    await refresh(true);
    return;
  }
  const poolFormEl = e.target.closest("form[data-pool-form]");
  if (poolFormEl) {
    e.preventDefault();
    const f = new FormData(poolFormEl);
    const body = { name: f.get("name"), strategy: f.get("strategy"), members: f.getAll("members") };
    try {
      await call(poolForm?.id ? "PUT" : "POST", poolForm?.id ? `/api/pools/${poolForm.id}` : "/api/pools", body);
      poolForm = null;
      toast("模型池已保存");
    } catch (error) {
      poolForm = { ...poolForm, name: body.name, strategy: body.strategy, members: body.members, error: error.message };
    }
    await refresh(true);
    return;
  }
  const runForm = e.target.closest("form[data-task-form]");
  if (runForm) {
    e.preventDefault();
    const f = new FormData(runForm);
    taskNote = "";
    try {
      const agent = taskForm.agent || (() => { try { return localStorage.getItem("es.taskAgent"); } catch { return null; } })() || ((state.rules ?? []).length ? AUTO : runForm.querySelector('[data-task-agent]:not([data-task-agent="auto"])')?.dataset.taskAgent);
      const body = { agent, task: f.get("task"), ...(taskForm.effort ? { effort: taskForm.effort } : {}), ...(f.get("model") ? { model: f.get("model") } : {}), ...(f.get("cwd") ? { cwd: f.get("cwd") } : {}) };
      const r = await call("POST", "/api/tasks", body);
      taskOpenIds.add(r.task.id);
      taskForm.task = "";
    } catch (error) {
      taskNote = `没有派出去：${error.message}`;
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
    try { await call("PUT", `/api/providers/${id}/prices`, { model: priceForm.dataset.priceForm, rates: { input: num("input"), output: num("output"), cacheRead: num("cacheRead"), cacheWrite: 0 } }); toast("已保存价格"); } catch (error) { toast(error.message); }
    await refresh(true);
    return;
  }
  const accForm = e.target.closest("form[data-add-account]");
  if (accForm) {
    e.preventDefault();
    try {
      await call("POST", "/api/accounts", { harness: accForm.dataset.addAccount, label: new FormData(accForm).get("label") });
      toast("已添加；点「启动」，第一次在终端里登录一次");
    } catch (error) { toast(error.message); }
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
  } catch (error) { toast(error.message); }
  await refresh(true);
});
document.addEventListener("keydown", e => { if (e.key === "Escape") { closePopover(); if (claudeDesktopConfirm) { claudeDesktopConfirm = false; render(); } } });
// "toggle" does not bubble, so listen in the capture phase.
document.addEventListener("toggle", e => {
  const id = e.target?.dataset?.keep;
  if (!id) return;
  if (e.target.open) openDetails.add(id); else openDetails.delete(id);
}, true);
window.addEventListener("resize", () => { if (page === "sessions") drawFlowLines(); if (page === "usage") drawChart(); });

if (PANEL) document.body.classList.add("panel");
if (PANEL) {
  $("#nav").remove();
  $("#refresh").remove();
}
fetch("icons/manifest.json").then(r => r.json()).then(m => { monoIcons = new Set(m.mono); if (state) render(); }).catch(() => {});
refresh(true);
setInterval(() => refresh(), 3000);
