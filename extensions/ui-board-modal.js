"use strict";
// ── Task detail modal ───────────────────────────────────────────────────────
// Extracted from ui-board.js. openTaskModal/closeTaskModal/renderTaskModal show
// the full task detail overlay (description, activity timeline, comment /
// progress / move / assign / flag / subtask actions). Re-rendered each poll so
// it stays live; the comment draft is preserved in boardUi.draftComments.

function openTaskModal(id) {
  boardUi.taskModalId = id;
  renderTaskModal();
}
function closeTaskModal() {
  boardUi.taskModalId = null;
  const m = $("#task-modal");
  if (m) m.remove();
}
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && boardUi.taskModalId) closeTaskModal();
});

/** Render the task detail modal overlay. Shows summary/key, meta, the full
 *  description (incl. any folded progress section), the COMPLETE activity
 *  timeline (all entries, progress marked distinctly), and actions: comment,
 *  add progress, move, flag/clear, assign, +subtask. Re-rendered each poll so
 *  it stays live; the comment draft is preserved in boardUi.draftComments. */
function renderTaskModal() {
  let m = $("#task-modal");
  if (!boardUi.taskModalId) { if (m) m.remove(); return; }
  const board = state.board;
  const t = (board?.tasks ?? []).find(x => x.id === boardUi.taskModalId)
         || (boardUi.archiveTasks ?? []).find(x => x.id === boardUi.taskModalId);
  if (!t) { closeTaskModal(); return; } // task disappeared (moved off board / deleted)
  if (!m) {
    m = el("div", "task-modal"); m.id = "task-modal";
    m.addEventListener("click", e => { if (e.target === m) closeTaskModal(); });
    document.body.appendChild(m);
  }
  const card = el("div", "card");
  // Head
  const head = el("div", "tm-head");
  const h3 = el("h3");
  if (t.key) {
    const k = t.url ? el("a", "tm-key", "[" + t.key + "]") : el("span", "tm-key", "[" + t.key + "]");
    if (t.url) { k.href = t.url; k.target = "_blank"; }
    h3.appendChild(k);
  }
  h3.appendChild(document.createTextNode(t.summary));
  head.appendChild(h3);
  const close = el("button", "tm-close", "✕");
  close.addEventListener("click", closeTaskModal);
  head.appendChild(close);
  card.appendChild(head);
  // Meta badges
  const meta = el("div", "tm-meta");
  const col = (board.columns ?? []).find(c => c.id === t.columnId);
  const loc = t.location ?? "board";
  const locLabel = loc === "backlog" ? "📥 Backlog" : loc === "archive" ? "🗄 Archive" : (col?.name ?? t.columnId ?? "?");
  meta.appendChild(el("span", "badge " + (loc === "board" && col?.jiraStatus ? "jira" : "custom"), locLabel));
  if (t.level && t.level !== "task") meta.appendChild(el("span", "badge sub", t.level));
  meta.appendChild(el("span", "assignee" + (t.assignee ? "" : " none"), t.assignee || "unassigned"));
  if (t.jiraStatus) meta.appendChild(el("span", "badge jira", t.jiraStatus));
  if (t.origin === "local") meta.appendChild(el("span", "badge custom", "local"));
  if (t.priority) meta.appendChild(el("span", "badge pri-" + t.priority, "🔺 " + t.priority));
  if (t.model) {
    const mb = el("span", "badge sub", "🤖 " + modelDisplay(t.model));
    mb.title = t.model;
    meta.appendChild(mb);
  }
  const mg = taskGroup(t);
  if (mg && mg !== "(no project)") meta.appendChild(el("span", "badge sub", "⟨" + mg + "⟩"));
  if (t.flagged) {
    const fb = el("span", "badge flag", "⚠ unclear");
    fb.title = "Flagged by " + t.flagged.by + ": " + t.flagged.reason;
    meta.appendChild(fb);
  }
  if (isSubtask(t)) meta.appendChild(el("span", "badge sub", "↳ " + (t.parentKey || "subtask")));
  card.appendChild(meta);
  if (t.url) card.appendChild(el("div", "sync", "Jira: " + t.url));
  if (t.flagged) {
    const fr = el("div", "binstr", "⚠ Flagged unclear by " + t.flagged.by + " (" + fmtTime(t.flagged.ts) + "):\n" + t.flagged.reason);
    fr.style.borderLeftColor = "var(--error)";
    card.appendChild(fr);
  }
  // Description (incl. any folded "Progress so far" block)
  const dsec = el("div", "tm-section");
  dsec.appendChild(el("div", "gtitle", "Description"));
  dsec.appendChild(el("div", "tm-desc", t.description || "(no description)"));
  card.appendChild(dsec);
  // Subtasks
  const kids = childrenOf(t, board);
  if (kids.length) {
    const ssec = el("div", "tm-section");
    ssec.appendChild(el("div", "gtitle", "Subtasks"));
    for (const c of kids) {
      const cc = board.columns.find(x => x.id === c.columnId);
      const line = el("div", "a", "- [" + shortId(c.id) + "]" + (c.key ? " " + c.key : "") + " " + c.summary + " (" + (cc?.name ?? "?") + (c.assignee ? ", " + c.assignee : "") + ")");
      ssec.appendChild(line);
    }
    card.appendChild(ssec);
  }
  // Column instructions (if any)
  if (col?.instructions) {
    const isec = el("div", "tm-section");
    isec.appendChild(el("div", "gtitle", "Column instructions (" + col.name + ")"));
    isec.appendChild(el("div", "binstr", col.instructions));
    card.appendChild(isec);
  }
  // FULL activity timeline, rendered by kind (progress marked distinctly)
  const asec = el("div", "tm-section");
  asec.appendChild(el("div", "gtitle", "Activity (" + (t.activity?.length ?? 0) + ")"));
  const act = el("div", "tm-act");
  if (t.activity?.length) {
    for (const a of t.activity) {
      const row = el("div", "a" + (a.kind === "progress" ? " progress" : ""));
      if (a.kind === "progress") row.appendChild(el("span", "akind", "progress"));
      const b = el("b", null, a.who); row.appendChild(b);
      row.appendChild(document.createTextNode(" · " + fmtTime(a.ts) + "\n" + a.text));
      act.appendChild(row);
    }
  } else {
    act.appendChild(el("div", "empty", "—"));
  }
  asec.appendChild(act);
  card.appendChild(asec);
  // Action row: comment / progress textarea + buttons + move + assign + flag + subtask
  const fsec = el("div", "tm-section");
  const ta = el("textarea");
  ta.placeholder = "Add a comment or progress note…";
  ta.value = boardUi.draftComments[t.id] || "";
  ta.addEventListener("input", () => boardUi.draftComments[t.id] = ta.value);
  fsec.appendChild(ta);
  const actions = el("div", "tm-actions");
  const cbtn = el("button", "btn secondary mini", "💬 Comment");
  cbtn.title = "Posted to the activity log" + (t.origin === "jira" ? " and the Jira issue" : "");
  cbtn.addEventListener("click", async () => {
    const text = ta.value.trim(); if (!text) return;
    const r = await boardPost("/api/board/comment", { taskId: t.id, text }, "Comment added");
    if (r.ok) { delete boardUi.draftComments[t.id]; }
  });
  actions.appendChild(cbtn);
  const pbtn = el("button", "btn mini", "📈 Progress");
  pbtn.title = "Internal progress note (not posted to Jira); folded into the description when the task moves";
  pbtn.addEventListener("click", async () => {
    const text = ta.value.trim(); if (!text) return;
    const r = await boardPost("/api/board/progress", { taskId: t.id, text }, "Progress posted");
    if (r.ok) { delete boardUi.draftComments[t.id]; }
  });
  actions.appendChild(pbtn);
  // Move select — includes Backlog/Archive pseudo-locations.
  const mv = el("select");
  const tloc = t.location ?? "board";
  const mkOpt = (val, label, sel) => { const o = el("option"); o.value = val; o.textContent = label; if (sel) o.selected = true; return o; };
  if (tloc === "backlog") mv.appendChild(mkOpt("backlog", "📥 Backlog", true));
  if (tloc === "archive") mv.appendChild(mkOpt("archive", "🗄 Archive", true));
  for (const c of board.columns) mv.appendChild(mkOpt(c.id, c.name, tloc === "board" && c.id === t.columnId));
  if (tloc !== "backlog") mv.appendChild(mkOpt("backlog", "📥 Backlog", false));
  if (tloc !== "archive") mv.appendChild(mkOpt("archive", "🗄 Archive", false));
  mv.title = "Move to column / backlog / archive";
  mv.addEventListener("change", () => boardPost("/api/board/move", { taskId: t.id, column: mv.value }, "Moved"));
  actions.appendChild(mv);
  // Group picker — groups from running agents + favorites + spawn history.
  const gp = el("select");
  gp.title = "Change project group";
  const gpNone = el("option"); gpNone.value = "__clear__"; gpNone.textContent = "→ group…"; gp.appendChild(gpNone);
  const curGroup = taskGroup(t);
  const seen = new Set();
  // Running agents
  for (const a of (state.agents || [])) {
    const g = projectOf(a.cwd);
    addGroupOpt(g);
  }
  // Favorites (persist across agent sessions)
  for (const f of (state.spawn?.projects?.favorites || [])) {
    addGroupOpt(projectOf(f.cwd));
  }
  // Spawn history (projects that were spawned into before)
  for (const h of (state.spawn?.projects?.history || [])) {
    addGroupOpt(projectOf(h.cwd));
  }
  function addGroupOpt(g) {
    if (!g || seen.has(g) || g === "(no project)") return;
    seen.add(g);
    const o = el("option"); o.value = g; o.textContent = g;
    if (g === curGroup) o.selected = true;
    gp.appendChild(o);
  }
  if (curGroup && curGroup !== "(no project)" && !seen.has(curGroup)) {
    const o = el("option"); o.value = curGroup; o.textContent = curGroup; o.selected = true;
    gp.appendChild(o);
  }
  const gpClear = el("option"); gpClear.value = ""; gpClear.textContent = "(no group)"; gp.appendChild(gpClear);
  gp.addEventListener("change", () => {
    if (!gp.value && gp.value !== "") return;
    const group = gp.value === "__clear__" ? "" : gp.value;
    boardPost("/api/board/update", { taskId: t.id, group }, "Group updated").then(r => { if (r.ok) closeTaskModal(); });
  });
  actions.appendChild(gp);
  // Priority change dropdown (task df729d21)
  const pp = el("select");
  pp.appendChild((() => { const o = el("option"); o.value = ""; o.textContent = "→ change priority…"; return o; })());
  for (const p of ["high", "medium", "low"]) {
    const o = el("option"); o.value = p; o.textContent = p; if (p === (t.priority || "")) o.selected = true; pp.appendChild(o);
  }
  const ppClear = el("option"); ppClear.value = "__clear__"; ppClear.textContent = "(none)"; pp.appendChild(ppClear);
  pp.addEventListener("change", () => {
    if (!pp.value && pp.value !== "") return;
    const priority = pp.value === "__clear__" ? "" : pp.value;
    boardPost("/api/board/update", { taskId: t.id, priority }, "Priority → " + (priority || "none")).then(r => { if (r.ok) closeTaskModal(); });
  });
  actions.appendChild(pp);
  // Model change dropdown (task 46c60a81) — per-task model override.
  actions.appendChild(modelSelect(t.model || "", (model) => {
    boardPost("/api/board/update", { taskId: t.id, model }, "Model " + (model || "cleared"));
  }));
  // "Allow work" toggle (task e6ac4fe0) — unchecked hides the task from
  // worker agents and blocks assignment. The operator sees hidden tasks and
  // can re-enable here.
  const awWrap = el("span", "checkbox");
  const awCb = el("input"); awCb.type = "checkbox"; awCb.id = "allowWork"; awCb.checked = t.allowWork !== false;
  awCb.title = "When unchecked the task is hidden from worker agents and cannot be assigned";
  awCb.addEventListener("change", () => {
    boardPost("/api/board/update", { taskId: t.id, allowWork: awCb.checked },
      awCb.checked ? "Allow work on" : "Allow work off — hidden from agents");
  });
  const awLbl = el("label", null, "Allow work"); awLbl.setAttribute("for", "allowWork"); awLbl.style.margin = "0";
  awWrap.appendChild(awCb); awWrap.appendChild(awLbl);
  actions.appendChild(awWrap);
  // Assign select
  const as = el("select");
  const optNone = el("option"); optNone.value = ""; optNone.textContent = "→ assign…"; as.appendChild(optNone);
  const optClear = el("option"); optClear.value = "__unassign__"; optClear.textContent = "(unassign)"; as.appendChild(optClear);
  for (const p of agentPickList()) {
    const o = el("option"); o.value = p.name; o.textContent = p.name + (p.idle ? " · idle" : "");
    if (p.name === t.assignee) o.selected = true;
    as.appendChild(o);
  }
  as.title = "Assign to agent (mails them the task)";
  as.addEventListener("change", () => {
    if (!as.value) return;
    const assignee = as.value === "__unassign__" ? "" : as.value;
    boardPost("/api/board/assign", { taskId: t.id, assignee, newSession: boardUi.freshSession },
      assignee ? "Assigned to " + assignee + " (mailed)" : "Unassigned");
  });
  actions.appendChild(as);
  // Flag / clear
  if (t.flagged) {
    const clr = el("button", "btn secondary mini", "Clear ⚠");
    clr.addEventListener("click", () => boardPost("/api/board/flag", { taskId: t.id, clear: true }, "Flag cleared"));
    actions.appendChild(clr);
  } else {
    const flg = el("button", "btn secondary mini", "Flag ⚠");
    flg.title = "Uses the text box as the reason";
    flg.addEventListener("click", () => {
      const reason = ta.value.trim() || "needs clarification";
      boardPost("/api/board/flag", { taskId: t.id, reason }, "Flagged as unclear").then(r => { if (r.ok) delete boardUi.draftComments[t.id]; });
    });
    actions.appendChild(flg);
  }
  // Subtask
  const sub = el("button", "btn secondary mini", "＋ Subtask");
  sub.addEventListener("click", () => {
    const summary = prompt("Subtask summary" + (t.origin === "jira" ? " (created as a Jira sub-task)" : "") + ":");
    if (summary && summary.trim()) boardPost("/api/board/create", { summary: summary.trim(), parent: t.id }, "Subtask created");
  });
  actions.appendChild(sub);
  fsec.appendChild(actions);
  card.appendChild(fsec);
  // Preserve scroll positions of the description + activity containers and
  // the textarea's focus/selection across the poll-driven rebuild, so reading
  // a long activity log isn't reset to the top every 3s. (The focus guard in
  // refresh() already suppresses re-render while typing; this covers passive
  // reading and any render that slips through.)
  let descScroll = 0, actScroll = 0, taFocus = false, taStart = 0, taEnd = 0;
  {
    const oldDesc = m.querySelector(".tm-desc"); if (oldDesc) descScroll = oldDesc.scrollTop;
    const oldAct = m.querySelector(".tm-act"); if (oldAct) actScroll = oldAct.scrollTop;
    const oldTa = m.querySelector("textarea");
    if (oldTa) {
      taFocus = document.activeElement === oldTa;
      taStart = oldTa.selectionStart ?? 0; taEnd = oldTa.selectionEnd ?? 0;
    }
  }
  m.innerHTML = "";
  m.appendChild(card);
  const newDesc = m.querySelector(".tm-desc"); if (newDesc) newDesc.scrollTop = descScroll;
  const newAct = m.querySelector(".tm-act"); if (newAct) newAct.scrollTop = actScroll;
  if (taFocus) {
    const newTa = m.querySelector("textarea");
    if (newTa) { newTa.focus(); try { newTa.setSelectionRange(taStart, taEnd); } catch {} }
  }
}
