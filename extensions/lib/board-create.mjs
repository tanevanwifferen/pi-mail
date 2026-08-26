/**
 * Board create / update / config operations for the pi-mail daemon.
 * Extracted from board-ops.mjs. Depends on lib/core.mjs, lib/board.mjs,
 * lib/jira.mjs. Re-exported from board-ops.mjs so consumers keep importing
 * from the single "./board-ops.mjs" surface.
 */
import {
  HUMAN_AGENT_ID,
  agentDisplayName,
  sendMail,
} from "./core.mjs";
import {
  board,
  DEFAULT_JQL,
  jiraCfg,
  jiraPushOk,
  findBoardTask,
  findBoardColumn,
  taskActivity,
  taskGroup,
  agentGroup,
  schedulePersistBoard,
} from "./board.mjs";
import {
  jiraCreateIssue,
  jiraUpdateIssue,
  syncBoard,
} from "./jira.mjs";

/**
 * Create a board task. With `parent`, it becomes a subtask of that task; when
 * the parent is a Jira issue (or `inJira` is set), a real Jira issue is
 * created too and kept in sync (pinned, so it survives JQL filtering).
 */
export async function boardCreate(actorId, { summary, description, column, parent, inJira, level, epicId, backlog, group, priority, model, allowWork } = {}) {
  const s = String(summary ?? "").trim();
  if (!s) return { error: "Summary is required" };
  const parentTask = parent ? findBoardTask(parent) : null;
  if (parent && !parentTask) return { error: `Parent task '${parent}' not found` };
  const toBacklog = !!backlog && !parentTask;
  const col = toBacklog
    ? null
    : (findBoardColumn(column) ??
      (parentTask ? board.columns.find((c) => c.id === parentTask.columnId) : null) ??
      board.columns[0]);
  const actor = agentDisplayName(actorId);
  // Level: explicit > inferred from parentage. A subtask (has a parent) is
  // "subtask"; an epic's child passed via parent is still a subtask. Epics and
  // stories are set explicitly by the caller (UI/MCP/agent tool).
  const lvl = String(level ?? "").trim().toLowerCase();
  const validLevels = new Set(["epic", "story", "task", "subtask"]);
  const finalLevel = validLevels.has(lvl)
    ? lvl
    : parentTask ? "subtask" : "task";
  // epicId: optional — links a story to its epic (board id). Validated loosely.
  let epicRef = null;
  if (epicId) {
    const epic = findBoardTask(epicId);
    if (epic) epicRef = epic.id;
  }
  const task = {
    id: crypto.randomUUID(),
    key: null,
    origin: "local",
    summary: s,
    description: String(description ?? "").trim(),
    url: null,
    jiraStatus: null,
    columnId: col ? col.id : null,
    assignee: null,
    priority: (["high", "medium", "low"].includes(String(priority ?? "").trim().toLowerCase()) ? String(priority).trim().toLowerCase() : null),
    issueType: null,
    parentId: parentTask?.id ?? null,
    parentKey: parentTask?.key ?? null,
    flagged: null,
    knownCommentIds: [],
    updatedAt: Date.now(),
    location: toBacklog ? "backlog" : "board",
    level: finalLevel,
    epicId: epicRef,
    // Per-task model override (e.g. "openrouter/deepseek/deepseek-v4-pro").
    // Empty/unset means the worker's default model. Applied at dispatch.
    model: model ? String(model).trim() : null,
    // "Allow work" toggle (task e6ac4fe0): when false the task is hidden
    // from worker agents and cannot be assigned. Default true (visible).
    allowWork: typeof allowWork === "boolean" ? allowWork : true,
    // Stamp the owning group: subtasks inherit their parent's group, otherwise
    // the creator's project group (human-created tasks get null here and are
    // (re)stamped when assigned to an agent).
    group: group?.trim() || (parentTask ? taskGroup(parentTask) : agentGroup(actorId)),
    activity: [
      {
        ts: Date.now(),
        who: actor,
        text: toBacklog
          ? `created in Backlog${parentTask ? ` as subtask of ${parentTask.key ?? parentTask.id.slice(0, 8)}` : ""}`
          : `created in ${col.name}${parentTask ? ` as subtask of ${parentTask.key ?? parentTask.id.slice(0, 8)}` : ""}`,
      },
    ],
  };

  // Create the Jira twin when the parent is a Jira issue or explicitly asked.
  const cfg = jiraCfg();
  if (inJira && !cfg) return { error: "Cannot create in Jira: Jira is not configured (board settings)" };
  if (cfg && (inJira || parentTask?.origin === "jira")) {
    const projectKey = parentTask?.key ? parentTask.key.split("-")[0] : board.config.projectKey;
    if (!projectKey) {
      return { error: "Cannot create in Jira: set a project key in board settings (or create under a Jira parent)" };
    }
    try {
      const key = await jiraCreateIssue({
        projectKey,
        summary: s,
        description: task.description,
        issueType: parentTask ? board.config.subtaskIssueType || "Sub-task" : board.config.issueType || "Task",
        parentKey: parentTask?.key ?? undefined,
      });
      task.key = key;
      task.origin = "jira";
      task.pinned = true;
      task.url = `${cfg.baseUrl.replace(/\/+$/, "")}/browse/${key}`;
      taskActivity(task, "jira", `created in Jira as ${key}`);
    } catch (e) {
      return { error: `Jira create failed: ${e.message}` };
    }
  }

  board.tasks.push(task);
  if (parentTask) taskActivity(parentTask, actor, `added subtask ${task.key ?? task.id.slice(0, 8)}: ${s}`);
  schedulePersistBoard();
  return { ok: true, task };
}

export async function boardUpdate(actorId, taskSpec, { summary, description, group, priority, model, allowWork } = {}) {
  const task = findBoardTask(taskSpec);
  if (!task) return { error: `Task '${taskSpec}' not found` };
  const actor = agentDisplayName(actorId);
  const changes = [];
  if (typeof summary === "string" && summary.trim()) {
    task.summary = summary.trim();
    changes.push("summary");
  }
  if (typeof description === "string") {
    task.description = description;
    changes.push("description");
  }
  if (typeof group === "string") {
    const g = group.trim();
    task.group = g || null;
    changes.push(g ? `group → ${g}` : "group (cleared)");
  }
  // priority: pass a string "high"|"medium"|"low" or an empty string to clear.
  // null/undefined/omitted means "no change".
  if (typeof priority === "string") {
    const p = priority.trim().toLowerCase();
    if (["high", "medium", "low"].includes(p)) {
      task.priority = p;
      changes.push(`priority → ${p}`);
    } else if (p === "") {
      task.priority = null;
      changes.push("priority (cleared)");
    } else {
      // unrecognized value — still set it to null as a safe default
      task.priority = null;
      changes.push("priority (cleared)");
    }
  }
  // model: pass a "provider/model" string, or an empty string to clear. A
  // bare model slug (no provider prefix) is stored as-is so a custom value
  // can be set before the model list is known.
  if (typeof model === "string") {
    const m = model.trim();
    if (m) {
      task.model = m;
      changes.push(`model → ${m}`);
    } else {
      task.model = null;
      changes.push("model (cleared)");
    }
  }
  // allowWork: boolean toggle (task e6ac4fe0). true = visible; false = hidden
  // from worker agents. Local-only — never pushed to Jira.
  if (typeof allowWork === "boolean") {
    if (task.allowWork !== allowWork) {
      task.allowWork = allowWork;
      changes.push(allowWork ? "allow work → on" : "allow work → off");
    }
  }
  if (!changes.length) return { error: "Nothing to update (pass summary, description, priority, group, model, and/or allowWork)" };
  let warning;
  if (task.origin === "jira" && jiraPushOk()) {
    try {
      await jiraUpdateIssue(task.key, {
        summary: changes.includes("summary") ? task.summary : undefined,
        description: changes.includes("description") ? task.description : undefined,
      });
    } catch (e) {
      warning = `edit not pushed to Jira: ${e.message}`;
      taskActivity(task, "board", warning);
    }
  }
  taskActivity(task, actor, `updated ${changes.join(", ")}${task.origin === "jira" && !warning ? " (pushed to Jira)" : ""}`);
  schedulePersistBoard();
  return { ok: true, task, warning };
}

export function boardSetConfig({ config, columns } = {}) {
  if (config && typeof config === "object") {
    for (const k of ["baseUrl", "email", "jql", "projectKey", "issueType", "subtaskIssueType"]) {
      if (typeof config[k] === "string") board.config[k] = config[k].trim();
    }
    if (typeof config.nudgeEnabled === "boolean") board.config.nudgeEnabled = config.nudgeEnabled;
    // Jira master switch (task 6e6e2ab2). Defaults to true; setting it false
    // disables Jira entirely (board-only mode): jiraCfg() returns null, sync
    // stops, and boardState scrubs Jira fields from output. Restored on restart
    // even when false. Note: disabling does NOT delete credentials, so toggling
    // back on resumes sync with the stored creds.
    if (typeof config.jiraEnabled === "boolean") board.config.jiraEnabled = config.jiraEnabled;
    if (typeof config.pushEnabled === "boolean") board.config.pushEnabled = config.pushEnabled;
    if (typeof config.nudgeIntervalMin === "number" && Number.isFinite(config.nudgeIntervalMin)) {
      board.config.nudgeIntervalMin = Math.max(1, Math.floor(config.nudgeIntervalMin));
    }
    // Middle-manager config (per-board). mmEnabled defaults false; the daemon
    // scheduler skips spawning when disabled or when the favorites list is
    // empty. See lib/middle-manager.mjs.
    if (typeof config.mmEnabled === "boolean") board.config.mmEnabled = config.mmEnabled;
    if (typeof config.mmIntervalMin === "number" && Number.isFinite(config.mmIntervalMin)) {
      board.config.mmIntervalMin = Math.max(1, Math.floor(config.mmIntervalMin));
    }
    if (typeof config.mmMaxLifetimeMin === "number" && Number.isFinite(config.mmMaxLifetimeMin)) {
      board.config.mmMaxLifetimeMin = Math.max(1, Math.floor(config.mmMaxLifetimeMin));
    }
    // Worker reaper safety bound (per-board). A daemon-spawned worker that
    // does not self-exit within this many minutes is force-killed so
    // hung/forgotten workers never leak. Default 30. See lib/middle-manager.mjs
    // (reapWorkers) + the README ephemerality invariant.
    if (typeof config.workerMaxLifetimeMin === "number" && Number.isFinite(config.workerMaxLifetimeMin)) {
      board.config.workerMaxLifetimeMin = Math.max(1, Math.floor(config.workerMaxLifetimeMin));
    }
    if (typeof config.mmModel === "string") board.config.mmModel = config.mmModel.trim();
    // CEO config (per-board). ceoEnabled defaults false. When enabled the CEO
    // replaces the daemon's fixed-interval MM timer (CEO becomes the sole MM
    // spawner); the MM reaper still runs. See lib/ceo.mjs.
    if (typeof config.ceoEnabled === "boolean") board.config.ceoEnabled = config.ceoEnabled;
    if (typeof config.ceoIntervalMin === "number" && Number.isFinite(config.ceoIntervalMin)) {
      board.config.ceoIntervalMin = Math.max(1, Math.floor(config.ceoIntervalMin));
    }
    if (typeof config.ceoMaxLifetimeMin === "number" && Number.isFinite(config.ceoMaxLifetimeMin)) {
      board.config.ceoMaxLifetimeMin = Math.max(1, Math.floor(config.ceoMaxLifetimeMin));
    }
    if (typeof config.ceoModel === "string") board.config.ceoModel = config.ceoModel.trim();
    if (Array.isArray(config.ceoAllowedHosts)) board.config.ceoAllowedHosts = config.ceoAllowedHosts.map((s) => String(s).trim()).filter(Boolean);
    // MCP project chat idle kill bound (per-board). A chat worker with no
    // communication for this many minutes is killed by the chat idle reaper
    // (lib/chat.mjs). Default 60 (one hour).
    if (typeof config.chatIdleMin === "number" && Number.isFinite(config.chatIdleMin)) {
      board.config.chatIdleMin = Math.max(1, Math.floor(config.chatIdleMin));
    }
    // Empty token means "keep the existing one" so the UI never has to echo it.
    if (typeof config.apiToken === "string" && config.apiToken.trim()) {
      board.config.apiToken = config.apiToken.trim();
    }
    if (!board.config.jql) board.config.jql = DEFAULT_JQL;
  }
  if (Array.isArray(columns) && columns.length > 0) {
    const cleaned = [];
    for (const c of columns) {
      const name = String(c?.name ?? "").trim();
      if (!name) continue;
      cleaned.push({
        id: String(c.id || name.toLowerCase().replace(/[^a-z0-9]+/g, "-")).trim(),
        name,
        jiraStatus: c.jiraStatus ? String(c.jiraStatus).trim() : null,
        instructions: String(c.instructions ?? ""),
      });
    }
    if (cleaned.length) {
      board.columns = cleaned;
      // Re-home ON-BOARD tasks whose column disappeared. Tasks in backlog or
      // archive (columnId null) stay put — they're intentionally off-board.
      const ids = new Set(cleaned.map((c) => c.id));
      for (const t of board.tasks) {
        if (t.columnId && !ids.has(t.columnId)) t.columnId = cleaned[0].id;
      }
    }
  }
  schedulePersistBoard();
  if (jiraCfg()) syncBoard("config change");
  return { ok: true };
}
