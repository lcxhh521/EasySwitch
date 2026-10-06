// Ratings stay in the local task book. Suggestions are observed estimates, never automatic routing changes.
"use strict";
let suggestionReport = null;
let suggestionMessage = "";
let suggestionSaving = false;
const feedbackSaving = new Set();
async function loadSuggestions() {
  try {suggestionReport=await call("GET","/api/rules/suggestions");suggestionMessage="";}
  catch(error){suggestionReport=null;suggestionMessage=userErrorMessage(error);}
}
function taskFeedbackControls(task) {
  if(task.status==="running")return "";
  const rating=task.feedback?.rating;
  return `<details class="task-feedback" style="padding:0 18px 10px"><summary class="hint">${rating ? rating==="good"?"已评价：好":"已评价：不好" : "评价这次结果（可选）"}</summary><div class="controls"><button class="btn ${rating==="good"?"":"secondary"}" data-task-feedback="${esc(task.id)}" data-rating="good" aria-pressed="${rating==="good"}" ${feedbackSaving.has(task.id)?"disabled":""}>好</button><button class="btn ${rating==="bad"?"":"secondary"}" data-task-feedback="${esc(task.id)}" data-rating="bad" aria-pressed="${rating==="bad"}" ${feedbackSaving.has(task.id)?"disabled":""}>不好</button>${rating?`<button class="btn secondary" data-task-feedback="${esc(task.id)}" data-rating="clear" ${feedbackSaving.has(task.id)?"disabled":""}>取消评价</button>`:""}</div><p class="hint">只记录本机任务标识和评价，不另存提示词或回答副本。</p></details>`;
}
function taskAccountingNotice() {
  const a=taskList?.accounting;if(!a)return "";
  const message=a.failureUnrecorded?"任务费用和故障状态都无法保存，请暂停派活并检查磁盘，不能把当前费用当作完整记录。":!a.available?"任务费用记录暂不可用；费用保持未知，请检查本机数据目录，不要删除旧记录来跳过问题。":a.capacityReached?`归因簿已达到 ${a.capacity??5000} 个任务的登记容量（含子任务）；旧记录保留，新任务费用将标为未知，不能参加价格建议。`:"";
  return message?`<div class="card msg" role="status">${esc(message)} <button class="btn secondary" data-go="doctor">查看自检</button></div>`:"";
}
function ruleSuggestionsCard() {
  if(suggestionMessage)return `<p class="msg">${esc(suggestionMessage)}</p>`;
  const report=suggestionReport;if(!report?.evaluatedRatings)return "";
  if(!report.suggestions?.length){const reasons=[...new Set((report.insufficient??[]).map(i=>i.message))].slice(0,8);return `<details class="card" style="padding:12px"><summary>建议还需要更多依据</summary><p class="hint">每个候选至少需要五次带评价且费用完整的可比较任务；没有满足条件时不会生成规则。</p>${reasons.map(r=>`<p class="hint">${esc(r)}</p>`).join("")}</details>`;}
  return `<div class="section-head"><h2>派活建议</h2><span class="aside">先看依据，再决定是否采用</span></div>${report.suggestions.map(s=>`<div class="card" style="padding:16px"><h3>${esc(s.summary)}</h3><p>目前：${esc(s.evidence.baseline.target.agent)} / ${esc(s.evidence.baseline.target.model)} · ${esc(s.evidence.baseline.samples)}次评价，${esc(s.evidence.baseline.good)}次好评，中位估算${esc(money(s.evidence.baseline.medianCostUsd))}。</p><p>候选：${esc(s.evidence.candidate.target.agent)} / ${esc(s.evidence.candidate.target.model)} · ${esc(s.evidence.candidate.samples)}次评价，${esc(s.evidence.candidate.good)}次好评，中位估算${esc(money(s.evidence.candidate.medianCostUsd))}。</p><ul class="hint">${s.caveats.map(c=>`<li>${esc(c)}</li>`).join("")}</ul><p class="hint">只比较最近三个月内的可核对任务；归因簿登记容量为五千个任务（含子任务），达到后新任务费用未知，旧记录不删除。生成的规则会放在原分类规则前面，你仍能编辑或停用。</p><button class="btn" data-suggestion-apply="${esc(s.id)}" ${suggestionSaving?"disabled":""}>生成这条规则</button></div>`).join("")}`;
}
document.addEventListener("click",async e=>{
 const rating=e.target.closest?.("[data-task-feedback]"),apply=e.target.closest?.("[data-suggestion-apply]");if(!rating&&!apply)return;e.preventDefault();e.stopImmediatePropagation();
 if(rating){const id=rating.dataset.taskFeedback;if(feedbackSaving.has(id))return;const value=rating.dataset.rating;if(!["good","bad","clear"].includes(value))return;feedbackSaving.add(id);
  try{await call("PUT",`/api/tasks/${encodeURIComponent(id)}/feedback`,{rating:value==="clear"?null:value});await loadSuggestions();}
  catch(error){showError(error);}finally{feedbackSaving.delete(id);await refresh(true);}return;
 }
 if(suggestionSaving)return;suggestionSaving=true;
 try{await call("POST",`/api/rules/suggestions/${encodeURIComponent(apply.dataset.suggestionApply)}/apply`,{});await loadSuggestions();toast("规则已生成，可以继续编辑或停用。");}
 catch(error){if(error.status===409)suggestionMessage="建议已变化或不再适用；请刷新后查看最新依据。";else showError(error);}
 finally{suggestionSaving=false;await refresh(true);}
});
