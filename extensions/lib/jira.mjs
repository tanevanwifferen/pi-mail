/**
 * Jira REST client + sprint sync (pull) for the pi-mail daemon.
 * Extracted from daemon.mjs. Depends on lib/board.mjs (board state + helpers)
 * and lib/core.mjs (log).
 */

import { log } from "./core.mjs";
import {
  board,
  DEFAULT_JQL,
  jiraCfg,
  findBoardTask,
  findBoardColumn,
  levelFromIssueType,
  taskActivity,
  schedulePersistBoard,
} from "./board.mjs";

// ── Jira client ──────────────────────────────────────────────────────────────

export async function jiraFetch(pathname, { method = "GET", body } = {}) {
  const cfg = jiraCfg();
  if (!cfg) throw new Error("Jira is not configured");
  const auth = Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString("base64");
  const res = await fetch(cfg.baseUrl.replace(/\/+$/, "") + pathname, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jira ${method} ${pathname.split("?")[0]} → HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const txt = await res.text().catch(() => "");
  return txt ? JSON.parse(txt) : {};
}

/** Extract plain text from an Atlassian Document Format node. */
export function adfToText(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  const kids = (node.content ?? []).map(adfToText).join("");
  const blocky = ["paragraph", "heading", "listItem", "codeBlock", "blockquote"];
  return blocky.includes(node.type) ? kids + "\n" : kids;
}

export function textToAdf(text) {
  const paragraphs = String(text)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] }));
  return {
    type: "doc",
    version: 1,
    content: paragraphs.length ? paragraphs : [{ type: "paragraph", content: [{ type: "text", text: " " }] }],
  };
}

export const JIRA_FIELDS = "summary,description,status,assignee,priority,issuetype,updated,parent,comment";

export async function jiraSearch(jql) {
  const issues = [];
  let pageToken = null;
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ jql, maxResults: "100", fields: JIRA_FIELDS });
    if (pageToken) qs.set("nextPageToken", pageToken);
    const data = await jiraFetch(`/rest/api/3/search/jql?${qs}`);
    issues.push(...(data.issues ?? []));
    if (!data.nextPageToken || (data.issues ?? []).length === 0) break;
    pageToken = data.nextPageToken;
  }
  return issues;
}

/** Transition a Jira issue to the named status. Requires a valid transition. */
export async function jiraTransitionTo(task, statusName) {
  const data = await jiraFetch(`/rest/api/3/issue/${task.key}/transitions`);
  const tr = (data.transitions ?? []).find(
    (t) => (t.to?.name ?? "").toLowerCase() === statusName.toLowerCase()
  );
  if (!tr) {
    throw new Error(
      `no Jira transition to "${statusName}" from "${task.jiraStatus}" (available: ${(data.transitions ?? [])
        .map((t) => t.to?.name)
        .filter(Boolean)
        .join(", ") || "none"})`
    );
  }
  await jiraFetch(`/rest/api/3/issue/${task.key}/transitions`, {
    method: "POST",
    body: { transition: { id: tr.id } },
  });
  task.jiraStatus = statusName;
}

/**
 * Assign or unassign a Jira issue. Resolves the assignee name to a Jira
 * accountId via user search (takes the first match). Pass an empty string
 * to unassign. Returns the accountId or null (unassigned).
 */
export async function jiraUpdateAssignee(key, assigneeName) {
  const name = String(assigneeName ?? "").trim();
  if (!name) {
    // Unassign: PUT with accountId: null
    await jiraFetch(`/rest/api/3/issue/${key}/assignee`, {
      method: "PUT",
      body: { accountId: null },
    });
    return null;
  }
  // Search for the Jira user by display name / email.
  const qs = new URLSearchParams({ query: name, maxResults: "5" });
  const results = await jiraFetch(`/rest/api/3/user/search?${qs}`);
  const user = (results ?? []).find(
    (u) =>
      (u.displayName ?? "").toLowerCase() === name.toLowerCase() ||
      (u.emailAddress ?? "").toLowerCase() === name.toLowerCase()
  ) ?? results?.[0];
  if (!user?.accountId) {
    throw new Error(
      `no Jira user found for "${name}" (searched by display name and email)`
    );
  }
  await jiraFetch(`/rest/api/3/issue/${key}/assignee`, {
    method: "PUT",
    body: { accountId: user.accountId },
  });
  return user.accountId;
}

/** @returns {Promise<string | null>} the created Jira comment id */
export async function jiraAddComment(key, text) {
  const r = await jiraFetch(`/rest/api/3/issue/${key}/comment`, {
    method: "POST",
    body: { body: textToAdf(text) },
  });
  return r?.id ?? null;
}

/** Create a Jira issue (optionally a sub-task under parentKey). @returns the new key */
export async function jiraCreateIssue({ projectKey, summary, description, issueType, parentKey }) {
  const r = await jiraFetch("/rest/api/3/issue", {
    method: "POST",
    body: {
      fields: {
        project: { key: projectKey },
        summary,
        issuetype: { name: issueType },
        ...(description ? { description: textToAdf(description) } : {}),
        ...(parentKey ? { parent: { key: parentKey } } : {}),
      },
    },
  });
  return r.key;
}

export async function jiraUpdateIssue(key, { summary, description }) {
  const fields = {};
  if (typeof summary === "string") fields.summary = summary;
  if (typeof description === "string") fields.description = textToAdf(description);
  if (!Object.keys(fields).length) return;
  await jiraFetch(`/rest/api/3/issue/${key}`, { method: "PUT", body: { fields } });
}

/** Mirror Jira comments into the task's activity log (deduped by comment id). */
export function importJiraComments(task, commentField) {
  const comments = commentField?.comments ?? [];
  if (!comments.length) return;
  task.knownCommentIds ??= [];
  for (const c of comments) {
    if (!c?.id || task.knownCommentIds.includes(c.id)) continue;
    task.knownCommentIds.push(c.id);
    const text = adfToText(c.body).trim();
    if (!text) continue;
    task.activity.push({
      ts: Date.parse(c.created) || Date.now(),
      who: `${c.author?.displayName ?? "someone"} (jira)`,
      text,
    });
  }
  task.activity.sort((a, b) => a.ts - b.ts);
  if (task.activity.length > 50) task.activity.splice(0, task.activity.length - 50);
  if (task.knownCommentIds.length > 200) task.knownCommentIds.splice(0, task.knownCommentIds.length - 200);
}

// ── Column mapping pull (fetch columns from Jira) ────────────────────────────

/**
 * Merge a set of remote Jira status names into the board's column list so the
 * local column↔jiraStatus mapping reflects the remote project's columns.
 * NON-DESTRUCTIVE — it only
 *   - promotes a same-named board-only column to Jira-mapped (sets its
 *     jiraStatus), and
 *   - adds a new Jira-mapped column for any remote status with no local
 *     counterpart (inserted after the last existing Jira-mapped column so
 *     mapped columns cluster together, ahead of any trailing board-only
 *     columns),
 * never removing user columns, board-only columns, or instructions. New
 * columns can be reordered/edited in Board → Settings. Pure: mutates the
 * passed `columns` array in place and returns what changed (for logging /
 * tests). Case-insensitive on status names.
 * @param {Array<{ id: string, name: string, jiraStatus: string | null, instructions: string }>} columns
 * @param {string[]} remoteStatuses
 * @returns {{ added: string[], promoted: string[] }}
 */
export function mergeJiraColumns(columns, remoteStatuses) {
  const added = [];
  const promoted = [];
  const lc = (s) => String(s ?? "").toLowerCase();
  for (const status of remoteStatuses) {
    if (!status) continue;
    // Already mapped (case-insensitive) → nothing to do.
    if (columns.some((c) => c.jiraStatus && lc(c.jiraStatus) === lc(status))) continue;
    // Promote a same-named board-only column to Jira-mapped (keeps its
    // id/name/instructions; just links it to the Jira status).
    const byName = columns.find((c) => !c.jiraStatus && lc(c.name) === lc(status));
    if (byName) {
      byName.jiraStatus = status;
      promoted.push(status);
      continue;
    }
    // New Jira-mapped column. Insert after the last Jira-mapped column so
    // mapped columns stay clustered (ahead of any trailing board-only
    // columns); append if there is no mapped column yet.
    const id =
      lc(status).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ||
      `col-${columns.length}`;
    const col = { id, name: status, jiraStatus: status, instructions: "" };
    let insertAfter = -1;
    for (let i = columns.length - 1; i >= 0; i--) {
      if (columns[i].jiraStatus) { insertAfter = i; break; }
    }
    columns.splice(insertAfter + 1, 0, col);
    added.push(status);
  }
  return { added, promoted };
}

/**
 * Pull the remote Jira project's board columns / statuses and merge them into
 * `board.columns` (non-destructive — see mergeJiraColumns). This is the
 * "fetch columns from Jira" half of a fetch-from-Jira pass; syncBoard calls it
 * on explicit fetches (manual / startup / config change), not on the 60s
 * interval. No-op (no network) when Jira is disabled or unconfigured, or when
 * no project key is set — so the feature makes no Jira calls in board-only
 * mode (task 6e6e2ab2).
 * @returns {Promise<{ ok: boolean, reason?: string, source?: string, added: string[], promoted: string[] }>}
 */
export async function fetchJiraColumns() {
  const cfg = jiraCfg();
  if (!cfg) return { ok: false, reason: "not-configured", added: [], promoted: [] };
  const projectKey = cfg.projectKey;
  if (!projectKey) return { ok: false, reason: "no-project-key", added: [], promoted: [] };
  let remoteStatuses = [];
  let source = "none";
  // Primary: the agile board configuration — the statuses actually laid out
  // on the project's board columns (excludes statuses not on the board).
  try {
    const qs = new URLSearchParams({ projectKeyOrId: projectKey, maxResults: "100" });
    const boards = await jiraFetch(`/rest/agile/1.0/board?${qs}`);
    const boardId = boards?.values?.[0]?.id;
    if (boardId != null) {
      const conf = await jiraFetch(`/rest/agile/1.0/board/${boardId}/configuration`);
      const cols = conf?.columnConfig?.columns ?? [];
      const names = new Set();
      for (const col of cols) for (const s of (col.statuses ?? [])) if (s?.name) names.add(s.name);
      if (names.size) { remoteStatuses = [...names]; source = `agile board ${boardId}`; }
    }
  } catch (e) {
    log(`fetchJiraColumns: agile board config unavailable: ${e.message}`);
  }
  // Fallback: the project's statuses (every status available to the project's
  // issue types). Used when the agile API is absent or the project has no
  // board configured.
  if (!remoteStatuses.length) {
    try {
      const arr = await jiraFetch(`/rest/api/3/project/${projectKey}/statuses`);
      const names = new Set();
      for (const it of (Array.isArray(arr) ? arr : [])) for (const s of (it.statuses ?? [])) if (s?.name) names.add(s.name);
      if (names.size) { remoteStatuses = [...names]; source = `project ${projectKey}`; }
    } catch (e) {
      log(`fetchJiraColumns: project statuses unavailable: ${e.message}`);
    }
  }
  if (!remoteStatuses.length) return { ok: false, reason: "no-statuses", source, added: [], promoted: [] };
  const { added, promoted } = mergeJiraColumns(board.columns, remoteStatuses);
  if (added.length || promoted.length) {
    log(`fetchJiraColumns: ${source} → added [${added.join(", ")}], promoted [${promoted.join(", ")}]`);
    schedulePersistBoard();
  }
  return { ok: true, source, added, promoted };
}

// ── Jira sync loop (pull) ────────────────────────────────────────────────────

export let boardSyncing = false;
export async function syncBoard(reason = "interval") {
  const cfg = jiraCfg();
  if (!cfg || boardSyncing) return;
  boardSyncing = true;
  let columnResult = null;
  try {
    // "Fetch from Jira" column refresh: on an explicit fetch (manual /
    // startup / config change) also pull the remote project's board columns
    // and merge the status mapping into board.columns (non-destructive — see
    // mergeJiraColumns). Skipped on the 60s interval so the periodic loop
    // stays lean; column layout changes rarely and the operator can always
    // hit "Fetch from Jira". No-op when Jira is off (fetchJiraColumns guards
    // on jiraCfg()).
    if (reason !== "interval") {
      try { columnResult = await fetchJiraColumns(); }
      catch (e) { log(`board sync: column fetch failed: ${e.message}`); }
    }
    const issues = await jiraSearch(cfg.jql || DEFAULT_JQL);
    const have = new Set(issues.map((i) => i.key));

    // Also pull subtasks of matched issues — they usually don't match the
    // sprint/assignee JQL themselves but belong on the board under the parent.
    const parentKeys = [...have];
    for (let i = 0; i < parentKeys.length; i += 50) {
      const chunk = parentKeys.slice(i, i + 50);
      const subs = await jiraSearch(`parent in (${chunk.join(",")})`);
      for (const s of subs) {
        if (!have.has(s.key)) {
          have.add(s.key);
          issues.push(s);
        }
      }
    }

    // Pinned tasks (created in Jira from the board) are synced individually so
    // they stay on the board even when they don't match the JQL. Skip tasks in
    // backlog/archive — those are local-only locations Jira can't see.
    for (const t of board.tasks) {
      if (t.origin !== "jira" || !t.pinned || have.has(t.key)) continue;
      if (t.location === "backlog" || t.location === "archive") continue;
      try {
        const iss = await jiraFetch(`/rest/api/3/issue/${t.key}?fields=${JIRA_FIELDS}`);
        have.add(iss.key);
        issues.push(iss);
      } catch (e) {
        if (/HTTP 404/.test(e.message)) {
          // Deleted in Jira — let the not-seen filter below remove it.
          log(`board sync: pinned ${t.key} was deleted in Jira`);
        } else {
          have.add(t.key); // transient error: keep the task, retry next sync
        }
      }
    }

    const fallbackCol = board.columns.find((c) => c.jiraStatus) ?? board.columns[0];
    const seen = new Set();
    for (const iss of issues) {
      seen.add(iss.key);
      const f = iss.fields ?? {};
      const status = f.status?.name ?? "";
      const mapped = board.columns.find(
        (c) => c.jiraStatus && c.jiraStatus.toLowerCase() === status.toLowerCase()
      );
      let task = board.tasks.find((t) => t.key === iss.key);
      if (!task) {
        task = {
          id: crypto.randomUUID(),
          key: iss.key,
          origin: "jira",
          summary: f.summary ?? iss.key,
          description: adfToText(f.description).trim(),
          url: `${cfg.baseUrl.replace(/\/+$/, "")}/browse/${iss.key}`,
          jiraStatus: status,
          columnId: (mapped ?? fallbackCol)?.id,
          assignee: null,
          priority: f.priority?.name ?? null,
          issueType: f.issuetype?.name ?? null,
          parentId: null,
          parentKey: f.parent?.key ?? null,
          flagged: null,
          knownCommentIds: [],
          updatedAt: Date.now(),
          location: "board",
          level: levelFromIssueType(f.issuetype?.name),
          epicId: null,
          allowWork: true,
          activity: [{ ts: Date.now(), who: "jira", text: `imported from Jira (status: ${status})` }],
        };
        board.tasks.push(task);
      } else {
        task.summary = f.summary ?? task.summary;
        task.description = adfToText(f.description).trim();
        task.priority = f.priority?.name ?? task.priority;
        task.issueType = f.issuetype?.name ?? task.issueType;
        task.parentKey = f.parent?.key ?? task.parentKey ?? null;
        // Remote status change wins: move the card to the mapped column, even
        // out of a board-only column. Unchanged remote status leaves any local
        // position alone. Backlog/archive only stay "sticky" while the remote
        // Jira status doesn't change — the moment Jira reports a new status,
        // the task is restored to the board into the mapped column (Jira is
        // the source of truth for Jira-origin tasks).
        if (status && status !== task.jiraStatus && task.location === "board") {
          task.jiraStatus = status;
          if (mapped) task.columnId = mapped.id;
          taskActivity(task, "jira", `Jira status changed → ${status}`);
        } else if (status && status !== task.jiraStatus) {
          const prevLocation = task.location;
          task.jiraStatus = status;
          if (mapped) task.columnId = mapped.id;
          task.location = "board";
          taskActivity(task, "jira", `Jira status changed → ${status} (restored from ${prevLocation})`);
        } else if (mapped && task.location === "board" && task.columnId !== mapped.id) {
          // Self-heal (task 4b60ea0b): the remote status is unchanged, but the
          // task's columnId doesn't match the column now mapped to that
          // status. This happens when a task was imported/synced before its
          // status had a column mapping (e.g. a non-English Jira status with
          // no matching column yet) — it landed in the fallback column and,
          // since its status never changed afterwards, was never corrected.
          // Once the mapping exists (via "Fetch from Jira" / manual column
          // edit), re-home it into the now-correct column on the next sync,
          // without touching jiraStatus or pushing anything to Jira.
          const prevColumn = board.columns.find((c) => c.id === task.columnId);
          task.columnId = mapped.id;
          taskActivity(
            task,
            "jira",
            `column corrected: ${prevColumn?.name ?? task.columnId ?? "?"} → ${mapped.name} (mapping for "${status}" was missing/fallback at import time)`
          );
        }
      }
      importJiraComments(task, f.comment);
    }
    // Link subtasks to their board parent (by Jira key) for the UI/tools.
    const byKey = new Map(board.tasks.filter((t) => t.key).map((t) => [t.key, t]));
    for (const t of board.tasks) {
      if (t.parentKey && !t.parentId) t.parentId = byKey.get(t.parentKey)?.id ?? null;
    }
    // Drop Jira tasks that left the sprint / no longer match the JQL.
    const before = board.tasks.length;
    board.tasks = board.tasks.filter((t) => t.origin !== "jira" || seen.has(t.key));
    if (board.tasks.length !== before) {
      log(`board sync: removed ${before - board.tasks.length} task(s) no longer in the sprint`);
    }
    board.lastSync = Date.now();
    board.syncError = null;
    schedulePersistBoard();
    return { columns: columnResult };
  } catch (e) {
    board.syncError = e?.message ?? String(e);
    log(`board sync failed (${reason}): ${board.syncError}`);
    return { columns: columnResult };
  } finally {
    boardSyncing = false;
  }
}

