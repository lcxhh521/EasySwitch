// Optional, explicit finite-list confirmation. Authority stays in memory, never in a draft or copy action.
"use strict";
let automaticPoolGeneration = 0;
let automaticPoolReview = null;
let automaticPoolCommit = null;
let automaticPoolUncertain = null;

function automaticPoolBoundModel(harness) {
  const binding = state?.bindings?.[harness];
  return binding ? `${binding.providerId}/${binding.model}` : "";
}
function automaticPoolCurrent(review) {
  return automaticPoolReview === review && review.generation === automaticPoolGeneration && review.navigation === pageNavigationVersion
    && page === "agents" && automaticPoolBoundModel(review.harness) === review.modelId && selectableModelNames().includes(review.modelId);
}
function automaticPoolInvalidate() {
  automaticToolInvalidate();
  automaticPoolGeneration++;
  // A sent save may have committed even when its response has not arrived. Do not mint a second confirmation.
  if (automaticPoolCommit) automaticPoolUncertain = automaticPoolCommit;
  automaticPoolReview = null;
}
function automaticPoolEntry(harness) {
  const modelId = automaticPoolBoundModel(harness);
  const isAutomatic = name => typeof name === "string" && name.startsWith("pool/") && state?.pools?.some(pool => pool.id === name.slice(5) && pool.strategy === "automatic");
  let tierNotice = Object.values(state?.prefs?.[harness]?.tiers ?? {}).some(isAutomatic)
    ? `<div class="ctl"><strong class="chip">小模型已使用纯文字自动模式</strong><span class="hint">工具请求会被拒绝；请在对应小模型选择器改回固定来源或跟随主模型，下次启动生效。</span></div>` : "";
  if (!modelId) return tierNotice;
  if (modelId.startsWith("pool/")) {
    if (!isAutomatic(modelId)) return tierNotice;
    if (harness === "opencode" && automaticToolSnapshot(harness)) {
      if (tierNotice) tierNotice = `<div class="ctl"><span class="hint">自动小模型在普通启动时仅纯文字；工具试用中仅与主模型相同的自动模型共用本次固定来源，其他自动小模型请改回固定来源或跟随主模型。</span></div>`;
      return `<div class="ctl"><strong class="chip">普通启动仅纯文字试用</strong><span class="hint">普通「启动」仍会拒绝工具请求；「新开工具会话」需另行确认，仅试用普通函数工具。需要常规工具会话，请在本 Agent 卡片的「主模型」选择器选回固定来源，下次启动生效。</span></div>${tierNotice}`;
    }
    return `<div class="ctl"><strong class="chip">仅纯文字试用</strong><span class="hint">工具请求会被拒绝；工具会话请在本 Agent 卡片的「主模型」选择器选回固定来源，下次启动生效。</span></div>${tierNotice}`;
  }
  const unavailable = !selectableModelNames().includes(modelId);
  return `<button class="btn secondary" id="automatic-pool-start-${esc(encodeURIComponent(harness))}" data-automatic-start="${esc(harness)}" ${unavailable || automaticPoolCommit || automaticPoolUncertain ? "disabled" : ""} title="仅纯文字试用；工具请求会被拒绝。先核对来源和固定 Key 名单，不启动程序">自动选来源（仅纯文字试用）</button>${tierNotice}`;
}
function automaticPoolScopeWarning(harness) {
  if (harness === "opencode") return `<p class="msg" role="note"><strong>此确认只设置普通启动的纯文字自动模式，普通启动会拒绝工具请求。</strong> OpenCode 的普通函数工具试用需保存后另点「新开工具会话」确认；也可在本 Agent 卡片的「主模型」选择器选回固定来源，下次启动生效。</p>`;
  return `<p class="msg" role="note"><strong>仅纯文字试用：常见编程 Agent 的工具请求会被拒绝。</strong> 工具会话请保留固定来源；在该 Agent 卡片的「主模型」选择器选回固定来源即可恢复固定来源模式，新设置在下次启动时生效。</p>`;
}
function automaticPoolMembers(preview) {
  const billing = value => value === "usage" ? "按量计费" : value === "subscription" ? "订阅计费，不代表无额外费用" : "计费未知，请先核对费用";
  return `<ol>${preview.members.map((member, index) => `<li><strong>${esc(member.providerName)}</strong>${index === 0 ? "（当前来源优先）" : ""} · ${esc(member.modelId)} · 固定 Key：${esc(member.keyLabel)} · ${billing(member.billing)}</li>`).join("")}</ol>`;
}
function automaticPoolCard() {
  if (page !== "agents") return "";
  let review = automaticPoolReview;
  if (review && !automaticPoolCurrent(review)) { automaticPoolInvalidate(); review = null; }
  if (!review) {
    const unresolved = automaticPoolUncertain;
    if (!unresolved) return "";
    return `<section class="card" aria-labelledby="automatic-pool-title"><h2 id="automatic-pool-title">上次自动选择的保存结果尚未确定</h2>${automaticPoolScopeWarning(unresolved.harness)}<p class="hint" role="status">先刷新查看 ${esc(agentMeta(unresolved.harness).name)} 的实际主模型。没有自动重试，也没有启动程序。</p><button class="btn secondary" id="automatic-pool-refresh" data-automatic-refresh>刷新实际绑定</button>${unresolved.preview ? automaticPoolMembers(unresolved.preview) : ""}${!automaticPoolCommit ? `<p class="hint">核对会重新发送上次已确认的同一个保存请求，可能完成那次绑定；不会新建第二份。若你后来已改选模型，不会覆盖新选择。</p><button class="btn secondary" id="automatic-pool-resolve" data-automatic-resolve>核对上次保存结果</button>` : `<p class="hint">上次保存仍在等待响应。</p>`}</section>`;
  }
  const preview = review.preview;
  return `<section class="card" aria-labelledby="automatic-pool-title"><h2 id="automatic-pool-title">自动选来源 · ${esc(agentMeta(review.harness).name)}</h2>
    ${automaticPoolScopeWarning(review.harness)}
    <p class="hint">${esc(preview?.model ?? review.modelId)}：核对以下有限来源和固定 Key，确认后只保存该 Agent 的主模型绑定，不启动程序、不主动探测。</p>
    ${preview ? `${automaticPoolMembers(preview)}<p class="hint">这些来源可能属于不同账号；同名不证明能力相同，请核对它们适合你的请求。只在这份名单内选择，不暗换 Key。应用内来源名单、端点、模型、凭据或计费类别变更后必须重新确认；外部密钥库变化在读取发现后使确认失效，不能保证与外部修改原子同步。</p><p class="hint">普通启动目前仅支持普通 HTTP 无状态纯文字；不支持工具、图片/音频或续接会话。未知状态不代表可用或额度充足，不保证同账号、最便宜或健康。每次请求最多两次实际发送，兼容修复和备用共用上限，两次都可能计费；开始输出后不换源重放，全部等待时暂停。</p>` : ""}
    ${review.error ? `<p class="msg" role="status">${esc(review.error)}</p>` : ""}
    <div class="controls">${review.busy ? `<span role="status">${review.busy === "preview" ? "正在读取可确认的来源名单…" : "正在保存；不会启动程序…"}</span>` : preview ? `<button class="btn" id="automatic-pool-confirm" data-automatic-confirm>${automaticPoolUncertain === review ? "重试同一次纯文字确认" : "确认并使用纯文字模式"}</button>` : `<button class="btn secondary" id="automatic-pool-recheck" data-automatic-recheck>重新核对来源</button>`}
    <button class="btn secondary" id="automatic-pool-cancel" data-automatic-cancel>${review.busy === "confirm" || automaticPoolUncertain ? "收起" : "取消"}</button></div></section>`;
}
function automaticPoolPreviewData(value, review) {
  if (!value || typeof value.confirmationId !== "string" || !value.confirmationId || value.confirmationId.length > 256
    || value.primaryModelId !== review.modelId || value.harness !== review.harness || typeof value.model !== "string"
    || !Array.isArray(value.members) || value.members.length < 1 || value.members.length > 100
    || value.members[0]?.modelId !== review.modelId) throw new Error("Invalid automatic preview");
  const expiresAt = typeof value.expiresAt === "number" ? value.expiresAt : Date.parse(value.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error("Expired automatic preview");
  const seen = new Set();
  const members = value.members.map(member => {
    if (!member || typeof member.modelId !== "string" || !member.modelId.includes("/") || member.modelId.startsWith("pool/") || seen.has(member.modelId)
      || typeof member.providerName !== "string" || typeof member.keyLabel !== "string" || !member.keyLabel) throw new Error("Invalid automatic member");
    seen.add(member.modelId);
    return { modelId: member.modelId, providerName: member.providerName, keyLabel: member.keyLabel, billing: member.billing === "usage" || member.billing === "subscription" ? member.billing : "unknown" };
  });
  // Do not retain extra server fields, configuration digests, endpoints or credential values.
  return { confirmationId: value.confirmationId, expiresAt, model: value.model, members };
}
async function automaticPoolRequest(path, body) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("Automatic selection request timed out")); }, 15_000);
  });
  try { return await Promise.race([call("POST", path, body, { signal: controller.signal }), deadline]); }
  finally { clearTimeout(timer); }
}
async function automaticPoolStart(harness) {
  if (page !== "agents" || automaticPoolCommit || automaticPoolUncertain || automaticPoolReview?.busy) return;
  const modelId = automaticPoolBoundModel(harness);
  if (!modelId || modelId.startsWith("pool/") || !selectableModelNames().includes(modelId)) return;
  const review = { harness, modelId, generation: ++automaticPoolGeneration, navigation: pageNavigationVersion, busy: "preview", preview: null, error: "" };
  automaticPoolReview = review; render();
  try {
    const result = await automaticPoolRequest("/api/pools/automatic/preview", { modelId, harness });
    if (!automaticPoolCurrent(review)) return;
    review.preview = automaticPoolPreviewData(result, review);
  } catch (error) {
    if (automaticPoolCurrent(review)) review.error = error?.status === 409 ? "选择已变化，请重新核对来源。" : error?.status === 400 ? "当前模型或来源不支持自动选择；原绑定保持不变。请在模型页核对来源。" : "无法取得有效来源名单，请重新核对。原绑定保持不变。";
  } finally {
    if (automaticPoolCurrent(review)) { review.busy = ""; render(); }
  }
}
async function automaticPoolConfirm() {
  const review = automaticPoolReview;
  if (!review || !automaticPoolCurrent(review) || review.busy || !review.preview || automaticPoolCommit) return;
  if (review.preview.expiresAt <= Date.now() && automaticPoolUncertain !== review) {
    review.preview = null; review.error = "名单已过期，请重新核对来源。"; render(); return;
  }
  const confirmationId = review.preview.confirmationId;
  review.busy = "confirm"; review.error = ""; automaticPoolCommit = review; render();
  try {
    const result = await automaticPoolRequest("/api/pools/automatic/confirm", { confirmationId });
    if (!result?.pool || typeof result.pool.id !== "string" || result.pool.strategy !== "automatic"
      || result.binding?.harness !== review.harness || result.binding?.providerId !== "pool" || result.binding?.model !== result.pool.id) throw new Error("Invalid automatic confirmation");
    if (automaticPoolUncertain === review) automaticPoolUncertain = null;
    if (automaticPoolCurrent(review)) {
      automaticPoolReview = null; automaticPoolGeneration++;
      toast("已保存自动来源绑定，尚未启动程序。请查看当前主模型，再按需启动。");
    }
  } catch (error) {
    if (error?.status === 400 || error?.status === 409) {
      if (automaticPoolUncertain === review) automaticPoolUncertain = null;
      review.preview = null;
      review.error = error.status === 409 ? "来源、凭据、选择已变化或名单过期；请重新核对，不会自动重试。" : "当前模型或来源不可用或不支持自动选择。请核对来源后重新确认。";
    } else {
      automaticPoolUncertain = review;
      review.error = "保存结果尚未确定。请刷新查看实际主模型，或重试同一次确认；不会重新创建另一份名单，也不会自动启动。";
    }
  } finally {
    if (automaticPoolCommit === review) automaticPoolCommit = null;
    review.busy = "";
    // Refresh the server's actual state, never synthesize a binding from an old preview/response.
    await refresh(true);
    if (automaticPoolCurrent(review)) render();
  }
}
async function automaticPoolResolve() {
  const review = automaticPoolUncertain;
  if (!review?.preview || automaticPoolCommit || page !== "agents") return;
  const navigation = pageNavigationVersion;
  automaticPoolCommit = review; render();
  try {
    // This is an explicit replay of a previously sent confirmation, never a new preview.
    // The server must return a consumed result without rebinding, or reject a changed binding.
    const result = await automaticPoolRequest("/api/pools/automatic/confirm", { confirmationId: review.preview.confirmationId });
    if (!result?.pool || result.pool.strategy !== "automatic" || result.binding?.harness !== review.harness
      || result.binding?.providerId !== "pool" || result.binding?.model !== result.pool.id) throw new Error("Invalid confirmation result");
    if (automaticPoolUncertain === review) automaticPoolUncertain = null;
    if (navigation === pageNavigationVersion && page === "agents") toast("上次保存结果已核对。当前绑定以刷新后的主模型为准，未启动程序。");
  } catch (error) {
    if (error?.status === 400 || error?.status === 409) {
      if (automaticPoolUncertain === review) automaticPoolUncertain = null;
      if (navigation === pageNavigationVersion && page === "agents") toast("旧确认已失效或选择已变化。请查看当前主模型，再重新核对来源。");
    }
  } finally {
    if (automaticPoolCommit === review) automaticPoolCommit = null;
    await refresh(true);
    if (navigation === pageNavigationVersion && page === "agents") render();
  }
}
document.addEventListener("click", async event => {
  const target = event.target.closest?.("[data-automatic-start], [data-automatic-confirm], [data-automatic-cancel], [data-automatic-recheck], [data-automatic-refresh], [data-automatic-resolve], [data-automatic-manage]");
  if (!target) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (target.disabled) return;
  if (target.hasAttribute("data-automatic-start")) { await automaticPoolStart(target.dataset.automaticStart); return; }
  if (target.hasAttribute("data-automatic-confirm")) { await automaticPoolConfirm(); return; }
  if (target.hasAttribute("data-automatic-cancel")) { automaticPoolInvalidate(); render(); return; }
  if (target.hasAttribute("data-automatic-recheck")) { const harness = automaticPoolReview?.harness; automaticPoolInvalidate(); if (harness) await automaticPoolStart(harness); return; }
  if (target.hasAttribute("data-automatic-refresh")) { await refresh(true); return; }
  if (target.hasAttribute("data-automatic-resolve")) { await automaticPoolResolve(); return; }
  if (target.hasAttribute("data-automatic-manage")) {
    toast("自动来源名单不能在旧编辑器修改。请到 Agent 页选择要优先使用的直接来源，再点「自动选来源」重新确认；原模型池不会被改成顺序模式。");
    await navigatePage("agents");
  }
});

// P1 is a separate, explicitly confirmed NEW launch. Never infer it from an automatic binding.
let automaticToolReview = null;
let automaticToolFlight = null;
let automaticToolUncertain = null;
let automaticToolGeneration = 0;

function automaticToolSnapshot(harness, source = state) {
  if (harness !== "opencode" || page !== "agents") return null;
  const agent = typeof agentList !== "undefined" && agentList?.find(item => item.id === harness);
  if (!agent?.installed || !agent.can?.interactive || agent.where?.endsWith(".app")) return null;
  const launchReviewId = source?.automaticToolLaunchReviews?.[harness];
  if (typeof launchReviewId !== "string" || !/^[a-f0-9]{64}$/.test(launchReviewId)) return null;
  const binding = source?.bindings?.[harness];
  if (binding?.providerId !== "pool") return null;
  const pool = source?.pools?.find(item => item.id === binding.model);
  const approval = pool?.automaticApproval;
  if (pool?.strategy !== "automatic" || !/^[a-f0-9]{64}$/.test(pool.automaticToolsApprovalId ?? "") || approval?.version !== 1 || !Array.isArray(pool.members) || pool.members.length < 2
    || !Array.isArray(approval.members) || approval.members.length !== pool.members.length
    || !approval.members.every((member, index) => member?.member === pool.members[index] && typeof member.credentialLabel === "string" && member.credentialLabel)) return null;
  const modelId = `pool/${pool.id}`;
  // Older state responses do not supply enough information for this new launch mode.
  if (!Array.isArray(source.selectableModels) || !source.selectableModels.includes(modelId)) return null;
  // Canonical, length-delimited PUBLIC values only. This is UI stale-state detection, not authorization.
  const fingerprint = value => {
    if (value === null || value === undefined) return String(value);
    if (Array.isArray(value)) return `a[${value.map(fingerprint).join("")}]`;
    if (typeof value === "object") return `o{${Object.keys(value).sort().map(key => fingerprint(key) + fingerprint(value[key])).join("")}}`;
    const text = String(value); return `${typeof value}:${text.length}:${text}`;
  };
  return { modelId, pool, launchReviewId, effortUnsupported: Boolean(source.prefs?.[harness]?.effort), approvalId: pool.automaticToolsApprovalId, fingerprint: fingerprint({ launchReviewId, binding, pool: { id: pool.id, name: pool.name, strategy: pool.strategy, createdAt: pool.createdAt, members: pool.members, automaticApproval: approval, automaticToolsApprovalId: pool.automaticToolsApprovalId }, prefs: source.prefs?.[harness] }) };
}
function automaticToolCurrent(review) {
  const current = automaticToolSnapshot(review.harness);
  return automaticToolReview === review && review.generation === automaticToolGeneration && review.navigation === pageNavigationVersion
    && current?.modelId === review.modelId && current.fingerprint === review.fingerprint;
}
function automaticToolInvalidate() {
  automaticToolGeneration++;
  automaticToolReview = null;
}
function automaticToolSync() {
  if (automaticToolReview && !automaticToolCurrent(automaticToolReview)) automaticToolInvalidate();
}
function automaticToolEntry(harness) {
  const snapshot = automaticToolSnapshot(harness);
  if (!snapshot) return "";
  const busy = automaticToolFlight || automaticToolUncertain;
  const button = `<button class="btn secondary" id="automatic-tool-start-${esc(harness)}" data-automatic-tool-start="${esc(harness)}" ${busy || snapshot.effortUnsupported ? "disabled" : ""} title="普通函数工具试用；先阅读限制并确认，只新开会话，不恢复旧会话">新开工具会话（试用）</button>`;
  return button + (snapshot.effortUnsupported ? `<span class="hint" role="status">此试用不支持额外思考档位；当前已设置档位，尚未自动改动。恢复默认只更新下次启动的设置，不会启动程序。</span><button class="btn secondary" id="automatic-tool-reset-effort" data-automatic-tool-reset-effort ${busy ? "disabled" : ""}>恢复默认档位</button>` : "");
}
function automaticToolCard() {
  if (page !== "agents") return "";
  automaticToolSync();
  if (automaticToolUncertain) return `<section class="card" aria-labelledby="automatic-tool-title"><h2 id="automatic-tool-title">启动结果尚未确定</h2><p class="msg" role="status">请先检查 OpenCode 是否已有终端窗口。没有自动重试；刷新或离开本页都不会替你再启动。为避免重复启动，本页已暂停新的 OpenCode 启动。</p><p class="hint">如需退出试用，可在本 Agent 卡片的「主模型」选择器选回固定来源，下次手动启动生效。先核实本次结果，再重新打开控制台操作。</p></section>`;
  const review = automaticToolReview;
  if (!review) return "";
  return `<section class="card" aria-labelledby="automatic-tool-title"><h2 id="automatic-tool-title">OpenCode · 普通函数工具试用</h2>
    <p class="hint">新开 ${esc(review.poolName)}（${esc(review.modelId)}），不会恢复或迁移旧会话。</p>
    <p class="msg" role="note">同一次新启动中，使用同一自动模型的所有对话和子任务共用固定来源和 Key，只自动选一次；其他已设置的固定小模型保持不变。</p>
    <ol>${review.members.map(member => `<li>${esc(member.member)} · 固定 Key：${esc(member.credentialLabel)}</li>`).join("")}</ol>
    <p class="hint">请求已发送后不会自动重试、切来源或换 Key。来源失败、结果不明或网关重启后需要新开会话，不自动续接。EasySwitch 不替客户端执行工具，也不保证客户端自身的重试或工具副作用只执行一次。</p>
    <p class="hint">仅标准 Chat function 普通函数工具，不支持额外思考档位，必须保留默认档位；尚未通过真实 OpenCode 验证；其他协议、图片/音频、托管工具和带隐藏状态的续接不在本次范围。不是“所有工具都支持”。</p>
    <p class="hint">不想试用时，取消即可；需要常规工具会话，请在本 Agent 卡片的「主模型」选择器选回固定来源，下次启动生效。</p>
    <div class="controls">${review.busy ? `<span role="status">${review.busy === "checking" ? "正在核对当前选择，尚未启动…" : "正在请求新开会话，请勿重复操作…"}</span>` : `<button class="btn" id="automatic-tool-confirm" data-automatic-tool-confirm>确认并新开工具会话</button>`}<button class="btn secondary" id="automatic-tool-cancel" data-automatic-tool-cancel>${review.busy === "launching" ? "收起" : "取消"}</button></div></section>`;
}
function automaticToolStart(harness) {
  if (automaticToolFlight || automaticToolUncertain || automaticToolReview?.busy) return;
  const snapshot = automaticToolSnapshot(harness);
  if (!snapshot || snapshot.effortUnsupported) return;
  automaticToolReview = { harness, modelId: snapshot.modelId, fingerprint: snapshot.fingerprint, approvalId: snapshot.approvalId, launchReviewId: snapshot.launchReviewId, poolName: snapshot.pool.name,
    members: snapshot.pool.automaticApproval.members.map(({ member, credentialLabel }) => ({ member, credentialLabel })),
    generation: ++automaticToolGeneration, navigation: pageNavigationVersion, busy: "" };
  render();
}
async function automaticToolRequest(method, path, body) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Tool launch request timed out")); }, 15_000); });
  try { return await Promise.race([call(method, path, body, { signal: controller.signal }), deadline]); }
  finally { clearTimeout(timer); }
}
async function automaticToolConfirm() {
  const review = automaticToolReview;
  if (!review || review.busy || automaticToolFlight || automaticToolUncertain) return;
  if (!automaticToolCurrent(review)) { automaticToolInvalidate(); toast("选择或来源名单已变化，请重新核对后再新开工具会话。"); render(); return; }
  review.busy = "checking"; automaticToolFlight = review; render();
  let sent = false;
  try {
    const latest = await automaticToolRequest("GET", "/api/state");
    if (!automaticToolCurrent(review)) return;
    const next = automaticToolSnapshot(review.harness, latest);
    if (!next || next.modelId !== review.modelId || next.fingerprint !== review.fingerprint) {
      automaticToolInvalidate(); toast("当前绑定或来源名单已变化，未启动。请刷新并重新核对。"); return;
    }
    // No await between this last local check and the exact request. The server independently
    // validates the current binding and approval atomically before registering a launch.
    review.busy = "launching";
    sent = true;
    const result = await automaticToolRequest("POST", `/api/agents/${review.harness}/launch`, { model: review.modelId, automaticTools: true, automaticToolsApprovalId: review.approvalId, automaticToolsLaunchReviewId: review.launchReviewId });
    if (result?.model !== review.modelId) throw new Error("Unverified launch result");
    if (automaticToolCurrent(review)) toast(`已请求新开 OpenCode 工具会话（${review.modelId}）；本次自动模型固定来源和 Key。`);
  } catch (error) {
    if (sent && error?.status !== 400 && error?.status !== 409) automaticToolUncertain = { harness: review.harness, modelId: review.modelId };
    if (automaticToolCurrent(review)) toast(sent
      ? automaticToolUncertain ? "启动结果尚未确定，请先检查终端；不会自动重试。" : "当前选择不支持此试用或已变化，未启动。请重新核对。"
      : "无法核对当前绑定，未启动。请刷新后重试。");
  } finally {
    if (automaticToolFlight === review) automaticToolFlight = null;
    if (automaticToolReview === review) automaticToolInvalidate();
    if (review.navigation === pageNavigationVersion && page === "agents") render();
  }
}
async function automaticToolResetEffort() {
  if (automaticToolFlight || automaticToolUncertain) return;
  const snapshot = automaticToolSnapshot("opencode");
  if (!snapshot?.effortUnsupported) return;
  automaticToolInvalidate();
  const reset = { harness: "opencode", navigation: pageNavigationVersion };
  automaticToolFlight = reset; render();
  try {
    // Existing narrow preference setter: explicit click only, never a launch or a full prefs replacement.
    const result = await automaticToolRequest("PUT", "/api/bindings/opencode/effort", { effort: "" });
    // setPrefs removes an empty effort field; successful default prefs need not contain it.
    if (!result || typeof result !== "object" || Array.isArray(result)
      || Object.keys(result).some(key => !["effort", "tiers", "fallbackModel"].includes(key))
      || (Object.hasOwn(result, "effort") && result.effort !== "")
      || (Object.hasOwn(result, "fallbackModel") && typeof result.fallbackModel !== "string")
      || (Object.hasOwn(result, "tiers") && (!result.tiers || typeof result.tiers !== "object" || Array.isArray(result.tiers) || Object.values(result.tiers).some(value => typeof value !== "string")))) throw new Error("Unverified preference result");
    if (reset.navigation === pageNavigationVersion && page === "agents") toast("已恢复默认档位，未启动程序；请重新核对后再选择新开工具会话。");
  } catch {
    if (reset.navigation === pageNavigationVersion && page === "agents") toast("档位保存结果尚未确定，请刷新核对；没有自动重试，也没有启动程序。");
  } finally {
    if (automaticToolFlight === reset) automaticToolFlight = null;
    // Use actual state, never synthesize cleared preferences from an old response.
    await refresh(true);
  }
}
document.addEventListener("click", async event => {
  const target = event.target.closest?.("[data-automatic-tool-start], [data-automatic-tool-confirm], [data-automatic-tool-cancel], [data-automatic-tool-reset-effort]");
  if (!target) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (target.disabled) return;
  if (target.hasAttribute("data-automatic-tool-reset-effort")) { await automaticToolResetEffort(); return; }
  if (target.hasAttribute("data-automatic-tool-start")) { automaticToolStart(target.dataset.automaticToolStart); return; }
  if (target.hasAttribute("data-automatic-tool-confirm")) { await automaticToolConfirm(); return; }
  automaticToolInvalidate(); render();
});
// A full document navigation (including bfcache) must not preserve an unsent launch confirmation.
if (typeof window !== "undefined") window.addEventListener("pagehide", () => automaticToolInvalidate());
