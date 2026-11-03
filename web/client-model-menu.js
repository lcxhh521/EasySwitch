"use strict";
// User-edited console menus. Only the explicitly documented Codex CLI adapter also
// applies this menu to its next private enhanced session; this is not routing ACL.
let clientMenuEditor = null;
let clientMenuApplying = false;
const menuId = value => typeof value === 'string' && value.length <= 512 && value === value.trim() && value.indexOf('/') > 0 && value.indexOf('/') < value.length - 1 && !/[\p{C}\u2028\u2029]/u.test(value);
const menuList = value => value === null || Array.isArray(value) && value.length <= 80 && value.every(menuId) && new Set(value).size === value.length;
function validClientMenu(data, id, preview = false) {
  const strings = v => Array.isArray(v) && v.every(x=>typeof x==='string');
  return !!data && data.agentId===id && menuList(data.modelMenu) && /^[a-f0-9]{64}$/.test(data.baseGuard) &&
    Array.isArray(data.selectable) && data.selectable.length<=10000 && data.selectable.every(x=>x && menuId(x.id) && typeof x.providerName==='string' && typeof x.model==='string') && new Set(data.selectable.map(x=>x.id)).size===data.selectable.length &&
    Array.isArray(data.entries) && data.entries.length<=10000 && data.entries.every(x=>x && menuId(x.id) && typeof x.selectable==='boolean') &&
    data.scope && ['console-only','codex-next-enhanced-session'].includes(data.scope.kind) && typeof data.scope.description==='string' &&
    Array.isArray(data.requiredRetained) && data.requiredRetained.length<=1000 && data.requiredRetained.every(x=>x && menuId(x.id) && strings(x.reasons)) &&
    Array.isArray(data.effectiveModelMenu) && data.effectiveModelMenu.length<=10000 && data.effectiveModelMenu.every(menuId) && strings(data.warnings) &&
    (!preview || menuList(data.before) && typeof data.changed==='boolean' && /^[a-f0-9]{64}$/.test(data.previewGuard));
}
function cancelClientMenu() {
  clientMenuEditor?.controller?.abort();
  clientMenuEditor=null;
}
function clientMenuCurrent(editor) {return clientMenuEditor===editor && page==='agents' && selectedAgent===editor.id && pageNavigationVersion===editor.navigation;}
async function clientMenuRead(editor, method, suffix='', body) {
  const controller=new AbortController();editor.controller=controller;
  let timer;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('timeout'));},15000);});
  try{return await Promise.race([call(method,`/api/agents/${encodeURIComponent(editor.id)}/model-menu${suffix}`,body,{signal:controller.signal}).then(data=>{if(controller.signal.aborted)throw Error('aborted');return data;}),deadline]);}
  finally{clearTimeout(timer);if(editor.controller===controller)editor.controller=null;}
}
async function openClientMenu(id) {
  if(clientMenuApplying || page!=='agents' || selectedAgent!==id || !/^[a-z0-9-]+$/.test(id))return;
  cancelClientMenu();
  const editor={id,navigation:pageNavigationVersion,loading:true,data:null,draft:null,preview:null,error:'',search:''};clientMenuEditor=editor;render();
  try{const data=await clientMenuRead(editor,'GET');if(!clientMenuCurrent(editor))return;if(!validClientMenu(data,id))throw Error('invalid');editor.data=data;editor.draft=data.modelMenu===null?null:[...data.modelMenu];}
  catch{if(clientMenuCurrent(editor))editor.error='无法读取当前短名单。尚未保存任何设置，请重新读取。';}
  finally{if(clientMenuCurrent(editor)){editor.loading=false;render();if(!document.activeElement || document.activeElement===document.body)document.querySelector('[data-menu-heading]')?.focus({preventScroll:true});}}
}
function focusClientMenu(selector, attribute, value) {
  // Only replace focus lost to our own redraw; never steal a later user choice.
  if(document.activeElement && document.activeElement!==document.body)return;
  const target=attribute ? [...document.querySelectorAll(selector)].find(node=>node.getAttribute(attribute)===value) : document.querySelector(selector);
  target?.focus({preventScroll:true});
}
function menuOrderedText(items) {return items===null?'全部可选模型':items.length?items.join(' → '):'空短名单（不额外列出模型）';}
function clientMenuCandidates(editor) {
  if(!editor.data || editor.draft===null)return '';
  const q=editor.search.trim().toLowerCase(),have=new Set(editor.draft);
  const matches=editor.data.selectable.filter(x=>!have.has(x.id)&&(!q||`${x.id} ${x.providerName}`.toLowerCase().includes(q)));
  return matches.slice(0,100).map(x=>`<li><span>${esc(x.providerName)} · ${esc(x.model)}</span><button class="btn secondary" data-menu-add="${esc(x.id)}" ${editor.draft.length>=80?'disabled':''}>添加</button></li>`).join('')+(matches.length>100?'<li class="hint">仅显示前100项，请搜索缩小范围。</li>':'') || '<li class="hint">没有匹配的可添加模型。</li>';
}
function clientMenuCard(id) {
  const e=clientMenuEditor;
  const current=state?.prefs?.[id]?.modelMenu;
  const summary=Array.isArray(current)?`${current.length} 项自定义短名单`:'全部模型';
  if(!e || e.id!==id)return `<section class="client-detail-section client-menu"><h3 tabindex="-1" data-menu-summary>模型短名单</h3><p class="hint">${esc(summary)}。只管理菜单，不修改主模型、备用或辅助配置。</p><button class="btn secondary" data-menu-open="${esc(id)}" ${clientMenuApplying?'disabled':''}>编辑模型短名单</button></section>`;
  const locked=e.loading||e.busy||clientMenuApplying;
  const close=`<button class="btn secondary" data-menu-cancel>${clientMenuApplying?"关闭（保存结果需核对）":"取消并关闭"}</button>`;
  if(e.loading)return `<section class="client-detail-section client-menu" aria-live="polite"><h3>正在读取短名单…</h3>${close}</section>`;
  if(!e.data || e.error)return `<section class="client-detail-section client-menu"><h3 tabindex="-1" data-menu-heading>模型短名单</h3><p role="status">${esc(e.error)}</p><button class="btn" data-menu-reload="${esc(id)}" ${clientMenuApplying?'disabled':''}>重新读取当前设置</button>${close}</section>`;
  const d=e.data,p=e.preview;
  let contents;
  if(p)contents=`<h4 tabindex="-1" data-menu-review-heading>确认保存以下菜单设置？</h4><div class="menu-preview"><div><b>现在</b><p>${esc(menuOrderedText(p.before))}</p></div><div><b>保存后</b><p>${esc(menuOrderedText(p.modelMenu))}</p></div></div><p class="hint">${esc(p.scope.description)}</p>${p.requiredRetained.length?`<p>Codex 下一次增强目录仍需保留：</p><ul>${p.requiredRetained.map(x=>`<li>${esc(x.id)} · ${esc(x.reasons.join('；'))}</li>`).join('')}</ul>`:''}<details data-keep="menu-effective-${esc(id)}" ${keepOpen(`menu-effective-${id}`)}><summary>查看生效顺序（${p.effectiveModelMenu.length} 项）</summary><p>${esc(p.effectiveModelMenu.join(' → ')||'没有额外模型')}</p></details>${p.warnings.map(w=>`<p class="hint">${esc(w)}</p>`).join('')}<button class="btn" data-menu-confirm ${locked?'disabled':''}>${clientMenuApplying?'正在保存…':'确认保存短名单'}</button><button class="btn secondary" data-menu-edit ${locked?'disabled':''}>返回编辑</button>`;
  else contents=`<p class="hint">${esc(d.scope.description)} 保存不启动客户端，不读取密钥、不发模型请求。最多80项，顺序就是菜单顺序。</p><div class="controls"><button class="btn secondary" data-menu-custom ${locked?'disabled':''}>自定义短名单</button><button class="btn secondary" data-menu-all ${locked?'disabled':''}>恢复全部模型</button></div><p role="status">${e.draft===null?'当前草稿：全部模型':'当前草稿：自定义 '+e.draft.length+' 项'}</p>${e.draft===null?'':`<ol class="menu-selected">${e.draft.map((id,index)=>`<li><span>${esc(id)}${d.selectable.some(x=>x.id===id)?'':' · 当前不可选，仍保留'}</span><div class="controls"><button class="btn secondary" data-menu-up="${esc(id)}" ${locked||index===0?'disabled':''} aria-label="上移 ${esc(id)}">↑</button><button class="btn secondary" data-menu-down="${esc(id)}" ${locked||index===e.draft.length-1?'disabled':''} aria-label="下移 ${esc(id)}">↓</button><button class="btn secondary" data-menu-remove="${esc(id)}" ${locked?'disabled':''}>移除</button></div></li>`).join('')||'<li class="hint">空短名单不会自动恢复全部模型；主模型等必要项按预览说明保留。</li>'}</ol><label>搜索可添加模型<input data-menu-search value="${esc(e.search)}" autocomplete="off" ${locked?'disabled':''}></label><ul class="menu-candidates" data-menu-candidates>${clientMenuCandidates(e)}</ul>`}<button class="btn" data-menu-preview ${locked?'disabled':''}>${e.busy?'正在预览…':'预览保存影响'}</button>`;
  return `<section class="client-detail-section client-menu" aria-label="模型短名单编辑"><h3 tabindex="-1" data-menu-heading>编辑 ${esc(id)} 的短名单</h3>${contents}${close}</section>`;
}
async function previewClientMenu() {
  const e=clientMenuEditor;if(!e?.data||!clientMenuCurrent(e)||e.busy||clientMenuApplying)return;
  e.busy=true;e.preview=null;render();const draft=e.draft===null?null:[...e.draft];
  try{const data=await clientMenuRead(e,'POST','/preview',{modelMenu:draft,baseGuard:e.data.baseGuard});if(!clientMenuCurrent(e))return;if(!validClientMenu(data,e.id,true)||JSON.stringify(data.modelMenu)!==JSON.stringify(draft)||data.baseGuard!==e.data.baseGuard||JSON.stringify(data.before)!==JSON.stringify(e.data.modelMenu))throw Error('invalid');e.preview=data;}
  catch(error){if(clientMenuCurrent(e))e.error=error?.status===409?'设置或目录已变化，请重新读取并编辑；尚未保存短名单。':'无法确认预览，尚未保存短名单，请重新读取。';}
  finally{if(clientMenuCurrent(e)){e.busy=false;render();focusClientMenu(e.preview?'[data-menu-review-heading]':'[data-menu-heading]');}}
}
async function applyClientMenu() {
  const e=clientMenuEditor;if(!e?.preview||!clientMenuCurrent(e)||e.busy||clientMenuApplying)return;
  const p=e.preview;if(!validClientMenu(p,e.id,true))return;
  clientMenuApplying=true;e.busy=true;render();
  try{const result=await clientMenuRead(e,'POST','/apply',{modelMenu:p.modelMenu,baseGuard:p.baseGuard,previewGuard:p.previewGuard});if(!clientMenuCurrent(e))return;if(!result?.ok||!validClientMenu(result,e.id)||JSON.stringify(result.modelMenu)!==JSON.stringify(p.modelMenu))throw Error('invalid');e.data=result;e.draft=result.modelMenu===null?null:[...result.modelMenu];e.preview=null;
    if(state){state.prefs??={};const pref={...(state.prefs[e.id]??{})};if(result.modelMenu===null)delete pref.modelMenu;else pref.modelMenu=[...result.modelMenu];state.prefs[e.id]=pref;}toast('短名单已保存，主模型设置未改变。');}
  catch(error){if(clientMenuCurrent(e)){e.preview=null;e.error=error?.status===409?'设置已变化，此预览未应用。请重新读取当前设置。':'保存结果尚未确认。请重新读取当前设置核对，不要直接重复提交。';}}
  finally{clientMenuApplying=false;if(clientMenuCurrent(e)){e.busy=false;render();focusClientMenu('[data-menu-heading]');}}
}
document.addEventListener('input',event=>{if(!event.target.matches?.('[data-menu-search]'))return;const e=clientMenuEditor;if(!e||!clientMenuCurrent(e)||e.busy||clientMenuApplying)return;e.search=event.target.value;const host=document.querySelector('[data-menu-candidates]');if(host)host.innerHTML=clientMenuCandidates(e);});
document.addEventListener('click',async event=>{
  const button=event.target.closest?.('[data-menu-open], [data-menu-reload], [data-menu-cancel], [data-menu-preview], [data-menu-confirm], [data-menu-edit], [data-menu-all], [data-menu-custom], [data-menu-add], [data-menu-remove], [data-menu-up], [data-menu-down]');if(!button)return;
  event.preventDefault();event.stopImmediatePropagation();if(button.disabled)return;
  if(button.hasAttribute('data-menu-cancel')){const id=clientMenuEditor?.id;if(clientMenuApplying)toast('保存结果尚未确认，请重新打开短名单核对，不要重复提交。');cancelClientMenu();render();if(page==='agents'&&selectedAgent===id)focusClientMenu(clientMenuApplying?'[data-menu-summary]':'[data-menu-open]',clientMenuApplying?undefined:'data-menu-open',id);return;}
  if(clientMenuApplying)return;
  if(button.dataset.menuOpen||button.dataset.menuReload){await openClientMenu(button.dataset.menuOpen||button.dataset.menuReload);return;}
  const e=clientMenuEditor;if(!e?.data||!clientMenuCurrent(e)||e.loading||e.busy)return;
  if(button.hasAttribute('data-menu-preview')){await previewClientMenu();return;}
  if(button.hasAttribute('data-menu-confirm')){await applyClientMenu();return;}
  if(button.hasAttribute('data-menu-edit'))e.preview=null;
  else if(button.hasAttribute('data-menu-all')){e.draft=null;e.preview=null;}
  else if(button.hasAttribute('data-menu-custom')){if(e.draft===null)e.draft=[];e.preview=null;}
  else if(Array.isArray(e.draft)){
    const id=button.dataset.menuAdd||button.dataset.menuRemove||button.dataset.menuUp||button.dataset.menuDown;
    if(button.dataset.menuAdd){if(e.draft.length<80&&!e.draft.includes(id)&&e.data.selectable.some(x=>x.id===id))e.draft.push(id);}
    else {const at=e.draft.indexOf(id);if(at<0)return;if(button.dataset.menuRemove)e.draft.splice(at,1);else{const to=at+(button.dataset.menuUp?-1:1);if(to>=0&&to<e.draft.length)[e.draft[at],e.draft[to]]=[e.draft[to],e.draft[at]];}}
    e.preview=null;
  }
  render();
  if(clientMenuCurrent(e)){if(button.dataset.menuAdd)focusClientMenu('[data-menu-remove]','data-menu-remove',button.dataset.menuAdd);else if(button.dataset.menuRemove||button.hasAttribute('data-menu-edit'))focusClientMenu(e.draft===null?'[data-menu-heading]':'[data-menu-search]');}
});
