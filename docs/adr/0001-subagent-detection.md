# Subagent detection: an inherited Main-agent pid marker plus session lifecycle

pi-notify must stay inert in Subagent sessions while still notifying in the Main agent, but no host API answers "is this session a Subagent?". The only host signal, `ctx.sessionManager.getHeader()?.parentSession`, is also set for user-driven `/fork` and `/clone` (which are Main agents) and is absent for `--no-session` and in-memory child sessions. We therefore detect Subagents in two layers: process ancestry and session lifecycle. At load pi-notify exports `PI_NOTIFY_MAIN_AGENT_PID` holding its own pid, so any session whose environment carries a *different, live* pid is a Subagent in a child process; and within one process the session a claiming process is first bound to is the Main agent, a later `session_start` with reason `reload`/`new`/`resume`/`fork` is also the Main agent, and any other later session is a Subagent. Detection is best-effort and fail-loud: a session the gate cannot classify notifies.

## Considered options

- **Host session lineage only** (`parentSession`). Rejected: it conflates forks with agent-created spawns, and it is absent exactly where the installed `@tintinweb/pi-subagents` Subagents live — it uses `SessionManager.inMemory` unless the child is persisted.
- **Presence-only marker** (`PI_NOTIFY_MAIN_AGENT=1`). Rejected: pi re-invokes extension factories in the same process for `/new`, `/resume`, `/fork` and `/reload`, so a present-marker gate would make the Main session permanently inert after the first such switch.
- **Parent-pid chain walk**. Rejected: read-only, but structurally blind to in-process Subagents (which is how the installed extension runs them), needs `ps` on macOS, and pays a process-tree probe on every load.
- **Marker without a liveness check**. Rejected as the primary shape: a long-lived intermediary that inherited the marker — a tmux server started from pi, a daemon — would silence every pi it later hosts until it dies.

## Consequences

- pi-notify writes to the host process environment. Its README's "never invents … environment variables" promise is about notifier commands, not about the host.
- Liveness is `process.kill(pid, 0)` on every platform: `ESRCH` ⇒ Main agent, any other error (including an unsupported probe) ⇒ Subagent. Windows and Bun signal emulation is a documented caveat.
- Accepted false positive: a pid recycled by an unrelated process keeps a stale marker looking alive, so a nested session stays silent with no way to notice.
- Accepted false negative: a Subagent that outlives its Main agent starts notifying.
- Config is read lazily on the first session identified as the Main agent, so a malformed config throws at session start rather than at extension load, and Subagents never read it.
- A session you drive — launched, forked, cloned, resumed or reloaded — is a Main agent and notifies. A session an agent creates is a Subagent, whether it is hosted in-process or in a child process.
- There is no escape hatch. `env -u PI_NOTIFY_MAIN_AGENT_PID pi …` is the documented way to un-silence a nested process, and the marker is documented as unstable.
