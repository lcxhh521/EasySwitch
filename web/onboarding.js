// First-run state stays in this page only. Keys never enter saved wizard state or copied commands.
"use strict";
const firstRun = { active: null, step: 1, presetId: "", providerId: "", model: "", agent: "", busy: false, message: "", tested: false, subscription: false, done: false };
function firstRunVisible() {
  if (PANEL || !state) return false;
  if (firstRun.active === null) firstRun.active = state.providers.length === 0;
  return firstRun.active;
}
function firstRunPresets() {
  return presets.filter(p => !p.unavailable && !p.vertexMode && !p.urlParams?.length && p.id !== "mimo-free");
}
function firstRunAgents() {
  const uses = new Map();
  for (const entry of state?.log ?? []) if (entry.harness) uses.set(entry.harness, (uses.get(entry.harness) ?? 0) + 1);
  return (agentList ?? []).filter(a => a.installed && a.can?.interactive && /^[a-z0-9-]+$/.test(a.id))
    .sort((a, b) => (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0));
}
function firstRunSync() {
  if (!firstRunVisible()) return;
  if (firstRun.subscription && !firstRun.providerId) {
    const p = state.providers.find(p => !p.off && modelsOf(p).length);
    if (p) { firstRun.providerId = p.id; firstRun.model = p.defaultModel || modelsOf(p)[0]; firstRun.step = 2; firstRun.tested = false; firstRun.message = "订阅已就绪；登录不代表推理已经通过测试，实际使用会消耗你的套餐额度。"; }
  }
  const provider = state.providers.find(p => p.id === firstRun.providerId);
  if (provider && !firstRun.model) firstRun.model = provider.defaultModel || modelsOf(provider)[0] || "";
  const agents = firstRunAgents();
  if (!agents.some(a => a.id === firstRun.agent)) firstRun.agent = firstRun.step < 3 ? agents[0]?.id ?? "" : "";
}
function firstRunError(error, context) {
  if (globalThis.EasySwitchErrors) {
    const e = globalThis.EasySwitchErrors.humanError(error, { context });
    return `${e.title}：${e.reason} ${e.action.label}`;
  }
  return context === "launch" ? "启动没有完成：程序可能未安装或暂时不可用；请检查 Agent 页面后重试。"
    : "来源没有连通：请在模型来源里检查地址、密钥和模型，修正后再检测。";
}
function firstRunCard() {
  firstRunSync();
  if (!firstRunVisible()) return "";
  const p = state.providers.find(p => p.id === firstRun.providerId);
  const choices = firstRunPresets();
  if (!choices.some(p => p.id === firstRun.presetId)) firstRun.presetId = choices[0]?.id ?? "";
  const preset = choices.find(p => p.id === firstRun.presetId);
  const agents = firstRunAgents();
  const disabled = firstRun.busy ? "disabled" : "";
  let content = "";
  if (firstRun.done) content = `<h3>准备好了</h3><p>你选择的模型已保存在这个 agent 的增强设置里；平时直接打开它仍使用原来的设置。</p><button class="btn" data-first-action="finish">进入控制台</button>`;
  else if (firstRun.step === 1) {
    content = p ? `<p>已保存来源：${esc(p.name)}。${firstRun.tested ? "检测已通过。" : "尚未通过推理检测；重试不会重复添加来源。"}</p>
      <div class="controls"><button class="btn" data-first-action="probe" ${disabled}>${firstRun.busy ? "正在检测…" : "重新检测"}</button><button class="btn secondary" data-first-action="providers" ${disabled}>检查来源设置</button>${firstRun.tested ? `<button class="btn" data-first-action="next" ${disabled}>选 Agent</button>` : ""}</div>`
      : `<form data-first-source class="form"><div class="field"><label>选择你已经购买或准备好的来源</label><select name="presetId" data-first-preset ${disabled}>${choices.map(x => `<option value="${esc(x.id)}" ${x.id === firstRun.presetId ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></div>
        ${preset?.id === "relay" ? `<div class="field"><label>来源地址</label><input name="baseUrl" type="url" required placeholder="https://你的来源地址/v1" ${disabled}></div>` : ""}
        <div class="field"><label>粘贴这个来源的 Key${preset?.category === "本地" ? "（本地模型可留空）" : ""}</label><input name="apiKey" type="password" autocomplete="off" spellcheck="false" ${preset?.category !== "本地" ? "required" : ""} ${disabled}></div>
        <p class="hint">${esc(preset?.note ?? "只使用你自己的来源和密钥。")}</p><p class="hint">下一步会保存来源并发出少量模型请求进行检测，可能产生费用；不会替你购买、登录或修改预算。需要项目/区域等设置的来源请用完整添加页。</p>
        <div class="controls"><button class="btn" type="submit" ${disabled || !preset ? "disabled" : ""}>${firstRun.busy ? "正在添加并检测…" : "添加并检测"}</button><button class="btn secondary" type="button" data-first-action="subscription" ${disabled}>用我的订阅</button><button class="btn secondary" type="button" data-first-action="providers" ${disabled}>完整添加页</button></div></form>`;
  } else if (firstRun.step === 2) {
    content = `<p>来源：${esc(p?.name ?? "已移除")} ${firstRun.tested ? "· 检测已通过" : "· 尚未验证真实推理"}</p>`;
    if (!agents.length) content += `<p class="msg bad">还没有可启动的 Agent：这台电脑尚未检测到支持增强会话的程序，请先安装一个，再点重新检测。</p><div class="controls"><button class="btn secondary" data-first-action="detect" ${disabled}>重新检测已安装程序</button><button class="btn secondary" data-first-action="agents" ${disabled}>查看 Agent 列表</button></div>`;
    else content += `<form data-first-agent class="form"><div class="field"><label>选择已安装的 Agent</label><select name="agent" ${disabled}>${agents.map(a => `<option value="${esc(a.id)}" ${firstRun.agent === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></div><div class="field"><label>增强会话的默认模型</label><select name="model" ${disabled}>${modelsOf(p).map(m => `<option value="${esc(m)}" ${firstRun.model === m ? "selected" : ""}>${esc(m)}</option>`).join("")}</select></div><p class="hint">默认选择最近使用最多的已安装程序；没有使用记录时选检测列表中的第一个。部分启动方式尚待真实程序验收。</p><button class="btn" type="submit" ${disabled}>下一步</button></form>`;
  } else {
    const a = agents.find(a => a.id === firstRun.agent);
    content = `<p>${esc(a?.name ?? "Agent 已不可用")} 将使用 ${esc(p?.name ?? "")} / ${esc(firstRun.model)}。</p><p class="hint">点击启动后会打开独立增强会话；不修改你平时的配置。也可以复制命令，在自己的终端运行。</p><div class="controls"><button class="btn" data-first-action="launch" ${disabled || !a ? "disabled" : ""}>${firstRun.busy ? "正在启动…" : "启动增强会话"}</button><button class="btn secondary" data-first-action="copy" ${disabled || !a ? "disabled" : ""}>复制 es 命令</button><button class="btn secondary" data-first-action="back" ${disabled}>上一步</button></div><p><code>${esc(`es ${firstRun.agent}`)}</code></p>`;
  }
  return `<section class="card" id="first-run" style="padding:20px"><div class="section-head"><h2>第一次使用，三步准备好</h2><button class="btn secondary" data-first-action="dismiss" ${disabled}>暂时跳过</button></div><ol class="steps"><li${firstRun.step === 1 ? ' aria-current="step"' : ""}>添加来源</li><li${firstRun.step === 2 ? ' aria-current="step"' : ""}>选择 Agent</li><li${firstRun.step === 3 ? ' aria-current="step"' : ""}>启动或复制命令</li></ol>${content}${firstRun.message ? `<p class="msg" role="status">${esc(firstRun.message)}</p>` : ""}</section>`;
}
async function firstRunProbe() {
  const result = await call("POST", `/api/providers/${encodeURIComponent(firstRun.providerId)}/probe`, { model: firstRun.model });
  if (!result.probe?.checks?.some(c => ["chat", "responses", "messages"].includes(c.id) && c.status === "pass")) throw { code: "provider_unavailable" };
  firstRun.tested = true; firstRun.step = 2; firstRun.message = "来源检测通过，接下来选择已安装的 Agent。";
}
document.addEventListener("change", event => {
  if (!event.target.matches?.("[data-first-preset]") || firstRun.busy) return;
  firstRun.presetId = event.target.value; firstRun.message = ""; render();
});
document.addEventListener("submit", async event => {
  const source = event.target.matches?.("[data-first-source]");
  const agent = event.target.matches?.("[data-first-agent]");
  if (!source && !agent) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (firstRun.busy) return;
  const fields = new FormData(event.target);
  if (source && firstRun.providerId) return;
  firstRun.busy = true; firstRun.message = "";
  try {
    if (source) {
      const preset = firstRunPresets().find(p => p.id === fields.get("presetId"));
      if (!preset) throw new Error("missing preset");
      const key = String(fields.get("apiKey") ?? "").trim();
      if (!key && preset.category !== "本地") throw { code: "key_rejected" };
      const baseUrl = preset.id === "relay" ? String(fields.get("baseUrl") ?? "").trim() : preset.baseUrl;
      // The key stays in this stack frame and the existing credential API only.
      const input = { name: preset.name, baseUrl, apiKey: key, presetId: preset.id, ...(preset.anthropicBaseUrl ? { anthropicBaseUrl: preset.anthropicBaseUrl } : {}) };
      event.target.reset?.(); render();
      const created = await call("POST", "/api/providers", input);
      firstRun.providerId = created.id;
      firstRun.model = modelsOf(created).includes(preset.defaultModel) ? preset.defaultModel : modelsOf(created)[0] || preset.defaultModel || "";
      if (!firstRun.model) { firstRun.message = "来源已保存，但没有读到可用模型；请打开来源设置检查密钥和模型，再回来继续。"; }
      else await firstRunProbe();
    } else {
      const id = String(fields.get("agent") ?? ""), model = String(fields.get("model") ?? "");
      const p = state.providers.find(p => p.id === firstRun.providerId);
      if (!firstRunAgents().some(a => a.id === id) || !p || p.off || !modelsOf(p).includes(model)) throw new Error("selection unavailable");
      await call("PUT", `/api/bindings/${encodeURIComponent(id)}`, { providerId: p.id, model });
      firstRun.agent = id; firstRun.model = model; firstRun.step = 3;
    }
  } catch (error) { firstRun.message = firstRunError(error, source ? "provider" : "launch"); }
  finally { firstRun.busy = false; await refresh(true); }
});
document.addEventListener("click", async event => {
  const button = event.target.closest?.("[data-first-action]"); if (!button) return;
  event.preventDefault(); event.stopImmediatePropagation(); if (firstRun.busy || button.disabled) return;
  const action = button.dataset.firstAction;
  if (["dismiss", "finish"].includes(action)) { firstRun.active = false; render(); return; }
  if (["providers", "subscription", "agents"].includes(action)) {
    if (action === "subscription") { firstRun.subscription = true; firstRun.message = "请在订阅页面主动选择登录方式；新订阅默认关闭，需要你明确打开后才能继续。"; }
    pageNavigationVersion++;
    page = action === "agents" ? "agents" : "providers"; if (action === "agents") firstRun.active = false;
    history.replaceState(null, "", `#${page}`); await refresh(true); return;
  }
  if (action === "resume") { pageNavigationVersion++; page = "agents"; history.replaceState(null, "", "#agents"); render(); return; }
  if (action === "back") { firstRun.step = 2; firstRun.message = ""; render(); return; }
  if (action === "next") { firstRun.step = 2; render(); return; }
  firstRun.busy = true; firstRun.message = ""; render();
  try {
    if (action === "probe") await firstRunProbe();
    if (action === "detect") agentList = await loadAgents();
    if (action === "launch") {
      if (!firstRunAgents().some(a => a.id === firstRun.agent)) throw new Error("agent unavailable");
      await call("POST", `/api/agents/${encodeURIComponent(firstRun.agent)}/launch`, { model: `${firstRun.providerId}/${firstRun.model}` });
      firstRun.done = true; firstRun.message = "启动请求已完成，请在新打开的窗口继续。";
    }
    if (action === "copy") { await navigator.clipboard.writeText(`es ${firstRun.agent}`); firstRun.message = "已复制；在终端粘贴运行即可。"; }
  } catch (error) { firstRun.message = action === "copy" ? "没有复制成功：请选中上面的命令，手动复制到终端。" : firstRunError(error, action === "launch" ? "launch" : "provider"); }
  finally { firstRun.busy = false; await refresh(true); }
});
