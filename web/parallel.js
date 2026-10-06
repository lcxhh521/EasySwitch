// The current production registry is deliberately disabled; only bounded fake transports are executable.
"use strict";
let parallelState = null;
let parallelBusy = false;
let parallelMessage = "";
let parallelDraft = {task:"",kind:"explain",selected:[]};
async function loadParallel() {
  try {parallelState=await call("GET","/api/task-groups");}
  catch(error){parallelMessage=userErrorMessage(error);}
}
function parallelCard() {
  const caps=parallelState?.capabilities??[], groups=parallelState?.groups??[];
  const enabled=caps.filter(c=>c.enabled===true&&c.execution==="fixture-relay");
  const childHtml=(child,group)=>{
    const t=child.task, price=child.unknownCost?"费用未知":money(child.costUsd??0);
    return `<section class="card" style="padding:12px;min-width:220px;flex:1"><h4>${esc(agentMeta(t.agent).name)} · ${esc(t.model)}</h4><p class="hint">${esc(TASK_STATUS[t.status]?.[0]??t.status)} · ${esc(price)} · 模拟通道</p><pre style="white-space:pre-wrap;max-height:300px;overflow:auto">${esc(t.output??"等待结果…")}</pre>${t.status==="done"&&group.children.filter(c=>c.task.status==="done").length>1?`<button class="btn secondary" data-parallel-review="${esc(t.id)}" data-parallel-group="${esc(group.id)}" ${parallelBusy?"disabled":""}>让它审查另外的结果</button>`:""}</section>`;
  };
  const reviews=g=>(g.reviews??[]).map(r=>`<div class="card" style="padding:12px"><h4>交叉审查 · ${esc(agentMeta(r.task.agent).name)} · ${esc(r.task.model)}</h4>${r.comparison?`<b>相同点</b><ul>${r.comparison.agreements.map(x=>`<li>${esc(x)}</li>`).join("")}</ul><b>不同点</b><ul>${r.comparison.differences.map(x=>`<li>${esc(x)}</li>`).join("")}</ul><p>建议采纳 ${esc(r.comparison.recommendation.taskId)}：${esc(r.comparison.recommendation.reason)}</p>`:`<pre style="white-space:pre-wrap">${esc(r.task.output??"正在审查…")}</pre>`}<p class="hint">${r.unknownCost?"费用未知":esc(money(r.costUsd??0))}</p></div>`).join("");
  return `<details class="card" data-keep="parallel-tasks" ${keepOpen("parallel-tasks")} style="padding:16px"><summary>多个 Agent 一起做 <span class="chip warn">生产适配待验收</span></summary><p>仅面向解释、方案、代码审查和找问题等只读文字任务；不接受工作目录、文件写入、代码执行或工具权限。</p><p class="hint">当前真实 Agent 都未开放并行运行：尚无经过验证的无写入、无代码执行适配器。普通启动器或提示词不能代替隔离；以下模拟测试结果不代表真实 Agent 已可用。</p>
    <form data-parallel-form class="form"><textarea name="task" rows="3" placeholder="写明只读任务；本页不会读取你的项目文件" ${parallelBusy?"disabled":""}>${esc(parallelDraft.task)}</textarea><select name="kind">${Object.entries({explain:"解释",plan:"方案",review:"代码审查","find-issues":"找问题"}).map(([id,label])=>`<option value="${id}" ${parallelDraft.kind===id?"selected":""}>${label}</option>`).join("")}</select>
    <div>${caps.map(c=>`<label style="display:block;margin:8px 0"><input type="checkbox" name="agent" value="${esc(c.agent)}" ${parallelDraft.selected.some(x=>x.agent===c.agent)?"checked":""} ${!c.enabled||parallelBusy?"disabled":""}>${esc(agentMeta(c.agent).name)} ${!c.enabled?"· 暂不可用":"· 模拟通道"}${c.enabled?` <select name="model:${esc(c.agent)}">${c.models.map(m=>`<option value="${esc(m)}" ${parallelDraft.selected.some(s=>s.agent===c.agent&&s.model===m)?"selected":""}>${esc(m)}</option>`).join("")}</select>`:""}</label>`).join("")}</div><button class="btn" type="submit" ${enabled.length<2||parallelBusy?"disabled":""}>同时派给所选程序</button></form>
    ${parallelMessage?`<p class="msg" role="status">${esc(parallelMessage)}</p>`:""}
    ${groups.map(g=>`<div style="margin-top:18px"><div class="section-head"><h3>${esc(g.task)}</h3>${g.status==="running"?`<button class="btn secondary" data-parallel-stop="${esc(g.id)}">停止这组</button>`:""}</div><div style="display:flex;gap:10px;overflow-x:auto">${g.children.map(c=>childHtml(c,g)).join("")}</div>${reviews(g)}</div>`).join("")}
    <p class="hint">深度最多两层；普通后台任务、并行任务和交叉审查共用三个运行名额。分组只在本次服务进程保留，子任务记录保存在本机；重启后不能继续原组审查。</p></details>`;
}
document.addEventListener("submit",async e=>{
 if(!e.target.matches?.("[data-parallel-form]"))return;e.preventDefault();e.stopImmediatePropagation();if(parallelBusy)return;
 const f=new FormData(e.target), ids=f.getAll("agent").map(String);const task=String(f.get("task")??"").trim();const kind=String(f.get("kind")??"explain");
 const selected=ids.map(agent=>({agent,model:String(f.get(`model:${agent}`)??"")}));parallelDraft={task,kind,selected};
 if(ids.length<2||ids.length>3||!task){parallelMessage="请填写只读任务，并选择两个或三个已开放的程序。";render();return;}
 if(selected.some(s=>!parallelState?.capabilities?.some(c=>c.agent===s.agent&&c.enabled&&c.models.includes(s.model)))){parallelMessage="所选程序没有受限只读适配器，未启动任何任务。";render();return;}
 parallelBusy=true;parallelMessage="";render();
 try{await call("POST","/api/task-groups",{task,kind,selections:selected});await loadParallel();}
 catch(error){parallelMessage=userErrorMessage(error);}
 finally{parallelBusy=false;render();}
});
document.addEventListener("click",async e=>{
 const review=e.target.closest?.("[data-parallel-review]"),stop=e.target.closest?.("[data-parallel-stop]");if(!review&&!stop)return;
 e.preventDefault();e.stopImmediatePropagation();if(parallelBusy)return;parallelBusy=true;
 try{const path=review?`/api/task-groups/${encodeURIComponent(review.dataset.parallelGroup)}/review/${encodeURIComponent(review.dataset.parallelReview)}`:`/api/task-groups/${encodeURIComponent(stop.dataset.parallelStop)}/stop`;await call("POST",path,{});await loadParallel();}
 catch(error){parallelMessage=userErrorMessage(error);}
 finally{parallelBusy=false;render();}
});

for(const name of ["input","change"])document.addEventListener(name,e=>{const form=e.target.closest?.("[data-parallel-form]");if(!form||parallelBusy)return;const f=new FormData(form);parallelDraft={task:String(f.get("task")??""),kind:String(f.get("kind")??"explain"),selected:f.getAll("agent").map(String).map(agent=>({agent,model:String(f.get(`model:${agent}`)??"")}))};});
