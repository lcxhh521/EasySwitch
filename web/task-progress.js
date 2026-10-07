// Pure rendering: requests and cancellation handlers belong to app.js.
(function () {
  "use strict";
  const MAX_NODES = 200, MAX_DEPTH = 2;
  const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const label = (value, max = 240) => escape(typeof value === "string" ? value.slice(0, max) + (value.length > max ? "…" : "") : "");
  const elapsed = value => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "耗时未知";
    const seconds = Math.floor(value / 1000), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
    return `已用 ${hours ? `${hours} 小时 ` : ""}${hours || minutes ? `${minutes} 分 ` : ""}${seconds % 60} 秒`;
  };
  const price = row => {
    const value = row?.usage?.costUsd;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "费用未知";
    const amount = value === 0 ? "$0.00" : value < 0.0001 ? "小于 $0.0001" : `$${value.toFixed(4)}`;
    return `已记录估算 ${amount}${row.usage.unknownCost !== false || row.status === "running" ? " · 另有费用未知" : ""}`;
  };

  function taskProgressCard(data) {
    const flat = Array.isArray(data?.tasks) ? data.tasks.slice(0, MAX_NODES) : [];
    let roots = Array.isArray(data?.tree) ? data.tree : undefined;
    // Older/API fixture responses may provide only flat records. Build their hierarchy once.
    if (!roots) {
      const map = new Map();
      for (const row of flat) if (row && typeof row.id === "string" && !map.has(row.id)) map.set(row.id, { ...row, children: [] });
      roots = [];
      for (const row of map.values()) {
        const parent = map.get(row.parentTaskId);
        if (parent && parent !== row && !parent.parentTaskId) parent.children.push(row); else roots.push(row);
      }
    }
    let visited = 0, truncated = false;
    const ids = new Set(), objects = new WeakSet();
    const project = (row, depth) => {
      if (!row || typeof row !== "object" || typeof row.id !== "string" || !row.id || row.id.length > 128) return null;
      if (visited >= MAX_NODES || depth > MAX_DEPTH) { truncated = true; return null; }
      if (objects.has(row) || ids.has(row.id)) return null;
      visited++; objects.add(row); ids.add(row.id);
      const children = [];
      if (Array.isArray(row.children)) for (const child of row.children) {
        if (visited >= MAX_NODES) { truncated = true; break; }
        const next = project(child, depth + 1); if (next) children.push(next);
      }
      const pending = row.status !== "running" && row.cleanupPending === true;
      const failed = Number.isFinite(row.cleanupFailed) && row.cleanupFailed > 0;
      if (row.status !== "running" && !pending && !failed && !children.length) return null;
      return { row, children, pending, failed };
    };
    const visible = [];
    for (const root of roots) {
      if (visited >= MAX_NODES) { truncated = true; break; }
      const node = project(root, 1); if (node) visible.push(node);
    }
    if (!visible.length) return "";
    const render = node => {
      const { row, children, pending, failed } = node;
      const state = pending ? "正在清理" : failed ? "清理未确认" : row.status === "running" ? "运行中" : row.status === "stopped" ? "已取消" : "上级任务已结束";
      const actionable = row.status === "running" || children.some(child => child.row.status === "running");
      const safeId = /^[A-Za-z0-9_-]{1,128}$/.test(row.id);
      const action = (actionable || pending) && safeId ? `<button type="button" class="btn secondary" data-task-stop="${escape(row.id)}" ${pending ? "disabled aria-disabled=\"true\"" : ""}>${pending ? "正在清理…" : row.status === "running" ? "取消" : "取消子任务"}</button>` : "";
      const change = Array.isArray(row.fallbackChanges) ? row.fallbackChanges.at(-1) : null;
      const fallback = change && typeof change === "object" && typeof change.fromModel === "string" && typeof change.toModel === "string" ? `<p class="hint">模型已切换：${label(change.fromModel)} → ${label(change.toModel)}${change.reason === "quota_exhausted" ? "（来源额度已用尽）" : change.reason === "source_unavailable" ? "（来源暂不可用）" : ""}</p>` : "";
      return `<li data-task-progress-id="${escape(row.id)}"${row.parentTaskId ? ` data-task-parent="${label(row.parentTaskId, 128)}"` : ""} style="list-style:none;margin:10px 0"><div class="row" style="align-items:flex-start;gap:12px"><div class="grow"><div class="title">${label(row.task, 160) || "任务"} <span class="chip ${failed ? "warn" : ""}">${state}</span></div><p class="hint">${label(row.agent) || "未指定 Agent"} · ${label(row.model) || "未指定模型"} · ${elapsed(row.elapsedMs)}</p><p class="hint">${price(row)}${row.parentTaskId ? ` · 由 ${label(row.from) || "上级任务"} 派发` : ""}</p>${fallback}${failed ? `<p class="msg bad" role="status">进程或令牌的清理尚未确认，请检查后再启动任务。</p>` : ""}</div>${action}</div>${children.length ? `<ul aria-label="子任务" style="margin:10px 0 0 16px;padding-left:12px;border-left:1px solid var(--line)">${children.map(render).join("")}</ul>` : ""}</li>`;
    };
    return `<section class="card" data-task-progress aria-label="任务实时进度" style="padding:16px"><div class="section-head"><h3>任务实时进度</h3></div><p class="hint">费用为已记录的美元估算；运行中的费用尚未结算，父任务费用包含子任务，不需再次相加。</p><ul style="margin:0;padding:0">${visible.map(render).join("")}</ul>${truncated ? `<p class="hint" role="status">部分任务层级未展开，请刷新状态查看。</p>` : ""}</section>`;
  }
  globalThis.taskProgressCard = taskProgressCard;
  if (typeof window === "object" && window) window.taskProgressCard = taskProgressCard;
})();
