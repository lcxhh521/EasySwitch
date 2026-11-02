// Explicit migration only: opening or rendering this panel never reads external configuration.
"use strict";
let providerImportOpen = false;
let providerImportBusy = false;
let providerImportPhase = "";
let providerImportSources = new Set();
let providerImportChosen = new Set();
let providerImportPreview = null;
let providerImportMessage = "";
let providerImportGeneration = 0;
const providerImportSourceNames = {"cc-switch":"CC Switch",opencodex:"opencodex",opencode:"OpenCode 自定义 API 来源",environment:"环境变量",codex:"Codex 自定义来源",claude:"Claude Code 自定义来源"};
const providerImportSourceStatus = {ready:"只读扫描完成，尚未导入",missing:"默认位置没有配置文件",blocked:"无法安全读取或格式不支持，请退出来源工具后核对配置"};
function resetProviderImport(open) {
  providerImportGeneration++;
  providerImportOpen = open; providerImportBusy = false; providerImportPhase = "";
  providerImportSources = new Set(); providerImportChosen = new Set(); providerImportPreview = null; providerImportMessage = "";
}
function providerImportCard() {
  if (!providerImportOpen) return "";
  const candidates = providerImportPreview?.candidates ?? [];
  return `<section class="card form provider-import-panel"><div class="controls"><b>从其他工具导入</b><button class="btn secondary" type="button" data-provider-import-cancel>${providerImportBusy && providerImportPhase === "commit" ? "关闭（保存会继续）" : "取消"}</button></div>
    <p class="hint">先选择允许读取的配置来源，再逐项选择要导入的服务商。密钥不会显示；原工具的文件不会修改。导入后默认关闭，请核对地址和模型后再开启。</p>
    <form data-provider-import-scan><div class="controls">${Object.entries(providerImportSourceNames).map(([id,name])=>`<label><input type="checkbox" data-provider-import-source="${id}" ${providerImportSources.has(id)?"checked":""} ${providerImportBusy?"disabled":""}>${esc(name)}</label>`).join("")}</div><p class="hint">只读取各工具的默认位置；Codex 的环境变量密钥需要同时选择「环境变量」。不会读取原生登录文件或执行取密钥命令。</p>${providerImportSources.has("opencode") ? `<p class="hint" data-opencode-import-scope>OpenCode：仅读取 ~/.config/opencode/ 中的 opencode.json 或 opencode.jsonc；两者同时存在时不猜测合并，请先明确一份配置。仅支持 @ai-sdk/openai-compatible 自定义来源中的字面量 API Key、地址和模型 ID；模型显示名称不迁移，不代表 OpenCode 合并后的完整运行配置。不会读取 auth.json、订阅登录、项目配置或任意引用文件，不执行插件或命令，也不展开环境变量。额外请求头、模型映射或未支持的配置会说明原因，不会静默丢弃后导入。</p>` : ""}<button class="btn secondary" type="submit" ${providerImportBusy || !providerImportSources.size ? "disabled" : ""}>${providerImportPhase === "scan" ? "正在读取配置…" : "读取所选配置"}</button></form>
    ${providerImportMessage ? `<p class="msg" role="status">${esc(providerImportMessage)}</p>` : ""}
    ${providerImportPreview ? `<div>${(providerImportPreview.sources ?? []).map(source=>`<p class="hint">${esc(providerImportSourceNames[source.source] ?? "配置来源")}：${esc(providerImportSourceStatus[source.status] ?? providerImportSourceStatus.blocked)}</p>`).join("")}</div>
    <form data-provider-import-commit>${candidates.length ? candidates.map(c=>`<div class="row"><label><input type="checkbox" data-provider-import-candidate="${esc(c.id)}" ${providerImportChosen.has(c.id)?"checked":""} ${providerImportBusy || c.importable !== true?"disabled":""}>${esc(c.name)}</label><div class="grow"><div class="sub">${esc(providerImportSourceNames[c.source] ?? "配置来源")}${c.baseUrl ? ` · ${esc(c.baseUrl)}` : ""}</div><div class="hint">模型：${(c.models ?? []).map(m=>esc(m)).join("、") || "未配置，导入后请补充"} · 密钥 ${Number.isInteger(c.keyCount) && c.keyCount >= 0 ? c.keyCount : 0} 把</div>${c.importable !== true ? `<p class="msg bad">${esc(c.reason ?? "此项暂不支持导入，请手动核对。")}</p>` : ""}</div></div>`).join("") : `<p class="hint">没有找到可导入的配置。可以核对来源设置，或手动添加。</p>`}<button class="btn" type="submit" ${providerImportBusy || !providerImportChosen.size ? "disabled" : ""}>${providerImportPhase === "commit" ? "正在保存…" : `导入选中的 ${providerImportChosen.size} 项`}</button></form>` : ""}
    ${providerImportBusy && providerImportPhase === "commit" ? `<p class="hint">保存已开始。关闭窗口只隐藏此页面，保存仍会继续；不会自动检测模型。</p>` : ""}</section>`;
}
document.addEventListener("click", event => {
  const open = event.target.closest?.("[data-provider-import-open]");
  const cancel = event.target.closest?.("[data-provider-import-cancel]");
  if (!open && !cancel) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (open && providerImportBusy) return;
  resetProviderImport(Boolean(open)); render();
});
document.addEventListener("change", event => {
  const source = event.target.closest?.("[data-provider-import-source]");
  const candidate = event.target.closest?.("[data-provider-import-candidate]");
  if (!source && !candidate) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (!providerImportOpen || providerImportBusy || event.target.disabled) return;
  if (source) {
    const id = source.dataset.providerImportSource;
    if (!Object.hasOwn(providerImportSourceNames,id)) return;
    source.checked ? providerImportSources.add(id) : providerImportSources.delete(id);
    providerImportPreview = null; providerImportChosen.clear(); providerImportMessage = "";
  } else {
    const id = candidate.dataset.providerImportCandidate;
    if (!providerImportPreview?.candidates.some(c=>c.id===id && c.importable===true)) return;
    candidate.checked ? providerImportChosen.add(id) : providerImportChosen.delete(id);
  }
  render();
});
document.addEventListener("submit", async event => {
  const scan = event.target.matches?.("[data-provider-import-scan]");
  const commit = event.target.matches?.("[data-provider-import-commit]");
  if (!scan && !commit) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (!providerImportOpen || providerImportBusy || (scan ? !providerImportSources.size : !providerImportPreview || !providerImportChosen.size)) return;
  const generation = providerImportGeneration;
  const body = scan ? {sources:[...providerImportSources]} : {previewId:providerImportPreview.previewId,chosen:[...providerImportChosen]};
  providerImportBusy = true; providerImportPhase = scan ? "scan" : "commit"; providerImportMessage = "";
  if (scan) { providerImportPreview = null; providerImportChosen.clear(); }
  render();
  let saved = false;
  try {
    const result = await call("POST", `/api/provider-import/${scan ? "preview" : "commit"}`, body);
    if (generation !== providerImportGeneration) return;
    if (scan) {
      if (!result || typeof result.previewId !== "string" || !Array.isArray(result.candidates) || !Array.isArray(result.sources)) throw new Error("Invalid import preview");
      providerImportPreview = result; providerImportChosen.clear();
    } else {
      providerImportPreview = null; providerImportChosen.clear();
      if (Array.isArray(result.failed) && result.failed.length) providerImportMessage = result.rolledBack === true ? "保存失败，本次新增来源和密钥已回滚。请重新读取配置后再试。" : "保存失败，部分清理未能确认。请检查本次新增来源和钥匙串，再重新读取配置。";
      else if (Array.isArray(result.imported) && result.imported.length) { providerImportMessage = `已导入 ${result.imported.length} 个来源，均保持关闭。请在来源列表核对地址和模型，再决定是否开启。`; saved = true; }
      else providerImportMessage = "没有导入任何来源。请重新读取配置并选择。";
    }
  } catch (error) {
    if (generation !== providerImportGeneration) return;
    if (commit) { providerImportPreview = null; providerImportChosen.clear(); }
    providerImportMessage = error?.status === 409 ? "预览已失效或来源发生变化，请点击「读取所选配置」重新确认。" : commit ? "导入结果未确认，来源或密钥可能已经保存。请先检查来源列表与钥匙串，不要直接重复导入；核对后再重新读取配置。" : userErrorMessage(error);
  } finally {
    if (generation === providerImportGeneration) {
      providerImportBusy = false; providerImportPhase = ""; render();
      if (saved) { try { await refresh(true); } catch { /* The saved result remains visible until the next ordinary refresh. */ } }
    }
  }
});
