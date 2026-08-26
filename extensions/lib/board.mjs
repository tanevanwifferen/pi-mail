/**
 * Task board state, helpers, project grouping, and progress-nudge for the
 * pi-mail daemon. Extracted from daemon.mjs. Depends on lib/core.mjs only.
 */

import fs from "node:fs";
import path from "node:path";
import {
  AGENT_DIR,
  HUMAN_AGENT_ID,
  agents,
  log,
  agentDisplayName,
  sendMail,
  resolveTarget,
} from "./core.mjs";
import { notifySSE } from "./sse-events.mjs";

// ── Task board + Jira sync ───────────────────────────────────────────────────
//
// A kanban-style task board shared by the whole federation, with optional
// two-way sync to a Jira sprint. Columns are configurable; a column may map to
// a Jira status (moves trigger the matching Jira transition) or be board-only
// (e.g. "Refine", "Review") with custom instructions that are mailed to the
// assignee. Assigning a task mails the assignee a full task package.

export const BOARD_FILE = path.join(AGENT_DIR, "mail-board.json");
export const JIRA_SYNC_INTERVAL_MS = 60_000;
export const DEFAULT_JQL = "assignee = currentUser() AND sprint in openSprints() ORDER BY rank";

export const DEFAULT_COLUMNS = [
  {
    id: "refine",
    name: "Refine",
    jiraStatus: null,
    instructions:
      "Board-only column. Refine this task: clarify the goal, acceptance criteria and implementation approach. " +
      "Post the refined spec as a board comment, then move the task to 'To Do'.",
  },
  { id: "todo", name: "To Do", jiraStatus: "To Do", instructions: "" },
  { id: "inprogress", name: "In Progress", jiraStatus: "In Progress", instructions: "" },
  {
    id: "review",
    name: "Review",
    jiraStatus: null,
    instructions:
      "Board-only column. Review the implementation for this task: correctness, tests, scope. " +
      "Post findings as a board comment. If clean, move to 'Done'; otherwise move back to 'In Progress' with what must change.",
  },
  { id: "done", name: "Done", jiraStatus: "Done", instructions: "" },
];

/**
 * @typedef {{ id: string, name: string, jiraStatus: string | null, instructions: string }} BoardColumn
 * @typedef {{ id: string, key: string | null, origin: "jira" | "local", summary: string,
 *             description: string, url: string | null, jiraStatus: string | null,
 *             columnId: string, assignee: string | null, priority: string | null,
 *             issueType: string | null, updatedAt: number,
 *             parentId: string | null, parentKey: string | null,
 *             pinned?: boolean, flagged: { by: string, reason: string, ts: number } | null,
 *             knownCommentIds?: string[],
 *             progressSince?: number, lastProgressTs?: number, lastNudgeTs?: number,
 *             location: "board" | "backlog" | "archive",
 *             level: "epic" | "story" | "task" | "subtask",
 *             epicId?: string | null,
 *             group?: string | null,
 *             allowWork?: boolean,
 *             model?: string | null,
 *             activity: Array<{ ts: number, who: string, text: string, kind?: string }> }} BoardTask
 *
 * parentId/parentKey — subtask linkage (board id and Jira key of the parent).
 * pinned — created in Jira from the board; kept synced even when it doesn't
 *          match the sprint JQL (fetched individually).
 * flagged — the "task is unclear" marker; set/cleared via board_flag.
 * knownCommentIds — Jira comment ids already mirrored into activity (dedup).
 * progressSince — ts lower bound for progress entries folded into the
 *                 description on the last move; advanced to now on each fold.
 * lastProgressTs — ts of the most recent kind:"progress" activity entry.
 * lastNudgeTs — ts of the most recent progress-nudge mail, for dedup.
 * location — where the task sits: "board" (a kanban column, columnId set),
 *            "backlog" (the shared backlog pool above the board, columnId null),
 *            or "archive" (the "done board", columnId null). Backlog + archive
 *            are LOCAL-ONLY — never pushed to Jira. For Jira-origin tasks this
 *            placement only sticks while the remote Jira status is unchanged:
 *            the next syncBoard() that sees a new remote status pulls the task
 *            back onto the board (into the mapped column), since Jira is the
 *            source of truth for Jira-origin tasks. Board-only tasks are never
 *            moved automatically.
 * level — issue hierarchy: epic > story > (task|subtask). Stories may carry an
 *         epicId pointing at their epic. Subtasks have a parentId (split).
 *         Local-only metadata (Jira issueType is synced separately as-is).
 * epicId — board id of the epic a story belongs to (optional; epics/stories
 *          are a local hierarchy layer, not a Jira epic-link).
 * group — the project group that owns this task (e.g. "reader",
 *         "secondbrain"). Snapshot stamped at create (creator's group) and
 *         re-stamped on assignment (assignee's group). When unset, derived
 *         live from the assignee's cwd basename. Drives same-group-only
 *         visibility for agents; the human operator sees every group.
 * allowWork — operator toggle (default true). When false the task is hidden
 *         from worker agents (board listings + get-by-id) and cannot be
 *         assigned/dispatched. The human operator and manager agents still
 *         see it so they can re-enable. Local-only — never pushed to Jira.
 * model — optional per-task model override (e.g.
 *         "openrouter/deepseek/deepseek-v4-pro"). Applied at dispatch: a
 *         worker spawned for the task is started with --model, and an
 *         already-running worker is switched via set_model. Unset = worker
 *         default.
 */
export let board = {
  config: {
    // Jira integration master switch. Defaults to true so existing users
    // with credentials keep Jira on (no behaviour change). When false the
    // board runs in board-only mode: jiraCfg() returns null (no network
    // calls, no sync, no push on move/comment/create) and boardState scrubs
    // every Jira ticket reference (key/status/url/origin/parentKey) from its
    // output so board_list_tasks and all board requests surface zero Jira
    // info. Set via the UI (Board → Settings) or the config endpoint.
    jiraEnabled: true,
    // Push sync toggle: when false, board→Jira push (transitions, comments,
    // assignments, description updates) is disabled, but Jira→board pull sync
    // continues to run. Defaults to true so both directions are active when
    // Jira is configured. Set via board config endpoint or UI.
    pushEnabled: true,
    baseUrl: process.env.JIRA_BASE_URL || "",
    email: process.env.JIRA_EMAIL || "",
    apiToken: process.env.JIRA_API_TOKEN || "",
    jql: process.env.JIRA_JQL || DEFAULT_JQL,
    // Project + issue types used when creating issues from the board.
    projectKey: process.env.JIRA_PROJECT_KEY || "",
    issueType: "Task",
    subtaskIssueType: "Sub-task",
    // Progress-nudge: mail in-progress assignees who haven't posted progress
    // in a while. Disableable + tunable from the board config endpoint.
    nudgeEnabled: true,
    nudgeIntervalMin: 60,
    // Middle-manager: an ephemeral agent spawned on a schedule that reviews
    // the board for the favorited (managed) projects, unblocks stuck workers,
    // and shepherds finished tasks into Done/Archive. Disabled by default;
    // no spawn when the favorites list is empty. See lib/middle-manager.mjs.
    mmEnabled: false,
    mmIntervalMin: 30,
    mmModel: "",
    mmMaxLifetimeMin: 15,
    // Worker reaper safety bound. A daemon-spawned worker (any plain spawn —
    // not an MM or CEO) that does not self-exit (mail_stop_self) within this
    // many minutes is force-killed by the reaper so hung/forgotten workers
    // never leak. Workers often run longer than a management pass, so the
    // default is generous (60); the reaper is a backstop, not the primary
    // path. See lib/middle-manager.mjs (reapWorkers) + the ephemerality
    // invariant in the README.
    workerMaxLifetimeMin: 60,
    // CEO (top-tier manager): an ephemeral agent spawned on a schedule that
    // reviews the federation at a higher level and spawns middle managers on
    // demand. When enabled, it REPLACES the daemon's fixed-interval MM timer
    // (the CEO becomes the sole MM spawner); the MM reaper still runs. See
    // lib/ceo.mjs. Disabled by default.
    ceoEnabled: false,
    ceoIntervalMin: 120,
    ceoModel: "",
    // Hostname allow-list for CEO spawning. When non-empty, the CEO tick only
    // spawns on hosts whose hostname matches at least one glob pattern (e.g.
    // ["server-*"]). Empty (default) means allow all hosts — backward compatible.
    ceoAllowedHosts: [],
    // The CEO is a ~15-minute management thread (operator invariant 7/9). This
    // is the hard safety bound: a CEO that does not self-exit within 15 min is
    // force-killed by the reaper. See lib/ceo.mjs + README ephemerality.
    ceoMaxLifetimeMin: 15,
    // MCP project chat: a chat worker (spawned by the chat_post MCP tool) that
    // has had no communication for this many minutes is auto-killed (idle
    // reaper in lib/chat.mjs). Chat workers are excluded from the MM worker
    // reaper so their lifetime is governed by activity, not a fixed bound.
    // Default 60 (one hour), per the feature spec. See lib/chat.mjs.
    chatIdleMin: 60,
  },
  /** @type {BoardColumn[]} */
  columns: DEFAULT_COLUMNS,
  /** @type {BoardTask[]} */
  tasks: [],
  lastSync: 0,
  /** @type {string | null} */
  syncError: null,
};

export let boardPersistTimer = null;
export function schedulePersistBoard() {
  if (boardPersistTimer) return;
  boardPersistTimer = setTimeout(() => {
    boardPersistTimer = null;
    flushBoard();
  }, 300);
  // Notify SSE clients so the web UI auto-refreshes
  notifySSE("board-update");
}
export function flushBoard() {
  try {
    fs.writeFileSync(BOARD_FILE, JSON.stringify(board), { mode: 0o600 });
  } catch (e) {
    log(`board persist failed: ${e.message}`);
  }
}

export function loadBoard() {
  try {
    const saved = JSON.parse(fs.readFileSync(BOARD_FILE, "utf8"));
    if (saved && typeof saved === "object") {
      // Saved config wins per-field; env vars remain fallback defaults.
      // Booleans (nudgeEnabled/mmEnabled) are restored even when false, so an
      // intentionally-disabled setting survives a restart.
      for (const k of ["baseUrl", "email", "apiToken", "jql", "projectKey", "issueType", "subtaskIssueType"]) {
        if (saved.config?.[k]) board.config[k] = saved.config[k];
      }
      for (const k of ["nudgeEnabled", "mmEnabled", "ceoEnabled", "jiraEnabled"]) {
        if (typeof saved.config?.[k] === "boolean") board.config[k] = saved.config[k];
      }
      for (const k of ["nudgeIntervalMin", "mmIntervalMin", "mmMaxLifetimeMin", "workerMaxLifetimeMin", "ceoIntervalMin", "ceoMaxLifetimeMin", "chatIdleMin"]) {
        if (typeof saved.config?.[k] === "number" && Number.isFinite(saved.config[k])) board.config[k] = saved.config[k];
      }
      if (typeof saved.config?.mmModel === "string") board.config.mmModel = saved.config.mmModel;
      if (typeof saved.config?.ceoModel === "string") board.config.ceoModel = saved.config.ceoModel;
      if (Array.isArray(saved.config?.ceoAllowedHosts)) board.config.ceoAllowedHosts = saved.config.ceoAllowedHosts;
      if (Array.isArray(saved.columns) && saved.columns.length > 0) board.columns = saved.columns;
      if (Array.isArray(saved.tasks)) board.tasks = saved.tasks;
      if (typeof saved.lastSync === "number") board.lastSync = saved.lastSync;
      // Backfill location/level for tasks saved before the backlog/archive +
      // epic/story hierarchy existed. Defaults: on-board, level inferred from
      // parentage (subtask if it has a parent, else task). Lossless.
      for (const t of board.tasks) {
        if (!t.location) t.location = "board";
        if (!t.level) t.level = t.parentId || t.parentKey ? "subtask" : "task";
        if (t.epicId === undefined) t.epicId = null;
        // allowWork backfill: tasks saved before the toggle existed default
        // to "allow work" (visible + assignable) — lossless for old boards.
        if (t.allowWork === undefined) t.allowWork = true;
        // group is left as-is when stamped; unset tasks derive it live from
        // their assignee (see taskGroup), so no backfill needed.
      }
      // Auto-restore backlog tasks to the first board column on restart (task a8edd985).
      // Ensures parked work is not forgotten across daemon cycles.
      const firstCol = board.columns[0];
      if (firstCol) {
        let restored = 0;
        for (const t of board.tasks) {
          if (t.location === "backlog") {
            t.location = "board";
            t.columnId = firstCol.id;
            restored++;
          }
        }
        if (restored) log(`Auto-restored ${restored} backlog task(s) to ${firstCol.name}`);
      }
    }
  } catch {
    // No board file yet — defaults apply.
  }
}

export function jiraCfg() {
  const c = board.config;
  // The master switch: when Jira is disabled the board runs in board-only
  // mode regardless of whether credentials are set — no sync, no push, no
  // network calls. Defaults to enabled (true) so existing users are
  // unaffected until they opt out.
  if (c.jiraEnabled === false) return null;
  return c.baseUrl && c.email && c.apiToken ? c : null;
}

/**
 * Whether board→Jira push should happen. Mirrors jiraCfg() but also requires
 * pushEnabled (default true) so push can be disabled independently while pull
 * continues to run. Returns the config object on success, null when push is off.
 */
export function jiraPushOk() {
  const cfg = jiraCfg();
  if (!cfg) return null;
  if (board.config.pushEnabled === false) return null;
  return cfg;
}

export function findBoardTask(spec) {
  if (!spec) return null;
  const s = String(spec);
  return (
    board.tasks.find((t) => t.id === s || t.id.startsWith(s)) ??
    board.tasks.find((t) => t.key && t.key.toLowerCase() === s.toLowerCase()) ??
    null
  );
}

export function findBoardColumn(spec) {
  if (!spec) return null;
  const s = String(spec).toLowerCase();
  return (
    board.columns.find((c) => c.id.toLowerCase() === s) ??
    board.columns.find((c) => c.name.toLowerCase() === s) ??
    null
  );
}

/** Map a Jira issue type name onto our local issue level. Best-effort; unknown
 *  types default to "task". Purely a display/local hint — the real Jira issue
 *  type is kept on task.issueType untouched. */
export function levelFromIssueType(name) {
  const n = String(name ?? "").toLowerCase();
  if (/^epic$/.test(n)) return "epic";
  if (/story/.test(n) || /^(user story)$/.test(n)) return "story";
  if (/sub[- ]?task/.test(n)) return "subtask";
  return "task";
}

export function taskActivity(task, who, text, kind) {
  task.activity.push({ ts: Date.now(), who, text, ...(kind ? { kind } : {}) });
  if (task.activity.length > 50) task.activity.splice(0, task.activity.length - 50);
  task.updatedAt = Date.now();
  if (kind === "progress") task.lastProgressTs = task.updatedAt;
}

/** Activity entries with kind "progress" that have been recorded since the
 *  last fold (>= progressSince). Used by boardMove to fold a summary of recent
 *  progress into the task description when it moves columns. */
export function progressEntriesSince(task) {
  const since = task.progressSince ?? 0;
  return (task.activity ?? []).filter((a) => (a.kind ?? "comment") === "progress" && a.ts >= since);
}

// ── Project grouping ────────────────────────────────────────────────────────
//
// Tasks are partitioned by "group" — the project group (cwd basename, e.g.
// "reader", "secondbrain") that owns them. An agent only sees/moves tasks in
// its own group; the human operator sees every group. The group is stamped on
// a task at create (the creator's group) and re-stamped on assignment (the
// assignee's group); when no stamp is present it is derived live from the
// assignee's cwd basename. Tasks with neither a stamp nor an assignable
// assignee have group null and are visible to everyone (so nothing historical
// gets hidden).

/** Project group (cwd basename) for a registered agent id. */
export function agentGroup(agentId) {
  if (agentId === HUMAN_AGENT_ID) return null;
  const cwd = agents.get(agentId)?.info.cwd;
  if (!cwd) return null;
  return path.basename(cwd) || cwd;
}

/** Resolve an assignee name (as stored on a task) back to a live agent id,
 *  then to its project group. Returns null when unresolvable. */
export function groupForName(name) {
  if (!name) return null;
  const id = resolveTarget(name);
  return id ? agentGroup(id) : null;
}

/** The effective group a task belongs to: stamped group, else derived live
 *  from the assignee's project, else null (visible to all). */
export function taskGroup(task) {
  if (task.group) return task.group;
  return groupForName(task.assignee);
}

/** Whether actor agentId may see/modify task (same group; human sees all;
 *  ungrouped tasks are visible to all). Manager agents (middle-manager OR
 *  CEO, registered via lib/middle-manager.mjs / lib/ceo.mjs) also see all
 *  groups — they oversee multiple projects, so the same-group partition must
 *  not hide tasks from them. The predicate is injected at startup to avoid a
 *  circular import (board.mjs ← manager modules ← board.mjs). */
export let managerAgentTest = null;
export function setManagerAgentTest(fn) { managerAgentTest = fn; }
/** Legacy alias kept for backward-compat with the MM module's own injection. */
export function setMmAgentTest(fn) { managerAgentTest = fn; }

export function canAccessGroup(actorId, task) {
  if (actorId === HUMAN_AGENT_ID) return true;
  if (managerAgentTest && managerAgentTest(actorId)) return true;
  const g = taskGroup(task);
  if (!g) return true;
  return g === agentGroup(actorId);
}

export function boardState(actorId, opts = {}) {
  // Group filter (task b59e930a): an explicit `group` param overrides the
  // default same-group scoping so the CEO/MM (or any caller) can list tasks
  // across every project's board in a single call, or for one specific group,
  // without spawning an MM per project. `group: "all"` returns every task;
  // `group: "<name>"` returns only that group's tasks. When omitted, the
  // default applies: agents see their own group only; the human operator and
  // manager agents (injected predicate) see all groups.
  // Ungrouped tasks (no stamped group and no derivable assignee group) are
  // shown to everyone so historical data isn't hidden.
  const groupFilter = opts.group;
  // Whether this actor is privileged to see hidden (allowWork:false) tasks and
  // all groups: the human operator, an unauthenticated caller, or a manager
  // agent (injected predicate). Used for both the group scoping below and the
  // "Allow work" gate further down.
  const privileged = !actorId || actorId === HUMAN_AGENT_ID || (managerAgentTest && managerAgentTest(actorId));
  let tasks;
  if (groupFilter === "all") {
    tasks = board.tasks;
  } else if (groupFilter) {
    tasks = board.tasks.filter((t) => taskGroup(t) === groupFilter);
  } else {
    tasks = privileged
      ? board.tasks
      : board.tasks.filter((t) => canAccessGroup(actorId, t));
  }
  // "Allow work" gate (task e6ac4fe0): tasks with allowWork === false are
  // hidden from worker agents (non-human, non-manager) across EVERY listing
  // path — including group:'all' and the get-by-id lookup board_get_task does
  // — so a hidden task can't be discovered by id either. The human operator
  // and manager agents still see them (so they can re-enable the toggle).
  if (!privileged) {
    tasks = tasks.filter((t) => t.allowWork !== false);
  }
  // Location/archive filter (task 6586b9ca) — single source of truth for the
  // board_list_tasks default: archived tasks are hidden unless explicitly
  // requested, and `location` filters to one pool ('board'|'backlog'|'archive').
  // OPT-IN: when neither `location` nor `includeArchived` is supplied the full
  // set (board + backlog + archive) is returned, so the raw board_state API and
  // the web UI (which want everything) are unaffected. Callers that want the
  // user-facing default (archive hidden) pass { includeArchived: false }.
  const wantLoc = opts.location;
  const showArchive = opts.includeArchived === true || wantLoc === "archive";
  if (wantLoc !== undefined || opts.includeArchived !== undefined) {
    tasks = tasks.filter((t) => {
      const loc = t.location ?? "board";
      if (wantLoc) return loc === wantLoc;
      return loc !== "archive" || showArchive;
    });
  }
  // Search filter (task 8f99ad0f): case-insensitive substring match against
  // summary, description, and task ID prefix. Intended for searching large
  // archive pools without pulling everything into context.
  if (opts.search) {
    const q = String(opts.search).toLowerCase();
    tasks = tasks.filter((t) =>
      t.summary.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.id.startsWith(q)
    );
  }
  // Sort archive tasks by archivedAt descending (task 8b3f4977).
  // Only applies when viewing the archive pool; non-archive tasks keep
  // their original (creation/column) order.
  if (wantLoc === "archive") {
    tasks = [...tasks].sort((a, b) => {
      const aArch = a.location === "archive";
      const bArch = b.location === "archive";
      if (aArch !== bArch) return aArch ? -1 : 1; // archive tasks first
      if (!aArch) return 0; // both non-archive: keep original order
      return (b.archivedAt ?? 0) - (a.archivedAt ?? 0); // newest first
    });
  }
  // Priority sort (task df729d21): when opts.sort === "priority", tasks are
  // ordered by priority level (high > medium > low > none) within each column.
  // The sort is stable so same-priority tasks keep their original order.
  if (opts.sort === "priority") {
    const rank = (p) => ({ high: 0, medium: 1, low: 2 })[p] ?? 3;
    tasks = [...tasks].sort((a, b) => rank(a.priority) - rank(b.priority));
  }
  // Jira-disable scrub (task 6e6e2ab2): the board runs board-only whenever
  // Jira is effectively off — either because the master switch is flipped
  // off (jiraEnabled:false) OR because no credentials are configured
  // (jiraCfg() returns null). In board-only mode no Jira ticket info may
  // surface in any board request. We scrub at this single choke point (every
  // read path — socket board_state, HTTP /api/board, the hosted MCP backend,
  // the stdio MCP's httpBackend — funnels through boardState) so
  // board_list_tasks and every board request contain zero Jira references,
  // including the per-column "(jira: …)" mapping annotations and jiraStatus
  // labels. Stored state is untouched: only the returned VIEW is scrubbed
  // (shallow copies), so adding credentials / re-enabling Jira restores the
  // keys on the next read.
  const jiraActive = !!jiraCfg();
  let viewTasks = tasks;
  let viewColumns = board.columns;
  if (!jiraActive) {
    viewTasks = tasks.map((t) =>
      t.origin === "jira" || t.key || t.jiraStatus || t.url || t.parentKey
        ? { ...t, key: null, jiraStatus: null, url: null, parentKey: null, origin: "local" }
        : t
    );
    viewColumns = board.columns.map((c) =>
      c.jiraStatus ? { ...c, jiraStatus: null } : c
    );
  }
  return {
    columns: viewColumns,
    tasks: viewTasks,
    jiraConfigured: jiraActive,
    /** Master switch value (task 6e6e2ab2): false = user explicitly disabled
     *  Jira. Distinct from `jiraConfigured` (creds present): the board is
     *  board-only (and the view scrubbed) whenever EITHER is false. */
    jiraEnabled: board.config.jiraEnabled !== false,
    lastSync: board.lastSync,
    syncError: board.syncError,
    myGroup: agentGroup(actorId) ?? null,
    /** The group filter actually applied (task b59e930a): "all", a specific
     *  group name, or null (default same-group/operator scoping). */
    group: groupFilter ?? null,
  };
}

/** Human-readable label for where a task sits: a column name, or
 *  "Backlog"/"Archive" for off-board tasks. */
export function taskLocationLabel(task) {
  if (task.location === "backlog") return "Backlog";
  if (task.location === "archive") return "Archive";
  const col = board.columns.find((c) => c.id === task.columnId);
  return col?.name ?? "?";
}

// taskMailBody, notifyAssignee, and nudgeIdleTasks were extracted to
// board-notify.mjs (they depend on this module's board state + helpers).
// Re-exported here so existing importers (daemon.mjs, board-ops.mjs) keep
// working without changing their import source.
export { taskMailBody, notifyAssignee, nudgeIdleTasks } from "./board-notify.mjs";
