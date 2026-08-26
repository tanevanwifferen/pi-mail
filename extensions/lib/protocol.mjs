/**
 * Socket protocol message handler for the pi-mail daemon.
 * Extracted from daemon.mjs. Depends on core, board-ops, and spawn modules.
 */

import {
  agents,
  mailboxes,
  send,
  sendMail,
  broadcastMail,
  log,
  startHeartbeat,
  federationAgents,
} from "./core.mjs";
import { boardState } from "./board.mjs";
import {
  boardMove,
  boardAssign,
  boardComment,
  boardProgress,
  boardCreate,
  boardUpdate,
  boardFlag,
  boardSetConfig,
} from "./board-ops.mjs";
import {
  spawnAgent,
  stopAgent,
  stopSelf,
  spawnState,
  listSpawnDir,
  setFavorite,
  projectsState,
  spawnRegistry,
} from "./spawn.mjs";
import { mmTick, mmState, mmKickoff } from "./middle-manager.mjs";
import { ceoTick, ceoState, ceoKickoff } from "./ceo.mjs";
import { chatPost, chatGet, chatState } from "./chat.mjs";
import os from "node:os";
import { notifySSE } from "./sse-events.mjs";

// ── Message handler ───────────────────────────────────────────────────────────

export function handleMessage(agentId, msg, socket) {
  // Echo _reqId back so the client can match responses to requests by ID
  const reqId = msg._reqId;
  const reply = (payload) => send(socket, reqId != null ? { ...payload, _reqId: reqId } : payload);

  switch (msg.type) {
    case "register": {
      // Allow re-registration (e.g. reconnect or reload with same agentId)
      const existing = agents.get(msg.agentId);
      if (existing) {
        clearInterval(existing.pingTimer);
        // Close the old socket so it doesn't linger without heartbeat monitoring
        if (existing.conn !== socket) existing.conn.destroy();
      }
      const info = {
        agentId: msg.agentId,
        agentName: msg.agentName ?? msg.agentId,
        registeredAt: existing?.info.registeredAt ?? Date.now(),
        // Preserve a previously set status across reconnects / re-registration
        status: existing?.info.status ?? "",
        contextPct: existing?.info.contextPct ?? null,
        // Working directory of the agent process, used to group agents by
        // project. Updated on every (re)register so a moved dir is reflected.
        cwd: msg.cwd ?? existing?.info.cwd ?? "",
        model: msg.model ?? existing?.info.model ?? "",
      };
      agents.set(msg.agentId, {
        conn: socket,
        info,
        pingTimer: null,
        pongPending: false,
        lastSeen: Date.now(),
      });
      startHeartbeat(msg.agentId);
      reply({ type: "registered", agentId: msg.agentId });
      notifySSE("agents-changed");
      log(`Registered: ${info.agentName} (${msg.agentId.slice(0, 8)})`);
      break;
    }

    case "unregister": {
      const agent = agents.get(agentId);
      // Only honour unregister if this socket is still the active connection.
      // Guards against a reload race where the old socket unregisters after the
      // new socket has already taken over the same agentId.
      if (agent && agent.conn === socket) {
        clearInterval(agent.pingTimer);
        agents.delete(agentId);
        mailboxes.delete(agentId); // Clean exit clears mailbox
        notifySSE("agents-changed");
        log(`Unregistered: ${agent.info.agentName}`);
      }
      reply({ type: "ok" });
      break;
    }

    case "send": {
      try {
        const r = sendMail(agentId, msg.to, msg.subject, msg.body, {
          newSession: !!msg.newSession,
        });
        if (r.error) {
          reply({ type: "error", message: r.error });
        } else {
          reply({ type: "sent", messageId: r.messageId });
        }
      } catch (e) {
        reply({ type: "error", message: e?.message ?? "send failed" });
      }
      break;
    }

    case "broadcast": {
      const r = broadcastMail(agentId, msg.subject, msg.body);
      reply({ type: "sent", recipients: r.recipients });
      log(
        `Broadcast from ${agents.get(agentId)?.info.agentName ?? agentId.slice(0, 8)} → ${r.recipients} agent(s)`
      );
      break;
    }

    case "list_mail": {
      const messages = mailboxes.get(agentId) ?? [];
      reply({ type: "mail", messages });
      break;
    }

    case "set_name": {
      const agent = agents.get(agentId);
      if (agent) {
        agent.info.agentName = msg.agentName ?? agent.info.agentName;
        log(`Renamed ${agentId.slice(0, 8)} → ${agent.info.agentName}`);
      }
      reply({ type: "ok" });
      break;
    }

    case "set_status": {
      const agent = agents.get(agentId);
      if (agent) {
        agent.info.status = msg.status ?? "";
      }
      reply({ type: "ok" });
      break;
    }

    case "set_context": {
      const agent = agents.get(agentId);
      if (agent) {
        agent.info.contextPct = typeof msg.pct === "number" ? msg.pct : null;
      }
      // fire-and-forget: no response needed
      break;
    }

    case "set_model": {
      const agent = agents.get(agentId);
      if (agent) {
        agent.info.model = msg.model ?? "";
      }
      // fire-and-forget: no response needed
      break;
    }

    case "list_agents": {
      // Include the human so agents can discover and reply to the operator.
      reply({ type: "agents", agents: federationAgents() });
      break;
    }

    case "prune_silent": {
      // Remove agents that haven't responded to a ping in `olderThanMs` ms.
      // The caller (slash command) typically waits N seconds after a broadcast
      // probe before calling this, giving live agents time to respond.
      const threshold = typeof msg.olderThanMs === "number" ? msg.olderThanMs : 20_000;
      const cutoff = Date.now() - threshold;
      const pruned = [];
      for (const [id, a] of agents) {
        if (id === agentId) continue; // don't self-prune
        if (a.lastSeen < cutoff) {
          clearInterval(a.pingTimer);
          a.conn.destroy();
          agents.delete(id);
          notifySSE("agents-changed");
          // Preserve mailbox so reconnected agent can reclaim messages
          pruned.push({ agentId: id, agentName: a.info.agentName });
          log(`Pruned silent agent: ${a.info.agentName} (${id.slice(0, 8)}) — silent for ${Math.round((Date.now() - a.lastSeen) / 1000)}s`);
        }
      }
      reply({ type: "pruned", pruned });
      break;
    }

    // ── Task board ──────────────────────────────────────────────────────────

    case "board_state": {
      reply({ type: "board", ...boardState(agentId, { location: msg.location, includeArchived: msg.includeArchived, group: msg.group }) });
      break;
    }

    case "board_move": {
      boardMove(agentId, msg.taskId, msg.column, msg.note)
        .then((r) => reply(r.error ? { type: "error", message: r.error } : { type: "ok", task: r.task, warning: r.warning }))
        .catch((e) => reply({ type: "error", message: e?.message ?? String(e) }));
      break;
    }

    case "board_assign": {
      boardAssign(agentId, msg.taskId, msg.assignee, !!msg.newSession)
        .then((r) => reply(r.error ? { type: "error", message: r.error } : { type: "ok", task: r.task, warning: r.warning }))
        .catch((e) => reply({ type: "error", message: e?.message ?? String(e) }));
      break;
    }

    case "board_comment": {
      boardComment(agentId, msg.taskId, msg.text)
        .then((r) => reply(r.error ? { type: "error", message: r.error } : { type: "ok", task: r.task, warning: r.warning }))
        .catch((e) => reply({ type: "error", message: e?.message ?? String(e) }));
      break;
    }

    case "board_progress": {
      boardProgress(agentId, msg.taskId, msg.text)
        .then((r) => reply(r.error ? { type: "error", message: r.error } : { type: "ok", task: r.task }))
        .catch((e) => reply({ type: "error", message: e?.message ?? String(e) }));
      break;
    }

    case "board_create": {
      boardCreate(agentId, {
        summary: msg.summary,
        description: msg.description,
        column: msg.column,
        parent: msg.parent,
        inJira: !!msg.inJira,
        level: msg.level,
        epicId: msg.epicId,
        backlog: !!msg.backlog,
        group: msg.group,
        priority: msg.priority,
        model: msg.model,
        allowWork: msg.allowWork,
      })
        .then((r) => reply(r.error ? { type: "error", message: r.error } : { type: "ok", task: r.task }))
        .catch((e) => reply({ type: "error", message: e?.message ?? String(e) }));
      break;
    }

    case "board_update": {
      boardUpdate(agentId, msg.taskId, { summary: msg.summary, description: msg.description, group: msg.group, priority: msg.priority, model: msg.model, allowWork: msg.allowWork })
        .then((r) => reply(r.error ? { type: "error", message: r.error } : { type: "ok", task: r.task, warning: r.warning }))
        .catch((e) => reply({ type: "error", message: e?.message ?? String(e) }));
      break;
    }

    case "board_flag": {
      const r = boardFlag(agentId, msg.taskId, msg.reason, !!msg.clear);
      reply(r.error ? { type: "error", message: r.error } : { type: "ok", task: r.task, warning: r.warning });
      break;
    }

    // ── Agent spawn (orchestrator tools) ────────────────────────────────────
    case "spawn": {
      // When an orchestrator (the CEO) requests an MM/CEO session via the
      // tool without supplying a kickoff, inject the canonical management
      // pass kickoff built from the favorited (managed) projects. Without this
      // the spawned manager wakes up with an empty inbox + empty context and
      // just sits idle until the reaper kills it — the CEO-driven path must
      // match what the daemon's own scheduler (spawnMiddleManager/spawnCeo)
      // does. An explicit kickoff always wins.
      let kickoff = msg.kickoff;
      const favorites = spawnRegistry.projects?.favorites ?? [];
      if (!kickoff && msg.mm) kickoff = mmKickoff(favorites);
      else if (!kickoff && msg.ceo) kickoff = ceoKickoff(favorites);
      const r = spawnAgent({ cwd: msg.cwd, name: msg.name, model: msg.model, kickoff, favorite: msg.favorite, mm: msg.mm, ceo: msg.ceo });
      reply(r.error ? { type: "error", message: r.error } : { type: "spawned", name: r.name });
      break;
    }
    case "spawn_stop": {
      const r = stopAgent({ name: msg.name });
      reply(r.error ? { type: "error", message: r.error } : { type: "ok" });
      break;
    }
    // A daemon-spawned agent tears down its OWN session + registry entry.
    // Used by the mail_stop_self tool: workers, middle-managers, CEOs, and any
    // other daemon-spawned agent call this when their work is done. Refuses
    // operator-launched agents (not in the spawn registry). See lib/spawn.mjs.
    case "stop_self": {
      const r = stopSelf({ agentId });
      reply(r.error ? { type: "error", message: r.error } : { type: "ok", name: r.name, graceMs: r.graceMs });
      break;
    }
    case "spawn_state": {
      reply({ type: "spawn", ...spawnState() });
      break;
    }
    // List recent + favorite project dirs (the spawn-agent "history/favorites").
    case "spawn_projects": {
      reply({ type: "spawn_projects", ...projectsState() });
      break;
    }
    // Star/unstar a project dir as a favorite. `favorite` is a boolean.
    case "spawn_favorite": {
      const nowFav = setFavorite(msg.cwd, !!msg.favorite);
      reply({ type: "ok", favorite: nowFav, ...projectsState() });
      break;
    }
    case "spawn_ls": {
      const r = listSpawnDir(msg.path || os.homedir(), { hidden: !!msg.hidden });
      reply(r.error ? { type: "error", message: r.error } : { type: "spawn_ls", dir: r.dir, dirs: r.dirs });
      break;
    }

    // Middle-manager diagnostics: inspect scheduler state, or force one tick
    // (optionally with a fake `now` for testing). The daemon's own loop drives
    // ticks on a schedule; these let an operator / tests observe and trigger.
    case "mm_state": {
      reply({ type: "mm", ...mmState() });
      break;
    }
    case "mm_tick": {
      const r = mmTick(typeof msg.now === "number" ? msg.now : Date.now(), !!msg.force);
      reply({ type: "ok", ...r });
      break;
    }

    // CEO diagnostics: inspect scheduler state, or force one tick (optionally
    // with a fake `now` for testing). The daemon's own loop drives ticks on a
    // schedule; these let an operator / tests observe and trigger.
    case "ceo_state": {
      reply({ type: "ceo", ...ceoState() });
      break;
    }
    case "ceo_tick": {
      const r = ceoTick(typeof msg.now === "number" ? msg.now : Date.now(), !!msg.force);
      reply({ type: "ok", ...r });
      break;
    }

    // ── MCP project chat ───────────────────────────────────────────────────
    // Multi-turn chat with a project's spawned agent over pi-mail. chat_post
    // spawns/reuses a chat worker and delivers the question; chat_get blocks
    // until the agent replies. See lib/chat.mjs + http.mjs /api/chat/*.
    case "chat_post": {
      chatPost({ cwd: msg.cwd, message: msg.message, threadId: msg.threadId, wait: msg.wait !== false, timeoutMs: msg.timeoutMs })
        .then((r) => reply(r.error ? { type: "error", message: r.error } : { type: "ok", ...r }))
        .catch((e) => reply({ type: "error", message: e?.message ?? String(e) }));
      break;
    }
    case "chat_get": {
      chatGet({ threadId: msg.threadId, timeoutMs: msg.timeoutMs })
        .then((r) => reply(r.error ? { type: "error", message: r.error } : { type: "ok", ...r }))
        .catch((e) => reply({ type: "error", message: e?.message ?? String(e) }));
      break;
    }
    case "chat_state": {
      reply({ type: "chat", ...chatState() });
      break;
    }

    case "mark_read": {
      const box = mailboxes.get(agentId);
      if (box) {
        const idx = box.findIndex((m) => m.id === msg.messageId);
        if (idx !== -1) box.splice(idx, 1);
      }
      reply({ type: "ok" });
      break;
    }

    case "restart_daemon": {
      // Restart the shared daemon. We reply first, then self-terminate after a
      // short delay so the reply flushes. The SIGTERM handler runs cleanup()
      // (flushes board/spawn/history, removes socket+pid+lock) — the same
      // graceful path as an operator-initiated shutdown. Disconnected clients
      // reconnect via their existing backoff; one of them respawns the daemon.
      const requester = agents.get(agentId)?.info.agentName ?? agentId.slice(0, 8);
      log(`Restart requested by ${requester}; shutting down for respawn`);
      reply({ type: "ok", message: "restarting" });
      setTimeout(() => {
        try { process.kill(process.pid, "SIGTERM"); }
        catch { /* already exiting */ }
      }, 100);
      break;
    }

    default:
      reply({ type: "error", message: `Unknown message type: ${msg.type}` });
  }
}
