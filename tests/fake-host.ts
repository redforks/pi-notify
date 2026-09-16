import { spawn } from 'node:child_process'

// Shared fake-host scaffolding: the extension's public seam is the default
// exported factory driven with a hand-rolled ExtensionAPI, so both integration
// suites build the same fake host and session contexts.

export type Handler = (event: unknown, ctx: unknown) => unknown

export interface FakeAPI {
  handlers: Map<string, Handler[]>
  on: (event: string, handler: Handler) => void
}

export function makeFakeAPI(): FakeAPI {
  const handlers = new Map<string, Handler[]>()
  return {
    handlers,
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
  }
}

export function emit(api: FakeAPI, eventName: string, event: unknown, ctx: unknown): unknown[] {
  return (api.handlers.get(eventName) ?? []).map((h) => h(event, ctx))
}

export const MAIN_SESSION = 'session-main'

export function sessionCtx(sessionId = MAIN_SESSION) {
  return { sessionManager: { getSessionId: () => sessionId } }
}

export function idleCtx(isIdle: boolean, sessionId = MAIN_SESSION) {
  return { isIdle: () => isIdle, ...sessionCtx(sessionId) }
}

/** A pid that has certainly exited, for the dead-marker cases. */
export function exitedPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', () => resolve(child.pid as number))
  })
}

/** Bounded wait for a fire-and-forget command to land. */
export async function waitUntil(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}
