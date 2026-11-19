/**
 * Active subagent probe (ADR 0002): hold Finished while pi-subagents work remains.
 *
 * Reads the documented manager registry (`Symbol.for("pi-subagents:manager")`)
 * whose `hasRunning()` is true for `running OR queued` — the CONTEXT.md
 * definition of Active subagent. Fail-loud: absent registry, missing probe,
 * or a throwing probe all mean "not active", so pi-notify notifies as today.
 */

const MANAGER_KEY = Symbol.for('pi-subagents:manager')

interface ManagerRegistry {
  hasRunning?: () => boolean
}

export function hasActiveSubagents(
  host: Record<symbol, unknown> = globalThis as Record<symbol, unknown>,
): boolean {
  try {
    const entry = host[MANAGER_KEY] as ManagerRegistry | undefined
    if (entry === undefined || typeof entry.hasRunning !== 'function') return false
    return entry.hasRunning() === true
  } catch {
    return false
  }
}
