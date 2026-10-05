// EasySwitch console. Plain JS, no build step; talks only to the local core.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let state = null;

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

const ROUTE_LABEL = { "responses-native": "原样转发", "anthropic-native": "原样转发", "chat-translate": "协议转换" };

function renderChips() {
  const native = state.native.filter(f => f.exists);
  const clean = native.every(f => !f.mentionsEasySwitch);
  $("chips").innerHTML = [
    `<span class="chip ok">核心服务正常 · 端口 ${state.port}</span>`,
    `<span class="chip ${clean ? "ok" : "bad"}">${clean ? "原生配置未被改动" : "原生配置出现了 EasySwitch 痕迹"}</span>`,
    `<span class="chip ${state.sessions.length ? "warn" : ""}">增强会话 ${state.sessions.length} 个运行中</span>`,
  ].join("");
  $("ver").textContent = `v${state.version}`;
}

function renderProviders() {
  if (!state.providers.length) {
    $("providers").innerHTML = `<p class="hint">还没有模型来源。在下面填一个中转站试试。</p>`;
    return;
  }
  $("providers").innerHTML = state.providers.map(p => {
    const models = p.models.length ? p.models : p.defaultModel ? [p.defaultModel] : [];
    const options = models.map(m => `<option ${m === p.defaultModel ? "selected" : ""}>${esc(m)}</option>`).join("");
    const checks = (p.probe?.checks ?? []).map(c => `
      <div class="check ${c.status}"><b>${c.status === "pass" ? "✓" : "✗"} ${esc(c.label)}</b>
      ${esc(c.detail)}${c.latencyMs != null ? ` · ${c.latencyMs}ms` : ""}</div>`).join("");
    return `
      <div class="prov" data-id="${esc(p.id)}">
        <div class="prov-head">
          <div><div class="prov-name">${esc(p.name)} <span class="mono">(${esc(p.id)})</span></div>
          <div class="prov-url">${esc(p.baseUrl)}</div></div>
          <div class="badges">
            <span class="chip ${p.hasKey ? "ok" : "warn"}">${p.hasKey ? "Key 已存入钥匙串" : "未设置 Key"}</span>
            <span class="chip">${models.length} 个模型</span>
            <span class="chip">Codex：${ROUTE_LABEL[p.route]}${p.routePinned ? "（手动）" : p.probe ? "（自动）" : ""}</span>
            <span class="chip">Claude Code：${ROUTE_LABEL[p.messagesRoute ?? "chat-translate"]}</span>
          </div>
        </div>
        <div class="row">
          <label>测试用模型 <select class="probe-model">${options || "<option value=''>（没有可选模型）</option>"}</select></label>
          <button class="probe">一致性测试</button>
          <button class="secondary route" data-route="${p.route === "chat-translate" ? "responses-native" : "chat-translate"}">Codex 改为${ROUTE_LABEL[p.route === "chat-translate" ? "responses-native" : "chat-translate"]}</button>
          ${p.routePinned ? `<button class="secondary route" data-route="auto">恢复自动</button>` : ""}
          <button class="danger remove">删除</button>
        </div>
        ${checks ? `<div class="checks">${checks}</div>` : ""}
      </div>`;
  }).join("");
}

const HARNESS_LABEL = { codex: "Codex", claude: "Claude Code" };

function modelsOf(provider) {
  if (!provider) return [];
  return provider.models.length ? provider.models : provider.defaultModel ? [provider.defaultModel] : [];
}

function renderBindings() {
  for (const card of document.querySelectorAll(".harness")) {
    const harness = card.dataset.harness;
    const current = state.bindings?.[harness];
    const sel = card.querySelector(".bind-provider");
    const chosen = sel.value || current?.providerId || state.providers[0]?.id || "";
    sel.innerHTML = state.providers.map(p => `<option value="${esc(p.id)}" ${p.id === chosen ? "selected" : ""}>${esc(p.name)}</option>`).join("");
    const provider = state.providers.find(p => p.id === chosen);
    const models = modelsOf(provider);
    const modelSel = card.querySelector(".bind-model");
    const chosenModel = modelSel.dataset.provider === chosen && modelSel.value ? modelSel.value
      : current?.providerId === chosen ? current.model : provider?.defaultModel ?? models[0];
    modelSel.dataset.provider = chosen;
    modelSel.innerHTML = models.map(m => `<option ${m === chosenModel ? "selected" : ""}>${esc(m)}</option>`).join("");
    const binary = harness === "codex" ? state.codexPath : state.claudePath;
    card.querySelector(".launch").disabled = !current || !binary;
    if (!binary) card.querySelector(".bind-msg").textContent = `没有找到 ${HARNESS_LABEL[harness]} 的命令。`;
  }
}

function renderNative() {
  $("native").innerHTML = `<tr><th>应用</th><th>文件</th><th>指纹</th><th>修改时间</th><th>EasySwitch 痕迹</th></tr>` +
    state.native.map(f => `<tr><td>${esc(f.harness)}</td><td class="mono">${esc(f.path)}</td>
      <td class="mono">${f.exists ? esc(f.sha256.slice(0, 12)) : "不存在"}</td>
      <td>${f.modifiedAt ? new Date(f.modifiedAt).toLocaleString() : "—"}</td>
      <td class="${f.mentionsEasySwitch ? "bad-text" : "ok-text"}">${f.mentionsEasySwitch ? "有" : "无"}</td></tr>`).join("");
}

function renderLog() {
  $("log").innerHTML = `<tr><th>时间</th><th>应用</th><th>模型</th><th>线路</th><th>状态</th><th>耗时</th><th>备注</th></tr>` +
    (state.log.length ? state.log.map(e => `<tr><td>${new Date(e.at).toLocaleTimeString()}</td><td>${esc(HARNESS_LABEL[e.harness ?? "codex"])}</td><td class="mono">${esc(e.model)}</td>
      <td>${ROUTE_LABEL[e.route]}</td><td class="${e.status < 400 ? "ok-text" : "bad-text"}">${e.status}</td><td>${e.ms}ms</td><td>${esc(e.note ?? "")}</td></tr>`).join("")
      : `<tr><td colspan="7" class="hint">还没有请求。</td></tr>`);
}

async function refresh({ full = false } = {}) {
  try {
    state = await call("GET", "/api/state");
  } catch (error) {
    $("chips").innerHTML = `<span class="chip bad">连不上核心服务：${esc(error.message)}</span>`;
    return;
  }
  renderChips();
  renderNative();
  renderLog();
  if (full) {
    renderProviders();
    renderBindings();
    showCommands();
  }
}

async function showCommands() {
  for (const card of document.querySelectorAll(".harness")) {
    const harness = card.dataset.harness;
    const cmd = card.querySelector(".cmd");
    if (!state.bindings?.[harness]) { cmd.textContent = ""; continue; }
    try {
      const { command } = await call("GET", `/api/launch/${harness}`);
      cmd.textContent = command;
    } catch { cmd.textContent = ""; }
  }
}

$("add-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = new FormData(event.target);
  $("add-msg").className = "msg";
  $("add-msg").textContent = "正在添加并读取模型列表…";
  try {
    const p = await call("POST", "/api/providers", Object.fromEntries(form));
    event.target.reset();
    $("add-msg").textContent = `已添加「${p.name}」，读到 ${p.models.length} 个模型。选一个模型做一致性测试吧。`;
    await refresh({ full: true });
  } catch (error) {
    $("add-msg").className = "msg bad";
    $("add-msg").textContent = error.message;
  }
});

$("providers").addEventListener("click", async event => {
  const button = event.target.closest("button");
  const card = event.target.closest(".prov");
  if (!button || !card) return;
  const id = card.dataset.id;
  button.disabled = true;
  try {
    if (button.classList.contains("probe")) {
      button.textContent = "测试中…";
      await call("POST", `/api/providers/${id}/probe`, { model: card.querySelector(".probe-model").value });
    } else if (button.classList.contains("route")) {
      const route = button.dataset.route;
      await call("POST", `/api/providers/${id}/route`, { route: route === "auto" ? null : route });
    } else if (button.classList.contains("remove")) {
      if (!window.confirm("删除这个模型来源？钥匙串里的 Key 也会一起删除。")) { button.disabled = false; return; }
      await call("DELETE", `/api/providers/${id}`);
    }
  } catch (error) {
    window.alert(error.message);
  }
  await refresh({ full: true });
});

document.addEventListener("change", event => {
  if (event.target.closest(".bind-provider")) renderBindings();
});

document.addEventListener("click", async event => {
  const button = event.target.closest(".harness button");
  if (!button) return;
  const card = button.closest(".harness");
  const harness = card.dataset.harness;
  const msg = card.querySelector(".bind-msg");
  msg.className = "msg bind-msg";
  try {
    if (button.classList.contains("bind-save")) {
      await call("PUT", `/api/bindings/${harness}`, {
        providerId: card.querySelector(".bind-provider").value,
        model: card.querySelector(".bind-model").value,
      });
      msg.textContent = "已保存。";
      await refresh({ full: true });
    } else if (button.classList.contains("launch")) {
      const { model } = await call("POST", `/api/launch/${harness}`);
      msg.textContent = `已在终端里打开 ${HARNESS_LABEL[harness]} 增强会话（${model}）。`;
      await refresh();
    }
  } catch (error) {
    msg.className = "msg bind-msg bad";
    msg.textContent = error.message;
  }
});

refresh({ full: true });
setInterval(() => refresh(), 3000);
