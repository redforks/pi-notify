/**
 * The Subagent gate (ticket #15, ADR 0001): which sessions may notify?
 *
 * Two layers decide:
 *
 * - **Process ancestry.** The Main agent's process exports
 *   `PI_NOTIFY_MAIN_AGENT_PID` holding its own pid, so a pi process spawned
 *   from that session inherits a marker naming a foreign, live pid and stays
 *   inert. A marker naming *this* process means the process already claimed a
 *   Main agent — the CLI re-invokes extension factories for `/new`, `/resume`,
 *   `/fork` and `/reload` in the same process. A marker naming a *dead* pid
 *   means the intermediary that set it (a tmux server, a daemon) is gone, so
 *   this process reclaims the Main agent and overwrites the marker. (This is
 *   process ancestry, not the glossary's Lineage, which is session ancestry.)
 * - **Session lifecycle.** In-process Subagents share the marker's pid, so the
 *   session a claiming process is first bound to is the Main agent, and a
 *   later `session_start` with reason `reload`/`new`/`resume`/`fork` is a Main
 *   agent too (a session the user drives). Any other later session is a
 *   Subagent.
 *
 * Detection is best-effort and fail-loud: a session nothing identifies as a
 * Subagent notifies. See docs/adr/0001-subagent-detection.md.
 */

export const MAIN_AGENT_PID_ENV = 'PI_NOTIFY_MAIN_AGENT_PID'

export type SessionStartReason = 'startup' | 'reload' | 'new' | 'resume' | 'fork'

type Env = Record<string, string | undefined>

/**
 * A marker naming a foreign, live process means this process descends from a
 * Main agent's session: an out-of-process Subagent.
 */
export function inheritedSubagentMarker(
  env: Env,
  pid: number,
  isAlive: (pid: number) => boolean,
): boolean {
  const raw = env[MAIN_AGENT_PID_ENV]
  if (raw === undefined) return false
  const markerPid = Number(raw)
  if (!Number.isInteger(markerPid) || markerPid <= 0) return false
  if (markerPid === pid) return false
  return isAlive(markerPid)
}

/**
 * `process.kill(pid, 0)` probes for existence: `ESRCH` means gone, but every
 * other error — `EPERM`, or an unimplemented probe on Windows and Bun — means
 * the process may well exist, so the gate prefers to stay inert.
 */
export function isProcessAlive(
  pid: number,
  kill: (pid: number, signal: number) => void = (target, signal) => process.kill(target, signal),
): boolean {
  try {
    kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Resolve this process's role and, when it is the Main agent, export the
 * marker its descendants will inherit. Returns the gate to drive from events,
 * or `undefined` in an out-of-process Subagent, which must stay fully inert.
 */
export function openMainAgentGate(
  env: Env,
  pid: number,
  isAlive: (pid: number) => boolean,
): MainAgentGate | undefined {
  if (inheritedSubagentMarker(env, pid, isAlive)) return undefined
  const claimedAlready = env[MAIN_AGENT_PID_ENV] === String(pid)
  env[MAIN_AGENT_PID_ENV] = String(pid)
  return claimedAlready ? MainAgentGate.alreadyClaimed() : MainAgentGate.claimingProcess()
}

export class MainAgentGate {
  private readonly mainAgents = new Set<string>()
  private readonly subagents = new Set<string>()
  private firstSessionStartPending: boolean

  private constructor(claimsProcess: boolean) {
    this.firstSessionStartPending = claimsProcess
  }

  /** This process has not yet been bound to a session. */
  static claimingProcess(): MainAgentGate {
    return new MainAgentGate(true)
  }

  /** This process already claimed a Main agent: another load, or a reload. */
  static alreadyClaimed(): MainAgentGate {
    return new MainAgentGate(false)
  }

  /** Feeds every `session_start`; returns whether that session is a Main agent. */
  observeSessionStart(reason: SessionStartReason, sessionId: string): boolean {
    const first = this.firstSessionStartPending
    this.firstSessionStartPending = false
    // A session already claimed as the Main agent is never demoted by a later
    // `startup`, and the process's first session_start is the Main agent
    // whatever its reason.
    const isMain = first || reason !== 'startup' || this.mainAgents.has(sessionId)
    if (isMain) {
      this.subagents.delete(sessionId)
      this.mainAgents.add(sessionId)
    } else {
      this.mainAgents.delete(sessionId)
      this.subagents.add(sessionId)
    }
    return isMain
  }

  /**
   * True when the session behind an event is a Main agent. A session nothing
   * has classified notifies: the gate fails loud, never silent.
   */
  isMainAgent(sessionId: string): boolean {
    if (this.mainAgents.has(sessionId)) return true
    if (this.subagents.has(sessionId)) return false
    // `session_start` was never observed for this session: treat it as the one
    // the user launched.
    this.mainAgents.add(sessionId)
    return true
  }
}
