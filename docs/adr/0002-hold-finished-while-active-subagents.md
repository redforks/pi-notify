# Hold Finished while active subagents exist

Main-agent `agent_settled` goes idle while `pi-subagents` background work is still running, so `on_agent_finish` would ding early. We suppress that one fire while an Active subagent exists and rely on the Main agent's resume-settle to notify, via the documented manager registry (`Symbol.for("pi-subagents:manager")` → `hasRunning()`, true for `running OR queued` per `agent-manager.ts:1738`), with fail-loud fallback to notify when the registry is absent or unreachable.

## Considered Options

- **Delay/queue the fire until agents drain**: rejected — no queue to maintain, since subagent completion resumes the Main agent and produces a later settle that fires anyway.
- **Local `tool_call` snooping**: rejected — pi-notify stays observer-only; cross-extension state lives in the owning manager.
- **Count only `running`, ignore `queued`**: rejected — a queued agent will still resume the Main agent, so it counts as Active.

## Consequences

- Read-only use of the documented manager registry (`docs/rpc.md` "The manager registry"); no upstream change. The probe is synchronous (`some(running OR queued)`), so no timeout path exists — absent entry, missing probe, or throw means notify as today.
- `on_ask_user` is unaffected and still fires immediately; only `on_agent_finish` is held.
