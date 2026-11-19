# pi-notify

Pi extension that runs configured shell commands when the agent finishes or asks for input.

## Language

**Main agent**:
A pi session you launch or branch — including a `/fork` or `/clone`. The only session where notifications fire.
_Avoid_: parent session, root session, interactive session, first session

**Subagent**:
A pi session an agent creates to work on its behalf, whether it is hosted in the same process as its creator or in a child process.
_Avoid_: child, child host, worker, descendant session

**Lineage**:
A session's chain of ancestry back to the session it was created from. A `/fork` and a Subagent both have non-empty Lineage, so Lineage alone never decides Main agent vs Subagent — who initiated the session does.

**Subagent gate**:
The classification every session pi-notify observes receives: Main agent, or Subagent. Detection is best-effort, so a session the gate cannot classify is a Main agent.

**Active subagent**:
A Subagent created by `npm:@tintinweb/pi-subagents` whose work has not settled — running or queued. A queued Subagent counts because it will still resume the Main agent.
_Avoid_: background agent, running agent, pending agent

**Hold (Finished)**:
Suppressing one `on_agent_finish` fire while an Active subagent exists. No queue: the Main agent resumes when the Subagent completes and fires Finished on its later settle.
_Avoid_: delay, defer, debounce, queue Finished
