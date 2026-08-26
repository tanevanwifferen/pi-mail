/**
 * The pi-mail board MCP server.
 *
 * Exposes the mail daemon's shared kanban task board to external MCP
 * clients (Claude Desktop, Cursor, …) over stdio. It is a thin shim: each
 * MCP tool maps one-to-one onto the daemon's existing HTTP board API
 * (extensions/daemon.mjs), so all board logic, Jira sync, and assignment
 * notifications stay in the daemon. The MCP surface mirrors the in-pi
 * `board_*` agent tools (extensions/index.ts) — same names, same
 * parameter shapes — so clients interact with the board the same way
 * agents do.
 *
 * Board operations run as the `human` agent (the daemon's HTTP API
 * attribute to HUMAN_AGENT_ID, same as the web UI). Configure the daemon
 * address via PI_MAIL_BASE_URL (or PI_MAIL_UI_HOST / PI_MAIL_UI_PORT).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BoardBackend, BoardOpResponse, ChatMessage } from "./types.js";
import { httpBackend } from "./http.js";
import { findTask, renderBoard, renderOpResult, renderTask } from "./format.js";

/** Common: find a task across the board, returning a "not found" string if missing.
 *  Fetches with group:'all' (task 16a594db) so a task is resolved by id across
 *  EVERY project group regardless of the caller's default same-group scoping —
 *  get-by-id must not be gated by the caller's own group (board_list_tasks can
 *  already list cross-group with group:'all', and get-by-id should be at least
 *  as permissive). */
async function loadTask(backend: BoardBackend, taskId: string) {
  const b = await backend.getBoard({ group: "all", includeArchived: true });
  const t = findTask(b, taskId);
  return { b, t };
}

/** Wrap an async handler so thrown BoardApiErrors surface as MCP tool errors. */
function toolError(err: unknown): { content: [{ type: "text"; text: string }]; isError: true } {
  const msg = err instanceof Error ? `❌ ${err.message}` : `❌ ${String(err)}`;
  return { content: [{ type: "text", text: msg }], isError: true };
}

/** ok result helper. */
function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Render a chat thread's history as readable text. */
function renderChatHistory(history: ChatMessage[] | undefined, threadId: string | undefined): string {
  if (!history || history.length === 0) return `Thread ${threadId ?? "?"}: (no messages yet)`;
  const lines = [`🧵 Thread ${threadId ?? "?"} — ${history.length} message(s)`, ""];
  for (const m of history) {
    const tag = m.direction === "reply" ? "🤖 agent" : "🙋 you";
    const when = new Date(m.timestamp).toLocaleString();
    lines.push(`${tag} (${when}):`);
    lines.push(m.body);
    lines.push("");
  }
  const last = history[history.length - 1];
  lines.push(last.direction === "reply" ? "✅ Answered." : "⏳ Waiting for the agent's reply…");
  return lines.join("\n").trimEnd();
}

/** Build the MCP server with all board tools registered.
 *  `backend` defaults to the HTTP-fetch backend (standalone stdio bridge);
 *  the daemon passes an in-process backend when it hosts /mcp directly. */
export function createBoardMcpServer(backend: BoardBackend = httpBackend): McpServer {
  const server = new McpServer({
    name: "pi-mail-board",
    version: "1.0.0",
  });
  const http = backend;

  // ── board_list_tasks ──────────────────────────────────────────────────────
  server.tool(
    "board_list_tasks",
    "List tasks on the shared pi-mail board, grouped by location/column (Backlog pool, then columns, then Archive when shown). By default archived tasks are hidden; pass includeArchived:true to see them. Use location to filter to 'board'|'backlog'|'archive', and level for 'epic'|'story'|'task'|'subtask'. mine:true shows only tasks assigned to the human agent. Pass group:'all' for every project's tasks (cross-group), or group:'<name>' for one project's tasks; omit for the default scoping.",
    {
      mine: z.boolean().optional().describe("Only show tasks assigned to the human agent (the MCP operator)"),
      location: z.string().optional().describe("Filter by location: 'board' (on a column), 'backlog', or 'archive'. Omit to see board + backlog (archive hidden unless includeArchived)."),
      level: z.string().optional().describe("Filter to a level: 'epic' | 'story' | 'task' | 'subtask'"),
      includeArchived: z.boolean().optional().describe("Include archived tasks (location='archive') in the listing"),
      group: z.string().optional().describe("Scope by project group: 'all' = every project's tasks (cross-group), or a specific group name. Omit for the default scoping."),
      search: z.string().optional().describe("Search query — case-insensitive match against summary, description, and task ID prefix. Use with location:'archive' to search archived tasks."),
    },
    async ({ mine, location, level, includeArchived, group, search }) => {
      try {
        // Delegate location/archive + group filtering to the daemon's boardState
        // (task 6586b9ca / b59e930a) — single source of truth. Default (no params)
        // hides the archive; backlog + board columns are shown.
        const b = await http.getBoard({ location, includeArchived: includeArchived ?? false, group, search });
        return ok(renderBoard(b, { mineAssignee: mine ? "human" : null, location, level, includeArchived, group }));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── board_get_task ────────────────────────────────────────────────────────
  server.tool(
    "board_get_task",
    "Get full details of one board task by id (8-char prefix ok) or Jira key: description, column, assignee, subtasks, column instructions, and recent activity.",
    {
      taskId: z.string().describe("Task id prefix (from board_list_tasks) or Jira key (e.g. PROJ-123)"),
    },
    async ({ taskId }) => {
      try {
        const { b, t } = await loadTask(http, taskId);
        if (!t) return ok(`Task not found: ${taskId}. Run board_list_tasks first.`);
        return ok(renderTask(t, b));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── board_move_task ───────────────────────────────────────────────────────
  server.tool(
    "board_move_task",
    "Move a board task to a column (by name or id) or to the 'backlog' / 'archive' pool. For Jira-mapped columns this also transitions the Jira issue; backlog/archive are local-only (never pushed to Jira). The assignee is mailed the new column's instructions.",
    {
      taskId: z.string().describe("Task id prefix or Jira key"),
      column: z.string().describe("Destination column name or id"),
      note: z.string().optional().describe("Optional note added to the activity log"),
    },
    async ({ taskId, column, note }) => {
      try {
        const resp = await http.moveTask(taskId, column, note);
        const { b, t } = await loadTask(http, taskId);
        const colName = t ? (b.columns.find((c) => c.id === t.columnId)?.name ?? column) : column;
        return ok(renderOpResult(resp, `Moved ${taskId} → ${colName}`));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── board_comment_task ────────────────────────────────────────────────────
  server.tool(
    "board_comment_task",
    "Add a comment to a board task's activity log. For Jira-synced tasks the comment is also posted to the Jira issue.",
    {
      taskId: z.string().describe("Task id prefix or Jira key"),
      text: z.string().describe("Comment text"),
    },
    async ({ taskId, text }) => {
      try {
        const resp = await http.commentTask(taskId, text);
        return ok(renderOpResult(resp, `Comment added to ${taskId}`));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── board_progress_task ───────────────────────────────────────────────────
  server.tool(
    "board_progress_task",
    "Post a progress update on a board task you're working on. Progress is internal (not posted to Jira); it shows in the task detail view and is folded into the description when the task moves columns, so the next agent inherits a snapshot. Use this to report what's done / what's blocking, especially before moving the task onward.",
    {
      taskId: z.string().describe("Task id prefix or Jira key"),
      text: z.string().describe("What you've done since the last update, and anything blocking you"),
    },
    async ({ taskId, text }) => {
      try {
        const resp = await http.progressTask(taskId, text);
        return ok(renderOpResult(resp, `Progress posted on ${taskId}`));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── board_assign_task ────────────────────────────────────────────────────
  server.tool(
    "board_assign_task",
    "Assign a board task to a federation agent by name. The assignee is mailed the full task package (description + column instructions + tool crib). Use newSession:true to start them on a fresh session.",
    {
      taskId: z.string().describe("Task id prefix or Jira key"),
      assignee: z.string().describe("Agent display name (from mail_list_agents) or id prefix"),
      newSession: z.boolean().optional().describe("Start the assignee on a fresh session"),
    },
    async ({ taskId, assignee, newSession }) => {
      try {
        const resp = await http.assignTask(taskId, assignee, newSession);
        return ok(renderOpResult(resp, `Assigned ${taskId} to ${assignee}`));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── board_create_task ────────────────────────────────────────────────────
  server.tool(
    "board_create_task",
    "Create a new task on the shared board. With `parent` it becomes a subtask; when the parent is a Jira issue (or inJira is true) a real Jira issue is created and kept in sync. Otherwise board-only.",
    {
      summary: z.string().describe("One-line task summary"),
      description: z.string().optional().describe("Full task description"),
      column: z.string().optional().describe("Column name or id (defaults to the parent's column, else the first column). Ignored when backlog:true."),
      parent: z.string().optional().describe("Parent task id prefix or Jira key — makes this a subtask"),
      inJira: z.boolean().optional().describe("Create a Jira issue for a top-level task (needs a project key in board settings)"),
      level: z.string().optional().describe("Issue hierarchy: 'epic' | 'story' | 'task' | 'subtask' (local-only; defaults to 'task', or 'subtask' with a parent)"),
      epicId: z.string().optional().describe("Board id/prefix of the epic a story belongs to"),
      backlog: z.boolean().optional().describe("Create in the Backlog pool (off-board, local-only) instead of a column"),
      group: z.string().optional().describe("Project group name for the task (omit for ungrouped/current behavior)"),
      model: z.string().optional().describe("Per-task model override, e.g. 'openrouter/deepseek/deepseek-v4-pro' (omit for the worker's default)"),
    },
    async ({ summary, description, column, parent, inJira, level, epicId, backlog, group, model }) => {
      try {
        const resp: BoardOpResponse = await http.createTask({ summary, description, column, parent, inJira, level, epicId, backlog, group, model });
        const id = (resp.taskId ?? resp.task?.id ?? "?").slice(0, 8);
        const key = resp.key ?? resp.task?.key;
        const jiraNote = key ? ` (Jira: ${key})` : "";
        return ok(renderOpResult(resp, `Created task [${id}]${jiraNote} "${summary}"`));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── board_split_task ─────────────────────────────────────────────────────
  server.tool(
    "board_split_task",
    "Subdivide a board task into subtasks. Each subtask lands in the parent's column; for Jira parents they are created as real Jira sub-tasks. Use when a task is too big for one pass — then assign the subtasks out.",
    {
      taskId: z.string().describe("Parent task id prefix or Jira key"),
      subtasks: z
        .array(
          z.object({
            summary: z.string().describe("Subtask summary"),
            description: z.string().optional().describe("Subtask description"),
          }),
        )
        .min(1)
        .describe("Subtasks to create"),
    },
    async ({ taskId, subtasks }) => {
      const made: string[] = [];
      const failed: string[] = [];
      for (const s of subtasks) {
        try {
          const resp = await http.createTask({ summary: s.summary, description: s.description, parent: taskId });
          if (resp.error) {
            failed.push(`"${s.summary}": ${resp.error}`);
          } else {
            const id = (resp.taskId ?? resp.task?.id ?? "?").slice(0, 8);
            const key = resp.key ?? resp.task?.key;
            made.push(`[${id}]${key ? ` ${key}` : ""} ${s.summary}`);
          }
        } catch (err) {
          failed.push(`"${s.summary}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const lines = [
        `${made.length ? "✅" : "❌"} Split ${taskId}: ${made.length}/${subtasks.length} subtask(s) created`,
        ...made.map((m) => `  • ${m}`),
        ...failed.map((f) => `  ❌ ${f}`),
      ];
      return ok(lines.join("\n"));
    },
  );

  // ── board_update_task ────────────────────────────────────────────────────
  server.tool(
    "board_update_task",
    "Edit a board task's summary and/or description. For Jira tasks the edit is pushed to the Jira issue — treat the description as the shared spec.",
    {
      taskId: z.string().describe("Task id prefix or Jira key"),
      summary: z.string().optional().describe("New summary"),
      description: z.string().optional().describe("New description"),
      group: z.string().optional().describe("Project group for the task (empty string to clear, omit to leave unchanged)"),
      model: z.string().optional().describe("Per-task model override (empty string to clear, omit to leave unchanged)"),
      allowWork: z.boolean().optional().describe("'Allow work' toggle: false hides the task from worker agents and blocks assignment; true (default) makes it visible/assignable"),
    },
    async ({ taskId, summary, description, group, model, allowWork }) => {
      try {
        const resp = await http.updateTask(taskId, { summary, description, group, model, allowWork });
        return ok(renderOpResult(resp, `Updated ${taskId}`));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── board_flag_task ──────────────────────────────────────────────────────
  server.tool(
    "board_flag_task",
    "Mark a board task as unclear (notifies the operator) or clear the flag once refined. Set with a reason before guessing; clear it after the spec is written into the description.",
    {
      taskId: z.string().describe("Task id prefix or Jira key"),
      reason: z.string().optional().describe("Why the task is unclear (required to set; ignored when clearing)"),
      clear: z.boolean().optional().describe("Clear an existing unclear flag"),
    },
    async ({ taskId, reason, clear }) => {
      try {
        const resp = await http.flagTask(taskId, reason, clear);
        const action = clear ? "cleared unclear flag" : `flagged unclear${reason ? `: ${reason}` : ""}`;
        return ok(renderOpResult(resp, `${taskId} ${action}`));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── get_board_config ─────────────────────────────────────────────────────
  server.tool(
    "get_board_config",
    "Read the board + Jira configuration (columns, JQL, project key, whether the API token is set, last sync).",
    {},
    async () => {
      try {
        const cfg = await http.getBoardConfig();
        return ok(JSON.stringify(cfg, null, 2));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── set_board_config ─────────────────────────────────────────────────────
  server.tool(
    "set_board_config",
    "Update board + Jira configuration (jiraEnabled, baseUrl, email, apiToken, jql, projectKey, issueType, subtaskIssueType, columns). Set jiraEnabled:false to disable Jira entirely (board-only mode: no sync, no push, Jira fields hidden from output). Use to enable/disable Jira sync.",
    {
      config: z.record(z.unknown()).describe("Partial board config object"),
    },
    async ({ config }) => {
      try {
        const resp = await http.setBoardConfig(config);
        return ok(`✅ Board config updated\n${JSON.stringify(resp, null, 2)}`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── sync_board ────────────────────────────────────────────────────────────
  server.tool(
    "sync_board",
    "Trigger a manual fetch from Jira: pull remote issue state AND refresh the board's column↔status mapping from the remote project's columns (non-destructive — adds missing Jira statuses, promotes same-named board-only columns, never removes your columns/instructions). Only when Jira is enabled and configured; a no-op otherwise.",
    {},
    async () => {
      try {
        const r = await http.syncBoard();
        const lines = [];
        if (r.ok === false) {
          lines.push(`❌ ${r.error || "fetch failed"}`);
        } else {
          lines.push("✅ Fetched from Jira (issues + columns)");
          if (r.columns?.ok) {
            const parts = [];
            if (r.columns.added?.length) parts.push(`added ${r.columns.added.join(", ")}`);
            if (r.columns.promoted?.length) parts.push(`promoted ${r.columns.promoted.join(", ")}`);
            lines.push(`Columns (${r.columns.source}): ${parts.length ? parts.join("; ") : "no changes — mapping already up to date"}`);
          } else if (r.columns && r.columns.ok === false) {
            lines.push(`Columns: not refreshed (${r.columns.reason ?? "unavailable"})`);
          }
        }
        lines.push(JSON.stringify(r, null, 2));
        return ok(lines.join("\n"));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── list_projects ────────────────────────────────────────────────────────
  // Surfaces the daemon's project registry (favorites + recent spawn history)
  // so MCP clients can discover project paths for chat_post cwd. Each entry
  // indicates whether a live agent is currently running in that dir.
  server.tool(
    "list_projects",
    "List known project directories (favorites + recent spawn history) so you can discover the correct cwd for chat_post. Each entry shows the absolute path, whether a spawned agent is currently alive there, and (for history) the last spawn time + count. Use this before chat_post when you don't know the project's absolute path.",
    {},
    async () => {
      try {
        const projects = await http.listProjects();
        const lines: string[] = [];
        if (projects.favorites && projects.favorites.length) {
          lines.push("⭐ Favorites:");
          for (const p of projects.favorites) {
            lines.push(`  ${p.cwd}${p.alive ? " 🟢" : ""}`);
          }
          lines.push("");
        }
        if (projects.history && projects.history.length) {
          lines.push("🕐 Recent:");
          for (const p of projects.history) {
            const ago = Math.round((Date.now() - p.lastSpawnedAt) / 60000);
            lines.push(`  ${p.cwd}${p.alive ? " 🟢" : ""}  (${p.count} spawns, last ${ago}m ago as "${p.lastName}")`);
          }
        }
        if (!lines.length) return ok("No project directories recorded yet. Spawn an agent first, or pass an absolute cwd to chat_post directly.");
        return ok(lines.join("\n"));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── chat_post ─────────────────────────────────────────────────────────────
  // Multi-turn chat with a project's spawned agent over pi-mail. Spawns (or
  // reuses) a chat worker for the project cwd, delivers the question, and
  // (by default) blocks until the agent replies. See lib/chat.mjs.
  server.tool(
    "chat_post",
    "Send a question to a project's chat agent over pi-mail. With no thread_id, starts a new thread (spawns a chat worker for the project cwd) and returns a thread_id. With an existing thread_id, continues the multi-turn conversation. By default (wait=true) blocks until the agent replies and returns the answer + thread_id; pass wait:false to get the thread_id immediately and fetch the answer later with chat_get. The agent is auto-killed after 1h of no communication. Use list_projects first if you don't know the project's absolute path.",
    {
      cwd: z.string().describe("Absolute working directory of the project to chat with (discover via list_projects if unknown)"),
      message: z.string().describe("The question / message to send to the project's agent"),
      thread_id: z.string().optional().describe("Existing thread id to continue a multi-turn chat; omit to start a new thread"),
      wait: z.boolean().optional().describe("When true (default), block until the agent replies and return the answer. When false, return the thread_id immediately."),
      timeout_ms: z.number().optional().describe("Per-request wait timeout in ms (default 120000). Only used when wait is true."),
    },
    async ({ cwd, message, thread_id, wait, timeout_ms }) => {
      try {
        const r = await http.chatPost({ cwd, message, threadId: thread_id, wait: wait !== false, timeoutMs: timeout_ms });
        if (r.error) return ok(`❌ ${r.error}

💡 Run list_projects to discover available project paths.`);
        if (wait === false || (!r.answer && !r.history)) {
          return ok(`🧵 Thread ${r.threadId} — question sent. Use chat_get with this thread_id to fetch the answer.`);
        }
        const body = r.answer ?? r.history?.[r.history.length - 1]?.body ?? "";
        return ok(`🧵 Thread ${r.threadId}\n\n${renderChatHistory(r.history, r.threadId)}\n\n── answer ──\n${body}`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── chat_get ──────────────────────────────────────────────────────────────
  // Fetch a chat thread's mail history. Blocks (non-busy, event-driven) until
  // the LAST message in the thread is a reply from the agent — so no polling:
  // the caller waits only when an answer is pending, and resolves the moment it
  // lands. Returns the full thread history (oldest-first).
  server.tool(
    "chat_get",
    "Get the mail history for a chat thread. Blocks until the last message in the thread is an answer from the agent (so no polling — the call resolves the moment the agent replies). Returns the full thread history, oldest-first. Use the thread_id from a prior chat_post (with wait:false).",
    {
      thread_id: z.string().describe("Thread id (from a prior chat_post) whose history to fetch"),
      timeout_ms: z.number().optional().describe("Per-request wait timeout in ms (default 120000)."),
    },
    async ({ thread_id, timeout_ms }) => {
      try {
        const r = await http.chatGet({ threadId: thread_id, timeoutMs: timeout_ms });
        if (r.error) return ok(`❌ ${r.error}`);
        return ok(renderChatHistory(r.history, r.threadId));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── list_mail ─────────────────────────────────────────────────────────────
  server.tool(
    "list_mail",
    "List mail messages with pagination (newest-first). Use cursor for the next page; limit max 200. Filter by archived status (include|exclude|only), sender (from), recipient (to), or conversation partner (involves).",
    {
      limit: z.number().optional().describe("Page size (default 50, max 200)"),
      cursor: z.string().optional().describe("Opaque cursor from a previous list_mail response for the next page"),
      archived: z.string().optional().describe("Filter: 'include' (default), 'exclude' (inbox only), or 'only' (archived only)"),
      to: z.string().optional().describe("Filter by recipient agent name or id"),
      from: z.string().optional().describe("Filter by sender agent name or id"),
      involves: z.string().optional().describe("Filter: messages involving this agent (as sender or recipient)"),
    },
    async ({ limit, cursor, archived, to, from, involves }) => {
      try {
        const r = await (http as any).listMessages({ limit, cursor, archived, to, from, involves });
        if (r.error) return ok(`❌ ${r.error}`);
        if (!r.messages) return ok("No messages found.");
        const lines = [`📬 ${r.messages.length} message(s) · total: ${r.total ?? "?"}${r.hasMore ? " · more available" : ""}`];
        for (const m of r.messages) {
          const date = new Date(m.timestamp).toLocaleString();
          const dir = m.fromId === "00000000-0000-0000-0000-000000000000" ? "📤 sent" : "📥 received";
          lines.push(`${dir}  ${date}  ${m.fromName || m.fromId?.slice(0, 8)} → ${m.toName || m.toId?.slice(0, 8)}  [${m.id?.slice(0, 8)}]`);
          if (m.subject) lines.push(`   subject: ${m.subject}`);
        }
        if (r.nextCursor) lines.push(`\n→ next cursor: ${r.nextCursor}`);
        return ok(lines.join("\n"));
      } catch (e) { return toolError(e); }
    },
  );

  // ── read_mail ──────────────────────────────────────────────────────────────
  server.tool(
    "read_mail",
    "Read a single mail message in full by its ID (first 8 chars are enough). Returns the full message body and metadata.",
    {
      message_id: z.string().describe("Message ID or prefix (from list_mail output)"),
    },
    async ({ message_id }) => {
      try {
        const r = await (http as any).listMessages({ limit: 200, archived: "include" });
        if (r.error) return ok(`❌ ${r.error}`);
        const msg = (r.messages || []).find((m: any) => m.id?.startsWith(message_id));
        if (!msg) return ok(`Message not found: ${message_id}. Try list_mail first.`);
        const date = new Date(msg.timestamp).toLocaleString();
        const lines = [
          `📧 Message ${msg.id}`,
          `From: ${msg.fromName || msg.fromId}`,
          `To: ${msg.toName || msg.toId}`,
          `Date: ${date}`,
          `Subject: ${msg.subject || "(no subject)"}`,
          `Archived: ${msg.archived ? "yes" : "no"}`,
          "",
          msg.body || "(empty body)",
        ];
        return ok(lines.join("\n"));
      } catch (e) { return toolError(e); }
    },
  );

  // ── search_mail ────────────────────────────────────────────────────────────
  server.tool(
    "search_mail",
    "Search mail messages by keyword in subject and body. Returns matching messages newest-first (up to 50).",
    {
      query: z.string().describe("Search keyword — case-insensitive match against subject and body"),
    },
    async ({ query }) => {
      try {
        const q = String(query ?? "").toLowerCase();
        if (!q) return ok("❌ query is required");
        const r = await (http as any).listMessages({ limit: 200, archived: "include" });
        if (r.error) return ok(`❌ ${r.error}`);
        const matches = (r.messages || []).filter((m: any) => (m.subject || "").toLowerCase().includes(q) || (m.body || "").toLowerCase().includes(q));
        if (!matches.length) return ok(`No messages matching "${query}".`);
        const lines = [`🔍 ${matches.length} match(es) for "${query}":`];
        for (const m of matches.slice(0, 50)) {
          const date = new Date(m.timestamp).toLocaleString();
          lines.push(`[${m.id?.slice(0, 8)}] ${date}  ${m.fromName || m.fromId?.slice(0, 8)} → ${m.toName || m.toId?.slice(0, 8)}  ${m.subject || "(no subject)"}`);
        }
        return ok(lines.join("\n"));
      } catch (e) { return toolError(e); }
    },
  );

  return server;
}
