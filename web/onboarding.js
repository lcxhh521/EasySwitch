// Live state stays in this page. Same-tab drafts are unverified hints, never account identity or authority.
// Keys never enter draft storage or copied commands.
"use strict";
const firstRun = { active: null, suspended: false, step: 1, presetId: "", providerId: "", model: "", agent: "", busy: false, message: "", tested: false, subscription: false, done: false, saved: false, errorAction: null, errorCode: "", launchUncertain: false, draft: null };
function firstRunVisible() {
  if (PANEL || !state) return false;
  if (firstRun.active === null) {
    firstRun.draft = globalThis.EasySwitchFirstRunDraft?.read() ?? null;
    firstRun.active = !!firstRun.draft || state.providers.length === 0;
  }
  return firstRun.active && !firstRun.suspended;
}
function firstRunSaveDraft(phase) {
  const storage = globalThis.EasySwitchFirstRunDraft;
  if (!storage) return;
  if (!firstRun.active || firstRun.done) { storage.clear(); return; }
  const selection = firstRun.draft || firstRun;
  // While replacing a removed source, retain the old hint and its original TTL
  // rather than erase an unresolved launch or invent a new source identity.
  if (firstRun.launchUncertain && !selection.providerId) return;
  const saved = storage.write({ providerId: selection.providerId, model: selection.model, agent: selection.agent,
    phase: firstRun.launchUncertain ? "launch-uncertain" : phase || firstRun.draft?.phase || (firstRun.step > 1 ? "select" : "source") });
  if (saved && firstRun.draft) firstRun.draft = storage.read() || firstRun.draft;
}
function firstRunResumeCard() {
  firstRunVisible();
  if (PANEL || !state || !firstRun.active || firstRun.done || (page === "agents" && !firstRun.suspended)) return "";
  return `<div class="card" style="padding:16px">已保留首次设置的选择。<button class="btn secondary" data-first-action="resume" ${firstRun.busy ? "disabled" : ""}>继续首次设置</button></div>`;
}
function firstRunPresets() {
  return presets.filter(p => !p.unavailable && !p.vertexMode && !p.urlParams?.length && p.id !== "mimo-free");
}
function firstRunAgents() {
  const uses = new Map();
  for (const entry of state?.log ?? []) if (entry.harness) uses.set(entry.harness, (uses.get(entry.harness) ?? 0) + 1);
  return (agentList ?? []).filter(a => clientFound(a) && a.can?.interactive && /^[a-z0-9-]+$/.test(a.id))
    .sort((a, b) => (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0));
}
function firstRunSync() {
  if (!firstRunVisible() || firstRun.draft) return;
  if (firstRun.subscription && !firstRun.providerId) {
    const p = state.providers.find(p => !p.off && modelsOf(p).length);
    if (p) { firstRun.providerId = p.id; firstRun.model = p.defaultModel || modelsOf(p)[0]; firstRun.step = 2; firstRun.tested = false; firstRun.message = "订阅已就绪；登录不代表推理已经通过测试，实际使用会消耗你的套餐额度。"; }
  }
  const provider = state.providers.find(p => p.id === firstRun.providerId);
  if (provider && !firstRun.model) firstRun.model = provider.defaultModel || modelsOf(provider)[0] || "";
  // A previous choice stays explicit when it disappears. Never silently launch a replacement.
  if (!firstRun.agent && firstRun.step < 3) firstRun.agent = firstRunAgents()[0]?.id ?? "";
}
function firstRunSelection() { return { providerId: firstRun.providerId, model: firstRun.model, agent: firstRun.agent }; }
function firstRunSelectionIssue(selection = firstRunSelection()) {
  const p = state.providers.find(p => p.id === selection.providerId);
  if (!p) return "model_unavailable";
  if (p.off) return "source_disabled";
  if (p.budgetStatus?.blocked) return "budget_blocked";
  if (p.cliTextBridge?.kind === "droid" || !modelsOf(p).includes(selection.model) || !selectableModelNames().includes(`${p.id}/${selection.model}`)) return "model_unavailable";
  if (!firstRunAgents().some(a => a.id === selection.agent)) return "client_not_installed";
  return "";
}
function firstRunErrorInfo(error, context) {
  if (globalThis.EasySwitchErrors) return globalThis.EasySwitchErrors.humanError(error, { context });
  return { code: "unknown_error", title: context === "launch" ? "启动没有完成" : "来源没有连通",
    reason: context === "launch" ? "程序可能未安装或暂时不可用，请检查后重试。" : "请在模型来源里检查地址、密钥和模型，修正后再检测。",
    action: { label: context === "launch" ? "查看已安装程序" : "检查来源设置", target: context === "launch" ? "agents" : "providers" } };
}
function firstRunSetError(error, context) {
  const info = firstRunErrorInfo(error, context);
  firstRun.errorAction = info.action; firstRun.errorCode = info.code;
  firstRun.message = `${firstRun.saved ? "设置已保存。" : ""}${info.title}：${info.reason}`;
  return info;
}
function firstRunCommand(selection = firstRunSelection()) {
  // POSIX terminal command; never fetch a signed /command capability or rely on a mutable binding.
  return `es ${selection.agent} --model '${`${selection.providerId}/${selection.model}`.replace(/'/g, "'\\''")}'`;
}
function firstRunStillHere(navigation) {
  return firstRun.active && !firstRun.suspended && page === "agents" && pageNavigationVersion === navigation;
}
async function firstRunLaunch(selection) {
  if (firstRun.draft) throw { code: "invalid_input" };
  const issue = firstRunSelectionIssue(selection);
  if (issue) throw { code: issue };
  // Write before dispatch: an interrupted response is not proof the launch failed.
  firstRunSaveDraft("launch-uncertain");
  try {
    await call("POST", `/api/agents/${encodeURIComponent(selection.agent)}/launch`, { model: `${selection.providerId}/${selection.model}` });
  } catch (error) {
    const info = firstRunErrorInfo(error, "launch");
    if (["unknown_error", "request_timeout", "service_unavailable"].includes(info.code)) firstRun.launchUncertain = true;
    throw error;
  }
  firstRun.done = true; firstRun.launchUncertain = false; firstRun.message = "启动请求已完成，请在新打开的窗口继续。";
  globalThis.EasySwitchFirstRunDraft?.clear();
}
function firstRunDraftCard() {
  const draft = firstRun.draft;
  const provider = state.providers.find(p => p.id === draft.providerId);
  const agents = firstRunAgents();
  const models = provider ? modelsOf(provider).filter(model => selectableModelNames().includes(`${provider.id}/${model}`)) : [];
  const issue = firstRunSelectionIssue(draft);
  const sourcePlaceholder = provider ? "" : `<option value="${esc(draft.providerId)}" selected disabled>${draft.providerId ? `${esc(draft.providerId)}（当前来源不存在）` : "请选择当前来源"}</option>`;
  const modelPlaceholder = models.includes(draft.model) ? "" : `<option value="${esc(draft.model)}" selected disabled>${draft.model ? `${esc(draft.model)}（当前不可选择）` : "请选择当前模型"}</option>`;
  const agentPlaceholder = agents.some(a => a.id === draft.agent) ? "" : `<option value="${esc(draft.agent)}" selected disabled>${draft.agent ? `${esc(draft.agent)}（当前未检测到）` : "请选择当前程序"}</option>`;
  return `<section class="card" id="first-run" style="padding:20px"><div class="section-head"><h2>未验证的选择草稿</h2><button class="btn secondary" data-first-action="dismiss">丢弃草稿</button></div>
    <p>这里只保留了这个标签页的选择提示，不能证明仍是之前的服务或账号。请重新核对下面的当前来源、模型和程序；没有恢复登录、已保存设置或检测成功状态。</p>
    <div class="form"><div class="field"><label for="first-run-draft-provider">当前来源</label><select id="first-run-draft-provider" data-first-draft-choice="providerId">${sourcePlaceholder}${state.providers.map(p => `<option value="${esc(p.id)}" ${p.id === draft.providerId ? "selected" : ""}>${esc(p.name)}${p.off ? "（已关闭）" : p.budgetStatus?.blocked ? "（预算暂停）" : ""}</option>`).join("")}</select></div>
    <div class="field"><label for="first-run-draft-model">当前模型</label><select id="first-run-draft-model" data-first-draft-choice="model">${modelPlaceholder}${models.map(model => `<option value="${esc(model)}" ${model === draft.model ? "selected" : ""}>${esc(model)}</option>`).join("")}</select></div>
    <div class="field"><label for="first-run-draft-agent">当前已安装程序</label><select id="first-run-draft-agent" data-first-draft-choice="agent">${agentPlaceholder}${agents.map(a => `<option value="${esc(a.id)}" ${a.id === draft.agent ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></div></div>
    ${issue ? `<p class="msg">${esc(firstRunErrorInfo({ code: issue }, "launch").reason)}</p>` : ""}
    ${draft.phase === "launch-uncertain" ? `<p class="msg" role="status">上次启动结果尚未确认，也不能确认属于当前服务；请先检查已有窗口，避免重复启动。</p>` : ""}
    <p class="hint">确认只回到选择步骤，不会自动检测、保存绑定或启动。草稿仅支持同一标签页刷新，30分钟后过期，不保证关闭标签页后恢复。</p>
    <div class="controls"><button class="btn" data-first-action="confirm-draft" ${issue ? "disabled" : ""}>确认当前选择，继续设置</button><button class="btn secondary" data-first-action="draft-providers">检查或添加当前来源</button></div></section>`;
}
function firstRunCard() {
  firstRunSync();
  if (!firstRunVisible()) return "";
  if (firstRun.draft) return firstRunDraftCard();
  const p = state.providers.find(p => p.id === firstRun.providerId);
  const choices = firstRunPresets();
  if (!choices.some(p => p.id === firstRun.presetId)) firstRun.presetId = choices[0]?.id ?? "";
  const preset = choices.find(p => p.id === firstRun.presetId);
  const agents = firstRunAgents();
  const a = agents.find(a => a.id === firstRun.agent);
  const issue = firstRun.step > 1 ? firstRunSelectionIssue() : "";
  const recovery = (issue ? firstRunErrorInfo({ code: issue }, "launch").action : null) || firstRun.errorAction;
  const disabled = firstRun.busy ? "disabled" : "";
  const unavailable = disabled || issue ? "disabled" : "";
  let content = "";
  if (firstRun.done) content = `<h3>启动请求已完成</h3><p>你选择的模型已保存在这个 agent 的增强设置里；请在新窗口继续，实际推理是否成功仍以客户端结果为准。平时直接打开它仍使用原来的设置。</p><button class="btn" data-first-action="finish">进入控制台</button>`;
  else if (firstRun.step === 1) {
    content = p ? `<p>已保存来源：${esc(p.name)}。${firstRun.tested ? "检测已通过。" : "尚未通过推理检测；重试不会重复添加来源。"}</p>
      <div class="controls"><button class="btn" data-first-action="probe" ${disabled}>${firstRun.busy ? "正在检测…" : "重新检测"}</button><button class="btn secondary" data-first-action="providers" ${disabled}>检查来源设置</button>${firstRun.tested ? `<button class="btn" data-first-action="next" ${disabled}>选择启动程序</button>` : ""}</div>`
      : firstRun.providerId ? `<p>之前选择的来源已移除；没有自动改选其他来源。</p><button class="btn" data-first-action="reset-source" ${disabled}>重新接入来源</button>`
      : `<form data-first-source class="form"><div class="field"><label for="first-run-preset">选择你已经购买或准备好的来源</label><select id="first-run-preset" name="presetId" data-first-preset ${disabled}>${choices.map(x => `<option value="${esc(x.id)}" ${x.id === firstRun.presetId ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></div>
        ${preset?.id === "relay" ? `<div class="field"><label for="first-run-base-url">来源地址</label><input id="first-run-base-url" name="baseUrl" type="url" required placeholder="https://你的来源地址/v1" ${disabled}></div>` : ""}
        <div class="field"><label for="first-run-api-key">粘贴这个来源的 Key${preset?.category === "本地" ? "（本地模型可留空）" : ""}</label><input id="first-run-api-key" name="apiKey" type="password" autocomplete="off" spellcheck="false" ${preset?.category !== "本地" ? "required" : ""} ${disabled}></div>
        <p class="hint">${esc(preset?.note ?? "只使用你自己的来源和密钥。")}</p><p class="hint">下一步会保存来源并发出少量模型请求进行检测，可能产生费用；不会替你购买、登录或修改预算。需要项目/区域等设置的来源请用完整添加页。</p>
        <div class="controls"><button class="btn" type="submit" ${disabled || !preset ? "disabled" : ""}>${firstRun.busy ? "正在添加并检测…" : "添加并检测"}</button><button class="btn secondary" type="button" data-first-action="subscription" ${disabled}>用我的订阅</button><button class="btn secondary" type="button" data-first-action="providers" ${disabled}>完整添加页</button></div></form>`;
  } else if (firstRun.step === 2) {
    content = `<p>来源：${esc(p?.name ?? "已移除")} ${firstRun.tested ? "· 接入时检测已通过" : "· 尚未验证真实推理"}</p>`;
    if (!agents.length) content += `<p class="msg bad">${agentDetectionState === "loading" ? "正在检测客户端，已有选择保留。" : (agentDetectionState === "error" || (agentList ?? []).some(a => a.can?.interactive && clientDetection(a) === "error")) ? "客户端检测失败，不能判断是否已安装；请重新检测，已有选择保留。" : "当前服务环境未发现支持增强会话的程序，不代表电脑上一定未安装。可查看 Agent 列表中的官方指引，自行安装后重新检测。"}</p><div class="controls"><button class="btn secondary" data-first-action="detect" aria-disabled="${firstRun.busy}">重新检测已安装程序</button><button class="btn secondary" data-first-action="agents" ${disabled}>查看 Agent 列表</button></div>`;
    else {
      const models = modelsOf(p).filter(m => selectableModelNames().includes(`${p.id}/${m}`));
      const staleAgent = firstRun.agent && !a ? `<option value="${esc(firstRun.agent)}" selected disabled>${esc(firstRun.agent)}（已不可用，选择仍保留）</option>` : "";
      const staleModel = firstRun.model && !models.includes(firstRun.model) ? `<option value="${esc(firstRun.model)}" selected disabled>${esc(firstRun.model)}（当前不可选择，选择仍保留）</option>` : "";
      content += `<form data-first-agent class="form"><p><strong>${esc(a?.name ?? firstRun.agent)}</strong> 将使用 <strong>${esc(firstRun.model || "尚无模型")}</strong>。</p><details data-keep="first-run-options" ${issue ? "open" : keepOpen("first-run-options")}><summary>更换程序或模型</summary><div class="field"><label for="first-run-agent">已安装的程序（Agent）</label><select id="first-run-agent" name="agent" data-first-choice="agent" ${disabled}>${staleAgent}${agents.map(a => `<option value="${esc(a.id)}" ${firstRun.agent === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></div><div class="field"><label for="first-run-model">增强会话的模型</label><select id="first-run-model" name="model" data-first-choice="model" ${disabled}>${staleModel}${models.map(m => `<option value="${esc(m)}" ${firstRun.model === m ? "selected" : ""}>${esc(m)}</option>`).join("")}</select></div><p class="hint">默认选择最近使用最多的已安装程序；没有使用记录时选检测列表中的第一个。部分启动方式尚待真实程序验收。</p></details><p class="hint">启动会打开独立增强会话，不修改你平时的配置。后续使用模型可能产生费用或消耗套餐额度；不会自动购买、登录或更改预算。</p><div class="controls"><button class="btn" type="submit" data-first-submit="launch" ${unavailable}>${firstRun.busy ? "正在保存并启动…" : "保存并启动增强会话"}</button><button class="btn secondary" type="submit" data-first-submit="save" ${unavailable}>只保存，复制命令</button></div></form>`;
    }
  } else {
    content = `<p>设置已保存：${esc(a?.name ?? "Agent 已不可用")} 将使用 ${esc(p?.name ?? "已移除")} / ${esc(firstRun.model)}。</p><p class="hint">启动会打开独立增强会话，不修改你平时的配置；后续使用可能产生费用或消耗套餐额度。也可以复制命令，在自己的 bash/zsh 终端运行。</p><div class="controls"><button class="btn" data-first-action="launch" ${unavailable}>${firstRun.busy ? "正在启动…" : "启动增强会话"}</button><button class="btn secondary" data-first-action="copy" ${unavailable}>复制 es 命令</button><button class="btn secondary" data-first-action="back" ${disabled}>更换程序或模型</button></div><p><code>${esc(firstRunCommand())}</code></p>`;
  }
  if (!firstRun.done && !p && firstRun.providerId && firstRun.step > 1) content += `<button class="btn secondary" data-first-action="reset-source" ${disabled}>重新接入来源</button>`;
  if ((issue === "client_not_installed" || firstRun.errorCode === "client_not_installed") && (firstRun.step !== 2 || agents.length)) content += `<button class="btn secondary" data-first-action="detect" aria-disabled="${firstRun.busy}">重新检测已安装程序</button>`;
  const issueText = issue ? `<p class="msg">${esc(firstRunErrorInfo({ code: issue }, "launch").reason)}</p>` : "";
  const uncertain = firstRun.launchUncertain ? `<p class="msg" role="status">上次启动结果尚未确认，请先检查是否已有窗口，再决定是否重试或运行命令，避免重复启动。</p>` : "";
  return `<section class="card" id="first-run" style="padding:20px"><div class="section-head"><h2>第一次使用，两步准备好</h2><button class="btn secondary" data-first-action="dismiss" ${disabled}>暂时跳过</button></div><ol class="steps"><li${firstRun.step === 1 ? ' aria-current="step"' : ""}>接入来源</li><li${firstRun.step > 1 ? ' aria-current="step"' : ""}>确认并启动</li></ol>${content}${firstRun.message ? `<p class="msg" role="status">${esc(firstRun.message)}</p>` : ""}${issueText}${uncertain}${recovery && !firstRun.done ? `<button class="btn secondary" data-first-action="recover" ${disabled}>${esc(recovery.label)}</button>` : ""}</section>`;
}
async function firstRunProbe() {
  if (firstRun.draft) throw { code: "invalid_input" };
  const result = await call("POST", `/api/providers/${encodeURIComponent(firstRun.providerId)}/probe`, { model: firstRun.model });
  if (!result.probe?.checks?.some(c => ["chat", "responses", "messages"].includes(c.id) && c.status === "pass")) throw { code: "provider_unavailable" };
  firstRun.tested = true; firstRun.step = 2; firstRun.message = "来源检测通过，确认下面的程序和模型即可启动。";
}
document.addEventListener("change", event => {
  if (firstRun.busy) return;
  if (firstRun.draft) {
    if (!event.target.matches?.("[data-first-draft-choice]")) return;
    if (!globalThis.EasySwitchFirstRunDraft?.validate(firstRun.draft)) {
      firstRun.draft = null; firstRun.active = state.providers.length === 0;
      globalThis.EasySwitchFirstRunDraft?.clear(); render(); return;
    }
    const field = event.target.dataset.firstDraftChoice;
    if (!["providerId", "model", "agent"].includes(field)) return;
    if (field === "providerId" && firstRun.draft.providerId !== event.target.value) firstRun.draft.model = "";
    firstRun.draft[field] = event.target.value;
    firstRunSaveDraft(); render();
    document.querySelector(`[data-first-draft-choice="${field}"]`)?.focus?.({ preventScroll: true });
    return;
  }
  if (event.target.matches?.("[data-first-preset]")) firstRun.presetId = event.target.value;
  else if (event.target.matches?.("[data-first-choice]")) {
    const field = event.target.dataset.firstChoice;
    if (!["agent", "model"].includes(field)) return;
    if (field === "model" && firstRun.model !== event.target.value) firstRun.tested = false;
    firstRun[field] = event.target.value; firstRun.saved = false;
  } else return;
  firstRun.message = ""; firstRun.errorAction = null; firstRun.errorCode = ""; render();
  if (firstRun.providerId) firstRunSaveDraft();
  const choice = event.target.dataset?.firstChoice;
  if (["agent", "model"].includes(choice)) document.querySelector(`[data-first-choice="${choice}"]`)?.focus?.({ preventScroll: true });
});
document.addEventListener("submit", async event => {
  const source = event.target.matches?.("[data-first-source]");
  const agent = event.target.matches?.("[data-first-agent]");
  if (!source && !agent) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (firstRun.busy || firstRun.done || !firstRunVisible() || firstRun.draft) return;
  const fields = new FormData(event.target), navigation = pageNavigationVersion;
  if (source && firstRun.providerId) return;
  firstRun.busy = true; firstRun.message = ""; firstRun.errorAction = null; firstRun.errorCode = "";
  try {
    if (source) {
      const preset = firstRunPresets().find(p => p.id === fields.get("presetId"));
      if (!preset) throw { code: "invalid_input" };
      const key = String(fields.get("apiKey") ?? "").trim();
      if (!key && preset.category !== "本地") throw { code: "key_rejected" };
      const baseUrl = preset.id === "relay" ? String(fields.get("baseUrl") ?? "").trim() : preset.baseUrl;
      // The key stays in this stack frame and the existing credential API only.
      const input = { name: preset.name, baseUrl, apiKey: key, presetId: preset.id, ...(preset.anthropicBaseUrl ? { anthropicBaseUrl: preset.anthropicBaseUrl } : {}) };
      event.target.reset?.(); render();
      firstRunSaveDraft("source");
      const created = await call("POST", "/api/providers", input);
      firstRun.providerId = created.id;
      firstRun.model = modelsOf(created).includes(preset.defaultModel) ? preset.defaultModel : modelsOf(created)[0] || preset.defaultModel || "";
      if (!firstRun.model) firstRun.message = "来源已保存，但没有读到可用模型；请打开来源设置检查密钥和模型，再回来继续。";
      else if (firstRunStillHere(navigation)) await firstRunProbe();
      else firstRun.message = "来源已保存；你已离开设置，尚未开始推理检测，回来后可主动继续。";
    } else {
      const selection = { providerId: firstRun.providerId, agent: String(fields.get("agent") ?? ""), model: String(fields.get("model") ?? "") };
      const issue = firstRunSelectionIssue(selection);
      if (issue) throw { code: issue };
      Object.assign(firstRun, selection); render(); firstRunSaveDraft();
      await call("PUT", `/api/bindings/${encodeURIComponent(selection.agent)}`, { providerId: selection.providerId, model: selection.model });
      firstRun.saved = true; firstRun.step = 3;
      if (event.submitter?.dataset.firstSubmit !== "save" && firstRunStillHere(navigation)) await firstRunLaunch(selection);
      else firstRun.message = "设置已保存，尚未启动。可以主动启动或复制命令。";
    }
  } catch (error) { firstRunSetError(error, source ? "source" : "launch"); }
  finally { firstRun.busy = false; await refresh(true); firstRunSaveDraft(); }
});
async function firstRunNavigate(target) {
  if (target === "providers" && state.providers.some(p => p.id === firstRun.providerId)) openProvider = firstRun.providerId;
  if (target === "agents") firstRun.suspended = true;
  await navigatePage(target); render();
}
document.addEventListener("click", async event => {
  const button = event.target.closest?.("[data-first-action]"); if (!button) return;
  event.preventDefault(); event.stopImmediatePropagation(); if (firstRun.busy || button.disabled) return;
  const action = button.dataset.firstAction;
  if (["dismiss", "finish"].includes(action)) { firstRun.active = false; firstRun.draft = null; globalThis.EasySwitchFirstRunDraft?.clear(); render(); return; }
  if (action === "resume") { firstRun.suspended = false; await navigatePage("agents"); render(); return; }
  if (firstRun.draft) {
    if (action === "draft-providers") { await firstRunNavigate("providers"); return; }
    if (action !== "confirm-draft" || page !== "agents" || !firstRunVisible()) return;
    const draft = globalThis.EasySwitchFirstRunDraft?.validate(firstRun.draft);
    if (!draft) { firstRun.draft = null; firstRun.active = state.providers.length === 0; globalThis.EasySwitchFirstRunDraft?.clear(); render(); return; }
    if (firstRunSelectionIssue(draft)) { render(); return; }
    Object.assign(firstRun, { providerId: draft.providerId, model: draft.model, agent: draft.agent,
      draft: null, step: 2, tested: false, saved: false, done: false, subscription: false,
      errorAction: null, errorCode: "", launchUncertain: draft.phase === "launch-uncertain",
      message: "已重新确认当前目录；尚未验证真实推理，保存或启动仍需你主动选择。" });
    firstRunSaveDraft(); render(); return;
  }
  if (action === "recover") {
    const issue = firstRun.step > 1 ? firstRunSelectionIssue() : "";
    const info = (issue ? firstRunErrorInfo({ code: issue }, "launch").action : null) || firstRun.errorAction;
    if (!info) return;
    if (info.target === "current") { firstRun.step = firstRun.providerId ? 2 : 1; openDetails.add("first-run-options"); render(); }
    else if (["providers", "agents", "usage", "doctor", "settings", "sessions"].includes(info.target)) await firstRunNavigate(info.target);
    return;
  }
  if (["providers", "subscription", "agents"].includes(action)) {
    if (action === "subscription") { firstRun.subscription = true; firstRun.message = "请在订阅页面主动选择登录方式；新订阅默认关闭，需要你明确打开后才能继续。"; }
    await firstRunNavigate(action === "agents" ? "agents" : "providers"); return;
  }
  if (firstRun.done || !firstRunVisible()) return;
  if (action === "reset-source" && !state.providers.some(p => p.id === firstRun.providerId)) {
    Object.assign(firstRun, { providerId: "", model: "", step: 1, tested: false, saved: false, subscription: false, message: "", errorAction: null, errorCode: "" });
    if (!firstRun.launchUncertain) globalThis.EasySwitchFirstRunDraft?.clear();
    render(); return;
  }
  if (action === "back") { firstRun.step = 2; firstRun.message = ""; firstRun.errorAction = null; firstRun.errorCode = ""; openDetails.add("first-run-options"); render(); return; }
  if (action === "next") { firstRun.step = 2; render(); return; }
  if (!["probe", "detect", "launch", "copy"].includes(action)) return;
  firstRun.busy = true; firstRun.message = ""; firstRun.errorAction = null; firstRun.errorCode = ""; render();
  try {
    if (action === "probe") await firstRunProbe();
    if (action === "detect") await recheckClients();
    if (action === "launch") await firstRunLaunch(firstRunSelection());
    if (action === "copy") {
      const issue = firstRunSelectionIssue(); if (issue) throw { code: issue };
      await navigator.clipboard.writeText(firstRunCommand()); firstRun.message = "已复制；在终端粘贴运行即可。";
    }
  } catch (error) {
    if (action === "copy") firstRun.message = "没有复制成功：请检查当前选择；有效时也可选中上面的命令，手动复制到终端。";
    else firstRunSetError(error, action === "launch" ? "launch" : "source");
  } finally { firstRun.busy = false; if (action === "detect") render(); else await refresh(true); firstRunSaveDraft(); }
});
