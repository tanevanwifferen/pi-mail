/**
 * Board operations (move / assign / comment / progress / create / update /
 * flag / config) shared by the socket protocol and the HTTP UI. Extracted
 * from daemon.mjs. Depends on lib/core.mjs, lib/board.mjs, lib/jira.mjs.
 */

import {
  HUMAN_AGENT_ID,
  HUMAN_AGENT_NAME,
  agentDisplayName,
  agents,
  send,
  log,
  sendMail,
  resolveTarget,
} from "./core.mjs";
import {
  board,
  DEFAULT_JQL,
  DEFAULT_COLUMNS,
  jiraCfg,
  jiraPushOk,
  findBoardTask,
  findBoardColumn,
  levelFromIssueType,
  taskActivity,
  progressEntriesSince,
  agentGroup,
  taskGroup,
  canAccessGroup,
  managerAgentTest,
  taskLocationLabel,
  taskMailBody,
  notifyAssignee,
  schedulePersistBoard,
  flushBoard,
} from "./board.mjs";
import {
  jiraTransitionTo,
  jiraAddComment,
  jiraCreateIssue,
  jiraUpdateIssue,
  jiraUpdateAssignee,
  syncBoard,
} from "./jira.mjs";

// ── Board operations (shared by socket protocol and HTTP UI) ─────────────────

export async function boardMove(actorId, taskSpec, columnSpec, note) {
  const task = findBoardTask(taskSpec);
  if (!task) return { error: `Task '${taskSpec}' not found` };
  if (!canAccessGroup(actorId, task)) return { error: `Task '${taskSpec}' is in a different group's board` };
  const actor = agentDisplayName(actorId);
  const target = String(columnSpec ?? "").trim().toLowerCase();

  // Pseudo-locations: "backlog" parks a task off-board in the shared backlog
  // pool; "archive" is the "done board" — it removes the task from its column
  // (incl. Done) while keeping the record queryable + restorable. Both are
  // LOCAL-ONLY: never pushed to Jira, and Jira sync won't override them.
  if (target === "backlog" || target === "archive") {
    const from = board.columns.find((c) => c.id === task.columnId);
    const prevLoc = task.location ?? "board";
    if (prevLoc !== target || note) {
      task.location = target;
      task.columnId = null;
      if (target === "archive") task.archivedAt = Date.now();
      const label = target === "archive" ? "Archive" : "Backlog";
      const fromLabel = from ? `${from.name} → ` : prevLoc !== "board" ? `${prevLoc} → ` : "→ ";
      taskActivity(task, actor, `moved ${fromLabel}${label}${note ? ` — ${note}` : ""}`);
    }
    schedulePersistBoard();
    return { ok: true, task };
  }

  const column = findBoardColumn(columnSpec);
  if (!column) {
    return { error: `Column '${columnSpec}' not found (columns: ${board.columns.map((c) => c.name).join(", ")}, or 'backlog'/'archive')` };
  }
  const from = board.columns.find((c) => c.id === task.columnId);
  const prevLoc = task.location ?? "board";
  const restoring = prevLoc !== "board";
  // Moving to a real column always (re)homes the task on the board.
  task.location = "board";
  if (task.columnId !== column.id) {
    task.columnId = column.id;
    const fromLabel = restoring ? `${prevLoc} → ` : from ? `${from.name} → ` : "→ ";
    taskActivity(task, actor, `moved ${fromLabel}${column.name}${note ? ` — ${note}` : ""}`);
  } else if (note) {
    taskActivity(task, actor, note);
  }

  let warning;
  // Fold progress entries recorded since the last fold into the description,
  // so the next column inherits a snapshot of what was done. Only when the
  // task actually moved column (a no-op move + note shouldn't rewrite it).
  let folded = 0;
  if (from && from.id !== column.id) {
    const entries = progressEntriesSince(task);
    folded = entries.length;
    if (folded) {
      const stamp = new Date().toLocaleString();
      const block = [
        `## Progress so far (→ ${column.name}, ${stamp})`,
        ...entries.map((e) => `- ${e.who}: ${e.text}`),
      ].join("\n");
      task.description = (task.description ? task.description.trimEnd() + "\n\n" : "") + block;
      task.progressSince = Date.now();
    }
  }
  // Push the matching Jira transition when moving into a Jira-mapped column.
  if (column.jiraStatus && task.origin === "jira" && jiraPushOk() &&
      column.jiraStatus.toLowerCase() !== (task.jiraStatus ?? "").toLowerCase()) {
    try {
      await jiraTransitionTo(task, column.jiraStatus);
      taskActivity(task, "jira", `transitioned to "${column.jiraStatus}"`);
    } catch (e) {
      warning = `Jira transition failed: ${e.message}`;
      taskActivity(task, "board", warning);
    }
  }
  // Push the folded description to Jira too (the transition above only moves
  // status; the new "Progress so far" block is part of the spec to carry over).
  if (folded && task.origin === "jira" && jiraPushOk()) {
    try {
      await jiraUpdateIssue(task.key, { description: task.description });
    } catch (e) {
      const w = `folded description not pushed to Jira: ${e.message}`;
      taskActivity(task, "board", w);
      if (!warning) warning = w;
    }
  }
  if (folded) taskActivity(task, "board", `folded ${folded} progress entr${folded === 1 ? "y" : "ies"} into description`);
  // Tell the assignee their task moved (unless they moved it themselves) —
  // this is what makes board-only columns like "Refine"/"Review" actionable.
  if (task.assignee && task.assignee !== actor) {
    const n = notifyAssignee(actorId, task, "Task moved");
    if (n.warning && !warning) warning = `assignee not mailed: ${n.warning}`;
  }
  schedulePersistBoard();
  return { ok: true, task, warning };
}

export async function boardAssign(actorId, taskSpec, assignee, newSession) {
  const task = findBoardTask(taskSpec);
  if (!task) return { error: `Task '${taskSpec}' not found` };
  const actor = agentDisplayName(actorId);
  const name = String(assignee ?? "").trim();
  // Same-group visibility: an agent may only touch tasks in its own group.
  // (The human operator can assign anything.)
  if (!canAccessGroup(actorId, task)) {
    return { error: `Task '${taskSpec}' is in a different group's board` };
  }
  if (!name) {
    const prev = task.assignee;
    task.assignee = null;
    // When unassigned, fall back to the stamped group (creator's); keep the
    // existing stamp so the task stays on its board rather than vanishing.
    taskActivity(task, actor, prev ? `unassigned ${prev}` : "cleared assignee");
    schedulePersistBoard();
    return { ok: true, task };
  }
  // "Allow work" gate (task e6ac4fe0): a hidden task cannot be assigned/
  // dispatched to a worker — whoever is doing the assigning (operator or a
  // manager). Unassigning above stays allowed so the operator can clear a
  // hidden task's assignee. Re-enable "Allow work" before assigning.
  if (task.allowWork === false) {
    return { error: `Task '${taskSpec}' has "Allow work" off — re-enable it before assigning` };
  }
  // Resolve to a canonical live-agent name when possible (accepts id prefixes).
  const targetId = resolveTarget(name);
  // An agent can only assign within its own group; the human and managers can assign across.
  const newGroup = targetId ? agentGroup(targetId) : null;
  const isManager = actorId !== HUMAN_AGENT_ID && managerAgentTest && managerAgentTest(actorId);
  if (actorId !== HUMAN_AGENT_ID && !isManager && newGroup != null && newGroup !== agentGroup(actorId)) {
    return { error: `Cannot assign to ${name}: ${name} is in a different project group` };
  }
  const prevAssignee = task.assignee;
  task.assignee = targetId ? agentDisplayName(targetId) : name;
  // Re-stamp the owning group from the new assignee's project (human-assigned
  // tasks land on that agent's board; unresolvable names keep the prior stamp).
  if (newGroup != null) task.group = newGroup;
  // Reassigning to a DIFFERENT agent: the new assignee has no context for this
  // task, so clear their session (deliver as a new-session task). First
  // assignment keeps the caller's newSession choice; re-assigning the same
  // agent (e.g. just to re-notify) does not clear context.
  const reassigning = prevAssignee != null && prevAssignee !== task.assignee;
  const clearContext = !!(newSession || reassigning);
  taskActivity(
    task,
    actor,
    `assigned to ${task.assignee}${reassigning ? " (context cleared for new assignee)" : ""}`
  );
  let warning;
  if (task.assignee !== actor) {
    const n = notifyAssignee(
      actorId,
      task,
      reassigning ? "Task reassigned" : "Task assigned",
      clearContext ? { newSession: true } : {}
    );
    if (n.warning) warning = `assignee not mailed: ${n.warning}`;
  }
  // Push assignment change to Jira for synced tasks.
  if (task.origin === "jira" && jiraPushOk()) {
    try {
      const accountId = await jiraUpdateAssignee(task.key, task.assignee);
      taskActivity(
        task,
        "jira",
        task.assignee
          ? `assigned to ${task.assignee} (Jira accountId: ${accountId})`
          : "unassigned in Jira"
      );
    } catch (e) {
      const w = `Jira assignee update failed: ${e.message}`;
      taskActivity(task, "board", w);
      if (!warning) warning = w;
    }
  }
  // Per-task model override (task 46c60a81): when the task carries a model
  // and the assignee resolves to a LIVE agent, push a set_model message to
  // that worker so it switches to the task's model before starting work.
  // Unset model = worker keeps its current/default model. A worker spawned
  // fresh for the task is started with --model (see spawn.mjs); this push
  // path covers an already-running worker.
  if (task.model && targetId) {
    const agent = agents.get(targetId);
    if (agent) {
      setImmediate(() => send(agent.conn, { type: "set_model", model: task.model }));
      log(`Dispatch: switching ${task.assignee} to model ${task.model} for task ${task.id.slice(0, 8)}`);
    }
  }
  schedulePersistBoard();
  return { ok: true, task, warning };
}

export async function boardComment(actorId, taskSpec, text) {
  const task = findBoardTask(taskSpec);
  if (!task) return { error: `Task '${taskSpec}' not found` };
  if (!canAccessGroup(actorId, task)) return { error: `Task '${taskSpec}' is in a different group's board` };
  const body = String(text ?? "").trim();
  if (!body) return { error: "Comment text is empty" };
  const actor = agentDisplayName(actorId);
  taskActivity(task, actor, body);
  let warning;
  if (task.origin === "jira" && jiraPushOk()) {
    try {
      const commentId = await jiraAddComment(task.key, `[${actor} via pi-mail board]\n\n${body}`);
      // Remember our own comment id so the pull sync doesn't re-import it.
      if (commentId) (task.knownCommentIds ??= []).push(commentId);
    } catch (e) {
      warning = `comment not synced to Jira: ${e.message}`;
      taskActivity(task, "board", warning);
    }
  }
  // Mail the comment to the assignee so new info (e.g. an operator note added
  // on the website) reaches the agent working the task. The session is left
  // intact (no newSession) — a comment is a follow-up, not a fresh task.
  // Skip when there's no assignee or the commenter is the assignee themselves.
  if (task.assignee && task.assignee !== actor) {
    const column = board.columns.find((c) => c.id === task.columnId) ?? null;
    const subject = `Comment on task: ${task.key ? `[${task.key}] ` : ""}${task.summary}`;
    const mailBody = [
      `${actor} added a comment to a board task assigned to you:`,
      "",
      body,
      "",
      `Board task id: ${task.id.slice(0, 8)}`,
      `Column: ${taskLocationLabel(task)}${column?.jiraStatus ? ` (Jira status: ${column.jiraStatus})` : ""}`,
      `Run board_get_task({ taskId: "${task.id.slice(0, 8)}" }) for full details and the activity log.`,
    ].join("\n");
    const r = sendMail(actorId, task.assignee, subject, mailBody);
    if (r.error) {
      const w = `comment not mailed to ${task.assignee}: ${r.error}`;
      taskActivity(task, "board", w);
      if (!warning) warning = w;
    }
  }
  schedulePersistBoard();
  return { ok: true, task, warning };
}

/**
 * Post a progress update on a task. Progress is an internal activity entry
 * (kind "progress") — it is NOT posted as a Jira comment (unlike
 * board_comment). It shows up in the task detail modal and, when the task is
 * moved to the next column, recent progress entries are folded into the
 * description (and that fold IS pushed to Jira). Progress also resets the
 * nudge clock for this task.
 */
export async function boardProgress(actorId, taskSpec, text) {
  const task = findBoardTask(taskSpec);
  if (!task) return { error: `Task '${taskSpec}' not found` };
  if (!canAccessGroup(actorId, task)) return { error: `Task '${taskSpec}' is in a different group's board` };
  const body = String(text ?? "").trim();
  if (!body) return { error: "Progress text is empty" };
  const actor = agentDisplayName(actorId);
  taskActivity(task, actor, body, "progress");
  // A progress post clears any pending nudge gap for this task.
  task.lastNudgeTs = Date.now();
  schedulePersistBoard();
  return { ok: true, task };
}

/** Flag a task as unclear (notifies the human operator) or clear the flag. */
export function boardFlag(actorId, taskSpec, reason, clear) {
  const task = findBoardTask(taskSpec);
  if (!task) return { error: `Task '${taskSpec}' not found` };
  if (!canAccessGroup(actorId, task)) return { error: `Task '${taskSpec}' is in a different group's board` };
  const actor = agentDisplayName(actorId);
  if (clear) {
    task.flagged = null;
    taskActivity(task, actor, "cleared the unclear flag");
    schedulePersistBoard();
    return { ok: true, task };
  }
  const why = String(reason ?? "").trim() || "needs clarification";
  task.flagged = { by: actor, reason: why, ts: Date.now() };
  taskActivity(task, actor, `⚠ flagged unclear: ${why}`);
  let warning;
  if (actorId !== HUMAN_AGENT_ID) {
    const r = sendMail(
      actorId,
      HUMAN_AGENT_NAME,
      `Task unclear: ${task.key ? `[${task.key}] ` : ""}${task.summary}`,
      [
        `${actor} flagged a board task as unclear.`,
        "",
        `Task: ${task.key ? `[${task.key}] ` : ""}${task.summary}`,
        task.url ? `Jira: ${task.url}` : null,
        `Board task id: ${task.id.slice(0, 8)}`,
        "",
        `## Reason / questions`,
        why,
        "",
        `Reply by mail, comment on the task, or clarify the description — then clear the flag on the board.`,
      ]
        .filter((l) => l != null)
        .join("\n")
    );
    if (r.error) warning = `operator not mailed: ${r.error}`;
  }
  schedulePersistBoard();
  return { ok: true, task, warning };
}


// Re-exported from board-create.mjs so consumers keep importing create/update/
// config from this single "./board-ops.mjs" surface.
export { boardCreate, boardUpdate, boardSetConfig } from "./board-create.mjs";
