# AGENTS.md

Guidance for AI coding agents working in this repository.

## After making changes

When your changes are complete:

1. **Rebuild / recompile** — if you changed TypeScript in `mcp/`, recompile it:
   ```bash
   npm run build:mcp
   ```
   Extension and skill code is loaded directly by pi (no build step).
2. **Commit** — one atomic commit per task on the current branch:
   ```bash
   git add -A && git commit -m "descriptive message"
   ```
3. **Push** — always pull before pushing; rebase, don't merge:
   ```bash
   git pull --rebase && git push
   ```
4. **Restart the daemon** — pi-mail is a pi extension; the daemon must be
   restarted for code changes to take effect. Use the `mail_restart_daemon`
   tool (or tell the operator to restart it). UI assets (HTML/CSS/JS) are
   re-read from disk on each request so a browser refresh is enough for
   frontend-only changes.