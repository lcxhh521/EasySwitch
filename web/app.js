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
const ROUTE = { "responses-native": "原样转发", "anthropic-native": "原样转发", "chat-translate": "协议转换" };
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
/** Which collapsible panels the user opened; the page redraws every few seconds and must not close them. */
const openDetails = new Set();
const keepOpen = id => (openDetails.has(id) ? "open" : "");

let taskList = null; // /api/tasks
const taskOpenIds = new Set(); // task ids whose output is expanded
let taskNote = "";
let agentList = null; // every agent we know of, from /api/agents
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

/** Under an agent's row: its reasoning level and the other models it runs next to the main one. */
function agentSettings(id) {
  const binding = state.bindings?.[id];
  const can0 = (agentList ?? []).find(a => a.id === id)?.can;
  if (!binding || !can0) return "";
  // A level is offered only if the model has it and the agent can say it.
  const modelHas = state.modelEfforts?.[`${binding.providerId}/${binding.model}`];
  // An agent with levels of its own offers those the model has too; one without offers whatever the model has.
  const can = { ...can0, efforts: can0.anyEffort ? (modelHas ?? []) : (can0.efforts ?? []).filter(l => !modelHas || modelHas.includes(l)) };
  if (!can.efforts.length && !can.tiers?.length) {
    return `<div class="row settings" style="padding-top:0"><span class="grow"></span><span class="hint">${esc(binding.model)} 没有可调的思考档位</span></div>`;
  }
  const tierBtn = t => {
    const name = binding.tiers?.[t.id];
    const slash = name ? name.indexOf("/") : -1;
    const provider = name && providerById(name.slice(0, slash));
    const face = provider
      ? `${icon(provider.icon)}<span class="label">${esc(name.slice(slash + 1))}<small>${esc(provider.name)}</small></span>`
      : `<span class="label">跟随主模型<small>点一下可以换</small></span>`;
    return `<span class="hint" title="${esc(t.hint)}">${esc(t.label)}</span><button class="popbtn" data-pick="${esc(id)}@${esc(t.id)}" title="${esc(t.hint)}">${face}<span class="caret">▾</span></button>`;
  };
  return `<div class="row settings" style="padding-top:0;gap:10px;flex-wrap:wrap">
    <span class="grow"></span>
    ${can.efforts?.length ? `<span class="hint">想得多深</span><select data-effort-select="${esc(id)}" title="只对这个 agent 生效；档位是它自己的">
      ${["", ...can.efforts].map(l => `<option value="${esc(l)}" ${(binding.effort ?? "") === l ? "selected" : ""}>${EFFORT_LABEL[l] ?? l}${l ? `（${esc(l)}）` : "（它自己的默认）"}</option>`).join("")}</select>` : ""}
    ${(can.tiers ?? []).map(tierBtn).join("")}
  </div>`;
}

function agentRow(harness) {
  const meta = agentMeta(harness);
  const binding = state.bindings?.[harness];
  const provider = binding && providerById(binding.providerId);
  const binary = harness === "codex" ? state.codexPath : state.claudePath;
  const sessions = sessionsOf(harness).length;
  const face = binding && provider
    ? `${icon(provider.icon)}<span class="label">${esc(binding.model)}<small>${esc(provider.name)}</small></span>`
    : `<span class="ic sm"></span><span class="label">原生<small>不经过 EasySwitch</small></span>`;
  const sub = !binary
    ? `没有找到 ${meta.name} 的命令`
    : binding ? `平时打开：原生 · 增强会话：${esc(binding.providerId)}/${esc(binding.model)}${harness === "claude" && state.claudeLogin ? " · /model 里 Claude 原生模型也都在" : ""}`
    : harness === "claude" && state.claudeLogin ? "增强会话保留你自己的 Claude 登录：/model 里 Claude 原生模型和你加的模型一起出现"
    : "平时打开：原生 · 选一个模型就能开增强会话";
  return `
    <div class="row" data-harness="${harness}">
      ${icon(meta.icon, "lg")}
      <div class="grow">
        <div class="title">${meta.name}${sessions ? `<button class="chip accent" data-go="sessions">${sessions} 个增强会话运行中</button>` : ""}</div>
        <div class="sub">${sub}</div>
      </div>
      <button class="popbtn" data-pick="${harness}" title="增强会话用哪个模型">${face}<span class="caret">▾</span></button>
      <button class="btn launch" data-launch="${harness}" ${(binding || (harness === "claude" && state.claudeLogin)) && binary ? "" : "disabled"}>启动增强会话</button>
    </div>${agentSettings(harness)}`;
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
    <div class="card" style="margin-top:12px"><div class="row">
      ${icon("openai", "lg")}
      <div class="grow"><div class="title">ChatGPT 桌面端</div><div class="sub">每次启动单独指向 EasySwitch，不改 ~/.codex；退回只要普通地重新打开</div></div>
      ${chip}
      ${c.enhanced ? `<button class="btn secondary" data-chatgpt-ask="native">退回普通启动</button>` : `<button class="btn" data-chatgpt-ask="enhance">用 EasySwitch 启动</button>`}
    </div>${notice}</div>`;
}

/** The wider catalog under the two ready rows: what is installed here, then the rest. */
function agentCatalog() {
  if (!agentList) return "";
  const rest = agentList.filter(a => a.support !== "ready");
  const row = a => {
    const can = a.installed && a.can && !a.where?.endsWith(".app") ? a.can : null;
    const binding = state.bindings?.[a.id];
    const provider = binding && providerById(binding.providerId);
    const face = binding && provider
      ? `${icon(provider.icon)}<span class="label">${esc(binding.model)}<small>${esc(provider.name)}</small></span>`
      : `<span class="label">选个模型<small>用哪个模型来源</small></span>`;
    return `
    <div class="row">
      ${icon(a.icon, "lg")}
      <div class="grow"><div class="title">${esc(a.name)} <span class="hint">${esc(a.vendor)}</span></div><div class="sub">${esc(a.note)}${can && !can.verified ? " · <b>启动方式按官方文档写的，还没在真实程序上实测</b>" : ""}</div></div>
      ${SUPPORT_CHIP[a.support]}
      ${can ? `<button class="popbtn" data-pick="${esc(a.id)}">${face}<span class="caret">▾</span></button>` : ""}
      ${can?.interactive ? `<button class="btn" data-agent-launch="${esc(a.id)}" ${binding ? "" : "disabled"}>启动</button>` : ""}
      ${a.installed ? `<button class="btn secondary" data-agent-open="${esc(a.id)}">打开</button>` : `<span class="hint">未安装</span>`}
    </div>${can ? agentSettings(a.id) : ""}`;
  };
  const here = rest.filter(a => a.installed);
  const other = rest.filter(a => !a.installed);
  return `
    <div class="section-head"><h2>更多 Agent</h2><span class="aside">${agentList.length} 个；你这台 Mac 上装了 ${agentList.filter(a => a.installed).length} 个</span></div>
    <div class="card">${here.map(row).join("") || `<div class="empty">还没检测到其他 agent</div>`}</div>
    <details class="card" data-keep="agents-other" ${keepOpen("agents-other")} style="margin-top:12px"><summary class="row" style="cursor:pointer"><span class="grow title">还没安装的（${other.length}）</span></summary>${other.map(row).join("")}</details>
    <p class="hint">「接入中」的 agent 都支持按次启动时指向 EasySwitch，正在逐个接入；「只能打开」的是闭源或绑定登录的，没有可改的端点，EasySwitch 只负责检测和打开，不会改动它们的任何配置。</p>`;
}

const EFFORT_LABEL = { "": "默认", none: "不思考", minimal: "最少", low: "快", medium: "均衡", high: "深", xhigh: "更深", max: "最深", ultra: "极限" };
const taskForm = { agent: "", effort: "", task: "", model: "", cwd: "" };
const TASK_STATUS = { running: ["运行中", "ok"], done: ["完成", "ok"], failed: ["失败", "warn"], stopped: ["已停止", ""], timeout: ["超时", "warn"] };

function renderTasks() {
  const agents = (agentList ?? []).filter(a => a.installed && a.can?.headless && (!a.where?.endsWith(".app") || ["codex", "claude"].includes(a.id)));
  const models = (state.providers ?? []).flatMap(p => modelsOf(p).map(m => `${p.id}/${m}`));
  const list = taskList?.tasks ?? [];
  const nameOf = id => (agentList ?? []).find(a => a.id === id)?.name ?? id;
  const keep = (k, d = "") => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const chosen = agents.find(a => a.id === (taskForm.agent || keep("es.taskAgent"))) ?? agents[0];
  const levels = chosen?.can?.efforts ?? [];
  const effort = levels.includes(taskForm.effort) ? taskForm.effort : "";
  const form = agents.length ? `
    <form class="form card" data-task-form style="padding:16px 18px">
      <textarea name="task" rows="3" required style="font-size:15px" placeholder="想让谁做什么？比如：读一下 README，告诉我这个项目是做什么的">${esc(taskForm.task)}</textarea>
      <div class="controls" style="margin-top:10px;flex-wrap:wrap">
        ${agents.map(a => `<button type="button" class="btn ${a.id === chosen.id ? "" : "secondary"}" data-task-agent="${esc(a.id)}">${esc(a.name)}</button>`).join("")}
        <span class="grow"></span>
        <button class="btn" type="submit">派出去</button>
      </div>
      ${levels.length ? `<div class="controls" style="margin-top:8px;flex-wrap:wrap"><span class="hint">想得多深</span>
        ${["", ...levels].map(l => `<button type="button" class="btn ${l === effort ? "" : "secondary"}" data-task-effort="${esc(l)}" title="${l ? `${esc(chosen.name)} 的「${esc(l)}」档` : "不指定，用它自己的默认"}">${EFFORT_LABEL[l] ?? l}</button>`).join("")}</div>` : ""}
      <details data-keep="task-more" ${keepOpen("task-more")} style="margin-top:10px"><summary class="hint" style="cursor:pointer">更多选项（模型、工作目录）</summary>
        <div class="field"><label>用哪个模型</label><select name="model"><option value="">${state.bindings?.[chosen.id] ? "它自己的模型" : "自动选一个"}</option>${models.map(m => `<option value="${esc(m)}" ${m === taskForm.model ? "selected" : ""}>${esc(m)}</option>`).join("")}</select></div>
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
        <div class="sub">${t.from === "console" ? "你" : esc(nameOf(t.from))} → ${esc(nameOf(t.agent))} · ${esc(t.model)} · ${new Date(t.at).toLocaleTimeString()}${t.ms ? ` · ${(t.ms / 1000).toFixed(1)} 秒` : ""}</div></div>
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
    <p class="hint">任务里的 agent 按它们各自默认的只读权限运行：能读文件、搜索、思考，不会擅自改文件。</p>`;
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
    ${chatgptCard()}
    <p class="hint">点模型选择框挑一个外接模型，再点「启动增强会话」。会话里输入 <code>/model</code>，可以随时换成任何一个外接模型。选「原生」就是不用 EasySwitch；你平时直接打开的 ChatGPT和 Claude Code 永远不受影响。</p>
    ${state.providers.length ? "" : onboarding()}
    ${agentCatalog()}`;
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
        <span class="chip">ChatGPT：${ROUTE[p.route]}${p.routePinned ? "（手动）" : p.probe ? "（自动）" : ""}</span>
        <span class="chip">Claude Code：${ROUTE[p.messagesRoute ?? "chat-translate"]}</span>
        <button class="btn secondary" data-route="${nextRoute}">ChatGPT改为${ROUTE[nextRoute]}</button>
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
      ${billingBlock(p)}
      ${keyList(p)}
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
      <div class="field"><label>OpenAI 兼容地址</label><input type="text" name="baseUrl" required value="${esc(preset?.baseUrl ?? "")}" placeholder="https://relay.example.com/v1"></div>
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
      ${icon("openai", "lg")}
      <div class="grow"><div class="title">${esc(a.label)}${a.email && a.email !== a.label ? ` <span class="hint">${esc(a.email)}</span>` : ""}</div>
        <div class="sub">${a.needsSignIn ? "登录失效了，需要重新登录" : !a.planUsage ? "已登录，但还没有允许使用订阅额度" : "已接入：它的模型出现在下面的来源里，所有 agent 都能选"}</div></div>
      ${a.needsSignIn || !a.planUsage ? `<span class="chip warn">${a.needsSignIn ? "需要重新登录" : "未授权额度"}</span>` : `<span class="chip ok"><span class="dot"></span>可用</span>`}
      <button class="btn secondary" data-plan-signin-again="${esc(a.id)}" data-plan-kind="${esc(a.kind ?? "open")}">${a.needsSignIn || !a.planUsage ? "重新登录" : "重新登录一次"}</button>
      ${a.planUsage && !a.needsSignIn ? `<button class="btn secondary" data-plan-models="${esc(a.id)}">刷新模型</button>` : ""}
      <button class="btn secondary" data-plan-signout="${esc(a.id)}">${planConfirmOut === a.id ? "再点一次退出登录" : "退出登录"}</button>
    </div>`;
  return `
    <div class="section-head"><h2>用你的订阅</h2><span class="aside">登录只在这台电脑上，令牌存在钥匙串里</span></div>
    <div class="card">
      ${accounts.map(row).join("")}
      ${si?.status === "waiting" ? `<div class="row"><div class="grow"><div class="title">${si.userCode ? `在浏览器打开的页面里输入这个码：<span class="mono" style="font-size:20px;letter-spacing:2px">${esc(si.userCode)}</span>` : "已在浏览器里打开登录页"}</div><div class="sub">登录并确认后会自动完成，不用回到这里点什么。没有自动打开的话，<a href="${esc(si.url)}" target="_blank" rel="noopener">点这里打开</a>。</div></div><button class="btn secondary" data-plan-cancel>取消</button></div>` : ""}
      ${si?.status === "error" ? `<div class="row"><div class="grow"><div class="title">没有登录成功</div><div class="sub">${esc(si.message ?? "")}</div></div></div>` : ""}
      ${si?.status === "done" && si.message ? `<div class="row"><div class="grow"><div class="sub">${esc(si.message)}</div></div></div>` : ""}
      <button class="add-row" data-plan-signin>${icon("openai", "sm")} Continue with ChatGPT</button>
    </div>
    <p class="hint">这里用 Codex 的登录身份一步完成（Hermes、opencodex 也是这样做的；这不是 OpenAI 给第三方工具的官方登记方式，所以 OpenAI 以后可能调整）。额度和你的 ChatGPT 订阅共用，登录只在这台电脑上，令牌存在钥匙串里。Claude 的订阅不在这里用。</p>`;
}

function renderProviders() {
  return `
    ${planCard()}
    <div class="section-head"><h2>模型来源</h2><span class="aside">中转站、官方 API、本地模型都可以；加进来先自动测一遍</span></div>
    <div class="card">
      ${state.providers.map(providerRow).join("") || `<div class="empty">还没有模型来源</div>`}
      ${ocxImport ? renderOcxImport() : ""}
      ${addForm ? renderAddForm() : `<button class="add-row" data-add>＋ 添加模型来源</button><button class="add-row" data-ocx-open>从 opencodex 导入</button>`}
    </div>`;
}

async function submitAdd(form) {
  const data = Object.fromEntries(new FormData(form));
  // Placeholder values travel as their own object; the preset (not the page) decides the wire details.
  data.urlParams = Object.fromEntries(Object.entries(data).filter(([k]) => k.startsWith("param:")).map(([k, v]) => [k.slice(6), v]));
  for (const k of Object.keys(data)) if (k.startsWith("param:")) delete data[k];
  if (addForm.preset) data.presetId = addForm.preset.id;
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
  if (page === "sessions") requestAnimationFrame(drawFlowLines);
  if (page === "usage") requestAnimationFrame(drawChart);
}

/** Re-render unless the user is in the middle of something we would wipe out. */
function busy() {
  return popover || addForm || ocxImport || importFormOpen || document.activeElement?.matches("input, select, textarea");
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
  if (page === "providers") planInfo = await call("GET", "/api/plan").catch(() => planInfo);
  if (page === "agents" && !PANEL) chatgptInfo = await call("GET", "/api/chatgpt").catch(() => chatgptInfo);
  if (page === "tasks") {
    taskList = await call("GET", "/api/tasks").catch(() => taskList);
    if (!agentList) agentList = await call("GET", "/api/agents").then(r => r.agents).catch(() => null);
  }
  if (page === "agents" && !PANEL && !agentList) {
    agentList = await call("GET", "/api/agents").then(r => r.agents).catch(() => null);
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

  const agentLaunch = t.closest("[data-agent-launch]");
  if (agentLaunch) {
    try { const r = await call("POST", `/api/agents/${agentLaunch.dataset.agentLaunch}/launch`, {}); toast(`已在终端里启动（${r.model}）`); } catch (error) { toast(error.message); }
    return;
  }
  const pickAgent = t.closest("[data-task-agent]");
  if (pickAgent) { syncTaskForm(); taskForm.agent = pickAgent.dataset.taskAgent; taskForm.effort = ""; try { localStorage.setItem("es.taskAgent", taskForm.agent); } catch {} render(); return; }
  const pickEffort = t.closest("[data-task-effort]");
  if (pickEffort) { syncTaskForm(); taskForm.effort = pickEffort.dataset.taskEffort; render(); return; }
  const taskToggle = t.closest("[data-task-toggle]");
  if (taskToggle) { const id = taskToggle.dataset.taskToggle; if (taskOpenIds.has(id)) taskOpenIds.delete(id); else taskOpenIds.add(id); render(); return; }
  const taskStop = t.closest("[data-task-stop]");
  if (taskStop) { await call("POST", `/api/tasks/${taskStop.dataset.taskStop}/stop`).catch(() => {}); await refresh(true); return; }
  if (t.closest("[data-task-clear]")) { await call("DELETE", "/api/tasks").catch(() => {}); await refresh(true); return; }

  if (t.closest("[data-plan-signin]") || t.closest("[data-plan-signin-again]")) {
    const againBtn = t.closest("[data-plan-signin-again]");
    // A Codex-identity account just signs in again the same way; one made with OpenAI's own route signs in again with its own client.
    const again = againBtn && againBtn.dataset.planKind !== "codex" ? againBtn.dataset.planSigninAgain : undefined;
    try { await call("POST", "/api/plan/signin", again ? { accountId: again, mode: "open" } : {}); } catch (error) { toast(error.message); }
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
  const planOut = t.closest("[data-plan-signout]");
  if (planOut) {
    const id = planOut.dataset.planSignout;
    if (planConfirmOut !== id) { planConfirmOut = id; render(); return; }
    planConfirmOut = null;
    try { await call("DELETE", `/api/plan/${id}`); toast("已退出登录，并在 OpenAI 那边撤销了这次登录"); } catch (error) { toast(error.message); }
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

document.addEventListener("change", async e => {
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
  if (e.target.id === "add-form") { e.preventDefault(); submitAdd(e.target); return; }
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
  const runForm = e.target.closest("form[data-task-form]");
  if (runForm) {
    e.preventDefault();
    const f = new FormData(runForm);
    taskNote = "";
    try {
      const agent = taskForm.agent || (() => { try { return localStorage.getItem("es.taskAgent"); } catch { return null; } })() || runForm.querySelector("[data-task-agent]")?.dataset.taskAgent;
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
document.addEventListener("keydown", e => { if (e.key === "Escape") closePopover(); });
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
