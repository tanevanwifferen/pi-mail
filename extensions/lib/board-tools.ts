/**
 * Task-board tool registrations for the pi-mail extension.
 * Extracted from index.ts. The board MUTATION tools (move / comment / progress /
 * assign / create / split / flag / update) live here; the read-only tools
 * (board_list_tasks / board_get_task) live in board-read-tools.ts, and the
 * agent-spawn + project tools in spawn-tools.ts. Registered via
 * registerBoardTools(pi, ctx) where ctx is a live (getter-backed) state object
 * from the extension closure.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MailClient } from "./mail-client.js";
export interface BoardColumn { id: string; name: string; jiraStatus: string | null; instructions: string; }
export interface BoardTask { id: string; key: string | null; origin: "jira" | "local"; summary: string; description: string; url: string | null; jiraStatus: string | null; columnId: string; assignee: string | null; priority: string | null; issueType: string | null; updatedAt: number; parentId: string | null; parentKey: string | null; pinned?: boolean; flagged: { by: string; reason: string; ts: number } | null; knownCommentIds?: string[]; progressSince?: number; lastProgressTs?: number; lastNudgeTs?: number; location: "board" | "backlog" | "archive"; level: "epic" | "story" | "task" | "subtask"; epicId?: string | null; group?: string | null; allowWork?: boolean; model?: string | null; activity: Array<{ ts: number; who: string; text: string; kind?: string }>; }
interface BoardStateResp { type: string; message?: string; columns: BoardColumn[]; tasks: BoardTask[]; jiraConfigured: boolean; jiraEnabled?: boolean; lastSync: number; syncError: string | null; myGroup: string | null; group?: string | null; }
export interface BoardToolCtx { client: MailClient | null; connected: boolean; agentName: string; notConnected: { content: { type: "text"; text: string }[] }; }
export function errText(err: unknown) { return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] }; }
export function taskLine(t: BoardTask): string { const key = t.key ? `${t.key} ` : ""; const who = t.assignee ? ` → ${t.assignee}` : ""; const status = t.jiraStatus ? ` [jira: ${t.jiraStatus}]` : ""; const sub = t.parentKey || t.parentId ? ` ↳sub of ${t.parentKey ?? t.parentId?.slice(0, 8)}` : ""; const flag = t.flagged ? ` ⚠unclear` : ""; const lvl = t.level && t.level !== "task" ? ` ${t.level}` : ""; const loc = t.location === "backlog" ? ` [backlog]` : t.location === "archive" ? ` [archive]` : ""; const grp = t.group ? ` ⟨${t.group}⟩` : ""; const pri = t.priority ? ` 🔺${t.priority}` : ""; const mdl = t.model ? ` 🤖${t.model}` : ""; return `  • [${t.id.slice(0, 8)}] ${key}${t.summary}${lvl}${who}${pri}${status}${sub}${loc}${grp}${mdl}${flag}`; }
export function boardOpResult(resp: { type: string; warning?: string; message?: string; task?: BoardTask }, okText: string) { if (resp.type === "error") { return { content: [{ type: "text" as const, text: `❌ ${resp.message}` }] }; } const warn = resp.warning ? `\n⚠️ ${resp.warning}` : ""; return { content: [{ type: "text" as const, text: `✅ ${okText}${warn}` }], details: { task: resp.task } }; }
export async function fetchBoard(ctx: BoardToolCtx, opts: { location?: string; includeArchived?: boolean; group?: string } = {}): Promise<BoardStateResp> { if (!ctx.connected || !ctx.client) throw new Error("Not connected to mail daemon"); const resp = await ctx.client.request<BoardStateResp>({ type: "board_state", ...opts }); if (resp.type !== "board") throw new Error(resp.message ?? "unknown board error"); return resp; }
export function registerBoardTools(pi: ExtensionAPI, ctx: BoardToolCtx): void {
  pi.registerTool({
    name: "board_move_task",
    label: "Board: Move",
    description:
      "Move a board task to another column. Moving into a Jira-mapped column also transitions the Jira issue. " +
      "Moving a task assigned to someone else notifies them by mail (including the column's instructions). " +
      "The column may also be 'backlog' (park off-board in the shared backlog) or 'archive' (the done board — removes the task from its column incl. Done; restorable). Backlog/archive placements are local-only (never pushed to Jira), but for Jira-origin tasks they only stick while the remote Jira status is unchanged — a Jira status change pulls the task back onto the board into the mapped column.",
    promptSnippet: "Move a task on the shared board",
    promptGuidelines: [
      "Move your assigned board task as you progress: to the in-progress column when starting, and onward when done.",
      "Move completed work to 'Review' or 'Done' — never archive tasks yourself. Only the human operator archives.",
      "Move to 'backlog' to park a task off-board without archiving it.",
    ],
    parameters: Type.Object({
      taskId: Type.String({ description: "Task id prefix or Jira key" }),
      column: Type.String({ description: "Target column name/id, or 'backlog'/'archive'" }),
      note: Type.Optional(Type.String({ description: "Short note recorded in the task's activity log" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!ctx.connected || !ctx.client) return ctx.notConnected;
      try {
        const resp = await ctx.client.request<{ type: string; warning?: string; message?: string; task?: BoardTask }>(
          { type: "board_move", taskId: params.taskId, column: params.column, note: params.note },
          30_000
        );
        return boardOpResult(resp, `Moved ${resp.task?.key ?? params.taskId} → ${params.column}`);
      } catch (err: unknown) {
        return errText(err);
      }
    },
  });

  pi.registerTool({
    name: "board_comment_task",
    label: "Board: Comment",
    description:
      "Add a comment to a board task's activity log. For Jira-synced tasks the comment is also posted to the Jira issue.",
    promptSnippet: "Comment on a board task",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task id prefix or Jira key" }),
      text: Type.String({ description: "Comment text" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!ctx.connected || !ctx.client) return ctx.notConnected;
      try {
        const resp = await ctx.client.request<{ type: string; warning?: string; message?: string; task?: BoardTask }>(
          { type: "board_comment", taskId: params.taskId, text: params.text },
          30_000
        );
        return boardOpResult(resp, `Comment added to ${resp.task?.key ?? params.taskId}`);
      } catch (err: unknown) {
        return errText(err);
      }
    },
  });

  pi.registerTool({
    name: "board_progress_task",
    label: "Board: Progress",
    description:
      "Post a progress update on a board task you're working on. Progress is internal (not posted to Jira); it shows in the task detail view and is folded into the description when the task moves columns, so the next agent inherits a snapshot. Use this to report what's done / what's blocking, especially before moving the task onward.",
    promptSnippet: "Post progress on a board task",
    promptGuidelines: [
      "Post a board_progress_task update before moving a task to the next column, so the next agent (and the operator) see what was done.",
      "Use board_progress_task for work-in-progress notes (kept internal); use board_comment_task for decisions/answers that belong on the Jira issue too.",
    ],
    parameters: Type.Object({
      taskId: Type.String({ description: "Task id prefix or Jira key" }),
      text: Type.String({ description: "What you've done since the last update, and anything blocking you" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!ctx.connected || !ctx.client) return ctx.notConnected;
      try {
        const resp = await ctx.client.request<{ type: string; message?: string; task?: BoardTask }>(
          { type: "board_progress", taskId: params.taskId, text: params.text },
          30_000
        );
        return boardOpResult(resp, `Progress posted on ${resp.task?.key ?? params.taskId}`);
      } catch (err: unknown) {
        return errText(err);
      }
    },
  });

  pi.registerTool({
    name: "board_assign_task",
    label: "Board: Assign",
    description:
      "Assign a board task to an agent (by name, from mail_list_agents). The assignee is mailed the full task package " +
      "including the column's instructions. Pass an empty assignee to unassign. Reassigning a task to a different agent " +
      "automatically clears that agent's context (delivered as a fresh-session task); first assignment only clears context " +
      "when newSession is true.",
    promptSnippet: "Assign a board task to an agent",
    promptGuidelines: [
      "When orchestrating, assign board tasks instead of ad-hoc mail so progress is visible on the board.",
    ],
    parameters: Type.Object({
      taskId: Type.String({ description: "Task id prefix or Jira key" }),
      assignee: Type.String({ description: "Agent name to assign (empty string to unassign)" }),
      newSession: Type.Optional(Type.Boolean({
        description: "If true, the assignee starts a fresh session (cleared context) for this task. On reassignment to a different agent this happens automatically regardless.",
      })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!ctx.connected || !ctx.client) return ctx.notConnected;
      try {
        const resp = await ctx.client.request<{ type: string; warning?: string; message?: string; task?: BoardTask }>(
          { type: "board_assign", taskId: params.taskId, assignee: params.assignee, newSession: params.newSession },
          30_000
        );
        const who = params.assignee.trim() || "(unassigned)";
        return boardOpResult(resp, `${resp.task?.key ?? params.taskId} assigned to ${who}`);
      } catch (err: unknown) {
        return errText(err);
      }
    },
  });

  pi.registerTool({
    name: "board_create_task",
    label: "Board: Create",
    description:
      "Create a new task on the shared board. With 'parent' it becomes a subtask; when the parent is a Jira issue " +
      "(or inJira is true) a real Jira issue is created and kept in sync. Otherwise the task is board-only. " +
      "Pass backlog:true to create straight into the Backlog pool (off-board, local-only). " +
      "Use level to set the issue hierarchy: 'epic' | 'story' | 'task' | 'subtask' (default 'task', or 'subtask' when parent is given). " +
      "A story may reference an epic by id via epicId. Set group to assign the task to a project group (omit for ungrouped). " +
      "Set priority to 'high', 'medium', or 'low' (default: none).",
    promptSnippet: "Create a task on the shared board",
    parameters: Type.Object({
      summary: Type.String({ description: "One-line task summary" }),
      description: Type.Optional(Type.String({ description: "Full task description" })),
      column: Type.Optional(Type.String({ description: "Column name or id (defaults to the parent's column, else the first column). Ignored when backlog:true." })),
      parent: Type.Optional(Type.String({ description: "Parent task id prefix or Jira key — makes this a subtask" })),
      inJira: Type.Optional(Type.Boolean({ description: "Create a Jira issue for a top-level task (needs a project key in board settings)" })),
      level: Type.Optional(Type.String({ description: "Issue level: 'epic' | 'story' | 'task' | 'subtask' (default inferred from parent)" })),
      epicId: Type.Optional(Type.String({ description: "For a story: the board id (or prefix) of its epic" })),
      backlog: Type.Optional(Type.Boolean({ description: "Create in the Backlog pool (off-board, local-only) instead of a column" })),
      group: Type.Optional(Type.String({ description: "Project group for the task (omit for ungrouped/current behavior)" })),
      priority: Type.Optional(Type.String({ description: "Priority: 'high', 'medium', or 'low' (default: none)" })),
      model: Type.Optional(Type.String({ description: "Per-task model override, e.g. 'openrouter/deepseek/deepseek-v4-pro' (omit for the worker's default). See mail models list." })),
      allowWork: Type.Optional(Type.Boolean({ description: "'Allow work' toggle (default true). Pass false to create the task hidden from worker agents." })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!ctx.connected || !ctx.client) return ctx.notConnected;
      try {
        const resp = await ctx.client.request<{ type: string; message?: string; task?: BoardTask }>(
          {
            type: "board_create",
            summary: params.summary,
            description: params.description,
            column: params.column,
            parent: params.parent,
            inJira: params.inJira,
            level: params.level,
            epicId: params.epicId,
            backlog: params.backlog,
            group: params.group,
            priority: params.priority,
            model: params.model,
            allowWork: params.allowWork,
          },
          30_000
        );
        const jiraNote = resp.task?.key ? ` (Jira: ${resp.task.key})` : "";
        const locNote = resp.task?.location === "backlog" ? " in Backlog" : "";
        return boardOpResult(resp, `Created task [${resp.task?.id.slice(0, 8)}]${jiraNote}${locNote} "${params.summary}"`);
      } catch (err: unknown) {
        return errText(err);
      }
    },
  });

  pi.registerTool({
    name: "board_split_task",
    label: "Board: Split",
    description:
      "Subdivide a board task into subtasks. Each subtask lands in the parent's column; for Jira parents they are " +
      "created as real Jira sub-tasks. Use when a task is too big for one pass — then assign the subtasks out.",
    promptSnippet: "Split a board task into subtasks",
    promptGuidelines: [
      "Prefer board_split_task over ad-hoc notes when decomposing a board task — subtasks stay visible and assignable.",
    ],
    parameters: Type.Object({
      taskId: Type.String({ description: "Parent task id prefix or Jira key" }),
      subtasks: Type.Array(
        Type.Object({
          summary: Type.String({ description: "Subtask summary" }),
          description: Type.Optional(Type.String({ description: "Subtask description" })),
        }),
        { description: "Subtasks to create", minItems: 1 }
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!ctx.connected || !ctx.client) return ctx.notConnected;
      const made: string[] = [];
      const failed: string[] = [];
      for (const s of params.subtasks) {
        try {
          const resp = await ctx.client.request<{ type: string; message?: string; task?: BoardTask }>(
            { type: "board_create", summary: s.summary, description: s.description, parent: params.taskId },
            30_000
          );
          if (resp.type === "error") failed.push(`"${s.summary}": ${resp.message}`);
          else made.push(`[${resp.task?.id.slice(0, 8)}]${resp.task?.key ? ` ${resp.task.key}` : ""} ${s.summary}`);
        } catch (err: unknown) {
          failed.push(`"${s.summary}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const lines = [
        `${made.length ? "✅" : "❌"} Split ${params.taskId}: ${made.length}/${params.subtasks.length} subtask(s) created`,
        ...made.map((m) => `  • ${m}`),
        ...failed.map((f) => `  ❌ ${f}`),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  pi.registerTool({
    name: "board_flag_task",
    label: "Board: Flag",
    description:
      "Flag a board task as unclear (goal/scope/acceptance criteria ambiguous). The human operator is notified by mail " +
      "with your reason. Use BEFORE starting work you'd otherwise have to guess at. Pass clear: true to remove the flag.",
    promptSnippet: "Flag a board task as unclear",
    promptGuidelines: [
      "If an assigned board task is ambiguous, flag it with your questions instead of guessing.",
    ],
    parameters: Type.Object({
      taskId: Type.String({ description: "Task id prefix or Jira key" }),
      reason: Type.Optional(Type.String({ description: "What is unclear / your questions (required unless clearing)" })),
      clear: Type.Optional(Type.Boolean({ description: "Remove the unclear flag instead of setting it" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!ctx.connected || !ctx.client) return ctx.notConnected;
      try {
        const resp = await ctx.client.request<{ type: string; warning?: string; message?: string; task?: BoardTask }>(
          { type: "board_flag", taskId: params.taskId, reason: params.reason, clear: params.clear },
          30_000
        );
        return boardOpResult(
          resp,
          params.clear
            ? `Cleared unclear flag on ${resp.task?.key ?? params.taskId}`
            : `Flagged ${resp.task?.key ?? params.taskId} as unclear — operator notified`
        );
      } catch (err: unknown) {
        return errText(err);
      }
    },
  });

  pi.registerTool({
    name: "board_update_task",
    label: "Board: Update",
    description:
      "Update a board task's summary, description, priority and/or group. For Jira-synced tasks the edit is also pushed to the Jira issue. " +
      "Use this to make a vague task clear (e.g. after refining: goal, scope, acceptance criteria). " +
      "Priority: 'high', 'medium', 'low', or empty string to clear.",
    promptSnippet: "Edit a board task",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task id prefix or Jira key" }),
      summary: Type.Optional(Type.String({ description: "New summary" })),
      description: Type.Optional(Type.String({ description: "New description" })),
      group: Type.Optional(Type.String({ description: "Project group for the task (empty string to clear, omit to leave unchanged). Use favorites/mail_list_projects basenames as valid group names." })),
      priority: Type.Optional(Type.String({ description: "Priority: 'high', 'medium', 'low', or empty string to clear (omit to leave unchanged)" })),
      model: Type.Optional(Type.String({ description: "Per-task model override, e.g. 'openrouter/deepseek/deepseek-v4-pro' (empty string to clear, omit to leave unchanged)" })),
      allowWork: Type.Optional(Type.Boolean({ description: "'Allow work' toggle: false hides the task from worker agents and blocks assignment; true (default) makes it visible/assignable" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!ctx.connected || !ctx.client) return ctx.notConnected;
      try {
        const resp = await ctx.client.request<{ type: string; message?: string; task?: BoardTask }>(
          { type: "board_update", taskId: params.taskId, summary: params.summary, description: params.description, group: params.group, priority: params.priority, model: params.model, allowWork: params.allowWork },
          30_000
        );
        return boardOpResult(resp, `Updated ${resp.task?.key ?? params.taskId}`);
      } catch (err: unknown) {
        return errText(err);
      }
    },
  });

}
