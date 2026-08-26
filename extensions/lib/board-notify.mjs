/**
 * Task-board notification + progress-nudge helpers for the pi-mail daemon.
 *
 * - taskMailBody: builds the mail body mailed to an assignee on assignment /
 *   column move (full task package + working-this-task instructions).
 * - notifyAssignee: mails a task's assignee; non-fatal when offline.
 * - nudgeIdleTasks: periodic one-line reminder to in-progress assignees who
 *   haven't posted progress in a while.
 *
 * Extracted from board.mjs. Depends on lib/core.mjs + lib/board.mjs (board
 * state, taskLocationLabel, taskActivity, schedulePersistBoard). Re-exported
 * from board.mjs so existing importers (daemon.mjs, board-ops.mjs) are
 * unchanged.
 */

import {
  HUMAN_AGENT_ID,
  agentDisplayName,
  sendMail,
} from "./core.mjs";
import {
  board,
  taskLocationLabel,
  taskActivity,
  schedulePersistBoard,
} from "./board.mjs";

/** Mail body sent to an assignee on assignment or when their task is moved. */
export function taskMailBody(task, column, actorName) {
  const locLabel = taskLocationLabel(task);
  const isOffBoard = task.location === "backlog" || task.location === "archive";
  const lines = [
    `Task: ${task.key ? `[${task.key}] ` : ""}${task.summary}`,
    `Column: ${locLabel}${
      isOffBoard ? " (off-board location)" : column?.jiraStatus ? ` (Jira status: ${column.jiraStatus})` : " (board-only column, no Jira status)"
    }`,
  ];
  if (task.url) lines.push(`Jira: ${task.url}`);
  if (task.model) lines.push(`Model: ${task.model} (this task runs on a specific model)`);
  if (task.parentKey || task.parentId) {
    const parent = board.tasks.find((t) => t.id === task.parentId || (task.parentKey && t.key === task.parentKey));
    lines.push(`Subtask of: ${task.parentKey ?? parent?.id.slice(0, 8) ?? "?"}${parent ? ` — ${parent.summary}` : ""}`);
  }
  if (task.flagged) lines.push(`⚠ Flagged unclear by ${task.flagged.by}: ${task.flagged.reason}`);
  lines.push(`Board task id: ${task.id.slice(0, 8)}`);
  lines.push("", "## Description", task.description || "(no description)");
  const children = board.tasks.filter((t) => t.parentId === task.id || (task.key && t.parentKey === task.key));
  if (children.length) {
    lines.push("", "## Subtasks");
    for (const c of children) {
      const col = board.columns.find((x) => x.id === c.columnId);
      lines.push(`- [${c.id.slice(0, 8)}]${c.key ? ` ${c.key}` : ""} ${c.summary} (${col?.name ?? "?"}${c.assignee ? `, ${c.assignee}` : ""})`);
    }
  }
  if (column?.instructions) {
    lines.push("", `## Column instructions ("${column.name}")`, column.instructions);
  }
  lines.push(
    "",
    "## Before you start",
    `Check the task is actually clear: goal, scope, acceptance criteria. If anything is ambiguous, do NOT guess — ` +
      `post your questions with board_comment_task, mark it with board_flag_task({ taskId: "${task.id.slice(0, 8)}", reason: "..." }) ` +
      `(the operator is notified), and mail "${actorName}". Only start once the task is clear.`,
    "",
    "## Working this task",
    `- board_get_task({ taskId: "${task.id.slice(0, 8)}" }) — full details and activity log`,
    `- board_move_task({ taskId: "${task.id.slice(0, 8)}", column: "<name>" }) — move as you progress. Columns: ${board.columns
      .map((c) => c.name)
      .join(", ")}`,
    `- board_comment_task({ taskId: "${task.id.slice(0, 8)}", text: "..." }) — log progress${
      task.origin === "jira" ? " (also posted to the Jira issue)" : ""
    }`,
    `- board_progress_task({ taskId: "${task.id.slice(0, 8)}", text: "..." }) — post a work-in-progress note (internal; folded into the description when the task moves). Use this before moving the task onward and if a daemon nudge reminds you.`,
    `- board_split_task({ taskId: "${task.id.slice(0, 8)}", subtasks: [...] }) — subdivide into subtasks${
      task.origin === "jira" ? " (created as real Jira sub-tasks)" : ""
    } if the task is too big for one pass`,
    `- When finished: move the task to the appropriate column and mail a short summary to "${actorName}".`
  );
  return lines.join("\n");
}

/** Notify a task's assignee by mail. Non-fatal if the assignee is offline. */
export function notifyAssignee(actorId, task, subjectPrefix, opts = {}) {
  if (!task.assignee) return { mailed: false };
  const column = board.columns.find((c) => c.id === task.columnId) ?? null;
  const actor = agentDisplayName(actorId);
  const r = sendMail(
    actorId,
    task.assignee,
    `${subjectPrefix}: ${task.key ? `[${task.key}] ` : ""}${task.summary}`,
    taskMailBody(task, column, actor),
    opts
  );
  if (r.error) {
    taskActivity(task, "board", `could not mail ${task.assignee}: ${r.error}`);
    return { mailed: false, warning: r.error };
  }
  return { mailed: true };
}

// ── Progress nudge ─────────────────────────────────────────────────────────

/**
 * Periodically mail in-progress assignees a one-line reminder when they
 * haven't posted a progress update in a while. Non-fatal: if the assignee is
 * offline sendMail just returns an error and we move on. One nudge per gap
 * is enforced via task.lastNudgeTs.
 */
export function nudgeIdleTasks() {
  if (board.config.nudgeEnabled === false) return;
  const intervalMs = Math.max(1, (board.config.nudgeIntervalMin ?? 60)) * 60_000;
  const now = Date.now();
  for (const task of board.tasks) {
    if (!task.assignee) continue;
    // "Allow work" off → the task is hidden from workers; don't nag them.
    if (task.allowWork === false) continue;
    const col = board.columns.find((c) => c.id === task.columnId);
    // "In progress" = a column mapped to a Jira status whose name suggests
    // active work, OR any non-board-only column between To Do and Done. We
    // keep it simple: the column's jiraStatus is one of the in-progress
    // states, or (board-only fallback) the column id is "inprogress".
    const inProgress =
      (col?.jiraStatus && /in[- ]?progress/i.test(col.jiraStatus)) ||
      col?.id === "inprogress";
    if (!inProgress) continue;
    const last = task.lastProgressTs ?? task.progressSince ?? 0;
    // Don't nudge if there's been progress, or a nudge, within the interval.
    if (now - last < intervalMs) continue;
    if (task.lastNudgeTs && now - task.lastNudgeTs < intervalMs) continue;
    const r = sendMail(
      HUMAN_AGENT_ID,
      task.assignee,
      `Progress check-in: ${task.key ? `[${task.key}] ` : ""}${task.summary}`,
      [
        `Quick nudge: you're working on "${task.summary}" (${col?.name ?? "?"}) but haven't posted a progress update in a while.`,
        `Run board_progress_task({ taskId: "${task.id.slice(0, 8)}", text: "..." }) with what you've done / what's blocking you.`,
        "",
        `This keeps the board in sync for the next agent (and folds into the description when the task moves). No reply needed if you're just heads-down — posting progress clears this nudge.`,
      ].join("\n")
    );
    task.lastNudgeTs = now;
    if (!r.error) taskActivity(task, "board", `nudged ${task.assignee} for a progress update`);
  }
  schedulePersistBoard();
}
