// Explicit source catalog lookup, never an inference test or an automatic refresh.
"use strict";
let catalogReview = null;
let catalogFlight = null;
let catalogApplying = false;
function cancelCatalogReview() {
  catalogFlight?.controller.abort();
  catalogFlight = null;
  catalogReview = null;
}
function catalogSupported(p) { return p && !p.plan && !p.mimoFree && !p.vertex && !p.kiro && !p.antigravity && !p.cursor && !p.kimi && !p.cliTextBridge; }
function validCatalogPreview(d) {
  const list = (a, limit=500) => Array.isArray(a) && a.length <= limit && a.every(s => typeof s === "string" && s.length > 0 && s.length <= 512 && !/[\u0000-\u001f\u007f]/.test(s)) && new Set(a).size === a.length;
  return d && typeof d.token === "string" && d.token.length >= 16 && d.token.length <= 256 && Number.isFinite(Date.parse(d.expiresAt)) && Date.parse(d.expiresAt) > Date.now() && list(d.added) && list(d.existing) && list(d.missing,10000) && Number.isSafeInteger(d.discoveredCount) && d.discoveredCount >= 0 && d.discoveredCount <= 500 && d.limit === 500 && d.added.length + d.existing.length === d.discoveredCount && !d.added.some(s => d.existing.includes(s) || d.missing.includes(s)) && !d.existing.some(s => d.missing.includes(s));
}
function catalogReviewHtml(p) {
  if (!catalogSupported(p)) return "";
  const review = catalogReview?.id === p.id ? catalogReview : null;
  const busy = catalogApplying || !!catalogFlight;
  let content = "";
  if (review?.loading) content = '<p role="status">正在向此来源读取模型目录…</p>';
  else if (review?.error) content = `<p role="status">${esc(review.error)}</p>`;
  else if (review?.data) {
    const d = review.data;
    content = `<h4 tabindex="-1" data-catalog-heading>目录预览：${d.added.length} 个新模型</h4>
      <p class="hint">已配置 ${d.existing.length} 个；本次未列出但仍保留 ${d.missing.length} 个。目录最多读取 500 条，不代表完整目录或可调用验证。不会删除旧模型、切换默认模型或修改协议。</p>
      <div class="catalog-models">${d.added.map((m,i) => `<label><input type="checkbox" data-catalog-select="${i}" ${review.selected.has(m) ? "checked" : ""} ${catalogApplying ? "disabled" : ""}><span class="mono">${esc(m)}</span></label>`).join("") || '<p>没有发现需要添加的新模型。</p>'}</div>
      ${d.missing.length ? `<details><summary>本次未列出，继续保留</summary><div class="catalog-models">${d.missing.map(m=>`<span class="mono">${esc(m)}</span>`).join("")}</div></details>` : ""}
      <button class="btn" data-catalog-apply ${catalogApplying || !review.selected.size ? "disabled" : ""}>${catalogApplying ? "正在添加…" : `确认添加所选 ${review.selected.size} 个模型`}</button>`;
  }
  return `<section class="catalog-review"><div class="controls"><button class="btn secondary" data-catalog-preview ${busy ? "disabled" : ""}>${review ? "重新读取目录" : "刷新模型目录"}</button>${review ? `<button class="btn secondary" data-catalog-cancel ${catalogApplying ? "disabled" : ""}>取消</button>` : ""}</div><p class="hint">仅向此来源查询模型列表，不发送对话或测试推理。使用第一把已启用 Key（无 Key 列表时使用来源凭据），不轮换或重试；厂商的访问与计费规则仍适用。预览后勾选确认才添加。</p>${content}</section>`;
}
async function previewCatalog(id) {
  if (catalogApplying || catalogFlight || page !== "providers" || !catalogSupported(state?.providers?.find(p=>p.id===id))) return;
  cancelCatalogReview();
  const flight = {controller:new AbortController(), navigation:pageNavigationVersion};
  catalogFlight = flight; catalogReview = {id,loading:true}; render();
  const current = () => catalogFlight === flight && flight.navigation === pageNavigationVersion && page === "providers" && openProvider === id;
  const timer = setTimeout(()=>flight.controller.abort(), 20000);
  try {
    const data = await call("POST", `/api/providers/${encodeURIComponent(id)}/catalog-preview`, {}, {signal:flight.controller.signal});
    if (!current()) return;
    if (flight.controller.signal.aborted || !validCatalogPreview(data)) throw new Error("invalid preview");
    catalogReview = {id,data,selected:new Set()};
  } catch (_) { if(current()) catalogReview={id,error:"无法读取有效目录，尚未添加模型。请重新读取；检查来源或凭据设置。"}; }
  finally {clearTimeout(timer);if(current()){catalogFlight=null;render();document.querySelector("[data-catalog-heading]")?.focus();}}
}
async function applyCatalog() {
  const review = catalogReview;
  if(catalogApplying || catalogFlight || !review?.data || !review.selected?.size || page!=="providers" || openProvider!==review.id) return;
  if(!validCatalogPreview(review.data)){catalogReview={id:review.id,error:"目录预览已失效，请重新读取。尚未发送添加请求。"};render();return;}
  const models=[...review.selected];
  if(models.some(m=>!review.data.added.includes(m))) return;
  const navigation=pageNavigationVersion;catalogApplying=true;render();
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),20000);
  try {
    await call("POST",`/api/providers/${encodeURIComponent(review.id)}/catalog-apply`,{token:review.data.token,models},{signal:controller.signal});
    if(controller.signal.aborted) throw new Error("confirmation timed out");
    if(catalogReview===review && navigation===pageNavigationVersion){catalogReview=null;toast(`已添加 ${models.length} 个模型；默认模型和已有配置保持不变`);}
  } catch(error) {
    if(catalogReview===review && navigation===pageNavigationVersion) catalogReview={id:review.id,error:error?.status===409 ? "来源或凭据已变化，或预览已过期；请重新读取后确认。" : "未能确认添加结果，请刷新来源检查，再重新读取目录；不要重复提交旧预览。"};
  } finally {clearTimeout(timer);catalogApplying=false;if(navigation===pageNavigationVersion && page==="providers"){render();await refresh(true);}}
}
document.addEventListener("click",async e=>{
  const t=e.target;
  if(t.closest("[data-catalog-cancel]")){if(!catalogApplying){cancelCatalogReview();render();document.querySelector("[data-catalog-preview]")?.focus();}return;}
  if(t.closest("[data-catalog-preview]")){const id=t.closest("[data-provider]")?.dataset.provider;if(id)await previewCatalog(id);return;}
  if(t.closest("[data-catalog-apply]"))await applyCatalog();
});
document.addEventListener("change",e=>{
  const input=e.target.closest("[data-catalog-select]");if(!input||catalogApplying||!catalogReview?.data)return;
  const model=catalogReview.data.added[Number(input.dataset.catalogSelect)];if(model===undefined)return;
  if(input.checked)catalogReview.selected.add(model);else catalogReview.selected.delete(model);
  const button=document.querySelector("[data-catalog-apply]");if(button){button.disabled=!catalogReview.selected.size;button.textContent=`确认添加所选 ${catalogReview.selected.size} 个模型`;}
});
