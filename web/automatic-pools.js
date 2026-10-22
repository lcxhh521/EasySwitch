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
  automaticPoolGeneration++;
  // A sent save may have committed even when its response has not arrived. Do not mint a second confirmation.
  if (automaticPoolCommit) automaticPoolUncertain = automaticPoolCommit;
  automaticPoolReview = null;
}
function automaticPoolEntry(harness) {
  const modelId = automaticPoolBoundModel(harness);
  const isAutomatic = name => typeof name === "string" && name.startsWith("pool/") && state?.pools?.some(pool => pool.id === name.slice(5) && pool.strategy === "automatic");
  const tierNotice = Object.values(state?.prefs?.[harness]?.tiers ?? {}).some(isAutomatic)
    ? `<div class="ctl"><strong class="chip">小模型已使用纯文字自动模式</strong><span class="hint">工具请求会被拒绝；请在对应小模型选择器改回固定来源或跟随主模型，下次启动生效。</span></div>` : "";
  if (!modelId) return tierNotice;
  if (modelId.startsWith("pool/")) {
    if (!isAutomatic(modelId)) return tierNotice;
    return `<div class="ctl"><strong class="chip">仅纯文字试用</strong><span class="hint">工具请求会被拒绝；工具会话请在本 Agent 卡片的「主模型」选择器选回固定来源，下次启动生效。</span></div>${tierNotice}`;
  }
  const unavailable = !selectableModelNames().includes(modelId);
  return `<button class="btn secondary" id="automatic-pool-start-${esc(encodeURIComponent(harness))}" data-automatic-start="${esc(harness)}" ${unavailable || automaticPoolCommit || automaticPoolUncertain ? "disabled" : ""} title="仅纯文字试用；工具请求会被拒绝。先核对来源和固定 Key 名单，不启动程序">自动选来源（仅纯文字试用）</button>${tierNotice}`;
}
function automaticPoolScopeWarning() {
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
    return `<section class="card" aria-labelledby="automatic-pool-title"><h2 id="automatic-pool-title">上次自动选择的保存结果尚未确定</h2>${automaticPoolScopeWarning()}<p class="hint" role="status">先刷新查看 ${esc(agentMeta(unresolved.harness).name)} 的实际主模型。没有自动重试，也没有启动程序。</p><button class="btn secondary" id="automatic-pool-refresh" data-automatic-refresh>刷新实际绑定</button>${unresolved.preview ? automaticPoolMembers(unresolved.preview) : ""}${!automaticPoolCommit ? `<p class="hint">核对会重新发送上次已确认的同一个保存请求，可能完成那次绑定；不会新建第二份。若你后来已改选模型，不会覆盖新选择。</p><button class="btn secondary" id="automatic-pool-resolve" data-automatic-resolve>核对上次保存结果</button>` : `<p class="hint">上次保存仍在等待响应。</p>`}</section>`;
  }
  const preview = review.preview;
  return `<section class="card" aria-labelledby="automatic-pool-title"><h2 id="automatic-pool-title">自动选来源 · ${esc(agentMeta(review.harness).name)}</h2>
    ${automaticPoolScopeWarning()}
    <p class="hint">${esc(preview?.model ?? review.modelId)}：核对以下有限来源和固定 Key，确认后只保存该 Agent 的主模型绑定，不启动程序、不主动探测。</p>
    ${preview ? `${automaticPoolMembers(preview)}<p class="hint">这些来源可能属于不同账号；同名不证明能力相同，请核对它们适合你的请求。只在这份名单内选择，不暗换 Key。应用内来源名单、端点、模型、凭据或计费类别变更后必须重新确认；外部密钥库变化在读取发现后使确认失效，不能保证与外部修改原子同步。</p><p class="hint">目前仅支持普通 HTTP 无状态纯文字；不支持工具、图片/音频或续接会话。未知状态不代表可用或额度充足，不保证同账号、最便宜或健康。每次请求最多两次实际发送，兼容修复和备用共用上限，两次都可能计费；开始输出后不换源重放，全部等待时暂停。</p>` : ""}
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
