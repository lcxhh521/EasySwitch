// Local catalogue suggestions; creating a pool always requires an explicit click.
"use strict";
let poolSuggestionBusy = false;
let poolSuggestionMessage = "";
function poolSuggestionsCard() {
  const suggestions = state?.poolSuggestions ?? [];
  return `${poolSuggestionMessage ? `<p class="msg" role="status">${esc(poolSuggestionMessage)}</p>` : ""}${suggestions.map(s => `<div class="row"><div class="grow"><div class="title">${esc(s.model)}</div><div class="sub">这些来源都有同名模型：${s.members.map(m => esc(m.providerName)).join("、")}。合成一个池子，一个挂了自动换下一个？</div><div class="hint">仅按目录名称匹配，实际能力和费用请核对；建好后仍可编辑或删除。</div></div><button class="btn secondary" data-pool-suggestion="${esc(s.id)}" data-pool-action="apply" ${poolSuggestionBusy ? "disabled" : ""}>合成模型池</button><button class="btn secondary" data-pool-suggestion="${esc(s.id)}" data-pool-action="dismiss" ${poolSuggestionBusy ? "disabled" : ""}>不用</button></div>`).join("")}`;
}
document.addEventListener("click", async event => {
  const target = event.target.closest?.("[data-pool-suggestion]");
  if (!target) return;
  event.preventDefault(); event.stopImmediatePropagation();
  const { poolSuggestion: id, poolAction: action } = target.dataset;
  if (poolSuggestionBusy || target.disabled || !/^pool-suggestion-[a-f0-9]{24}$/.test(id ?? "") || !["apply", "dismiss"].includes(action)) return;
  poolSuggestionBusy = true; poolSuggestionMessage = ""; render();
  try {
    await call("POST", `/api/pools/suggestions/${id}/${action}`, {});
    toast(action === "apply" ? "模型池已创建，可以继续编辑成员和顺序。" : "已记住，这个模型不再提示合池。");
  } catch (error) { poolSuggestionMessage = error.status === 409 ? "建议已变化或已处理，请刷新后核对。" : userErrorMessage(error); }
  finally { poolSuggestionBusy = false; await refresh(true); }
});
