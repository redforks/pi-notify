import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import { loadConfig } from './config.js'
import { runCommands } from './runner.js'
import { hasActiveSubagents } from './active-subagents.js'
import { isProcessAlive, openMainAgentGate } from './subagent-gate.js'
/**
 * Subagent gate (ticket #15).
 *
 * Only Main agent sessions notify. `openMainAgentGate` resolves this process's
 * role — it exports `PI_NOTIFY_MAIN_AGENT_PID` when this process is the Main
 * agent and returns nothing when it inherited a live marker from one, so an
 * out-of-process Subagent returns here before reading config or subscribing.
 * In-process Subagents share the marker's pid, so the gate also tracks
 * sessions: the session this process is first bound to is the Main agent, a
 * later `session_start` with reason `reload`/`new`/`resume`/`fork` is one too,
 * and a later `startup` is a Subagent. A session nothing identifies as a
 * Subagent notifies (fail-loud). See `docs/adr/0001-subagent-detection.md`.
 *
 * pi-notify: `on_agent_finish` (ticket #8), native `on_ask_user` (ticket #11),
 * extra-tool `on_ask_user` (ticket #12) and the Subagent gate (ticket #15).
 *
 * Config is read lazily, on the first session identified as the Main agent, so
 * a present-but-invalid `~/.pi/pi-notify.json` throws at session start rather
 * than at extension load, and a Subagent never reads the file. After one
 * failure the extension stays inert instead of re-throwing on every event.
 *
 * Subscribed events: `session_start`, `agent_settled`, `ui_prompt_start` and
 * `tool_call`. On each settle where `ctx.isIdle()` is true, every
 * `on_agent_finish` command runs in array order through `sh -c`,
 * fire-and-forget. On each observed `ui_prompt_start` — one per waiting span,
 * since the host coalesces nested/overlapping prompts into a single outer
 * span — and on each `tool_call` whose `event.toolName` is an exact,
 * case-sensitive, full-string member of `extra_ask_user_tool`, every
 * `on_ask_user` command runs the same way, at call-start before the tool
 * executes. Both hooks enqueue in observed order onto the runner's single
 * global FIFO (`runCommands`, runner.ts), so a coincident ask and settle both
 * fire with the first-observed hook's entries ahead, and neither hook
 * suppresses the other. `tool_execution_start` is deliberately not subscribed
 * (it fires before `tool_call`, so subscribing to both would double-fire), nor
 * are `tool_execution_end` and the package `rpiv:ask-user:prompt` event
 * (whose payload carries no `toolCallId`).
 *
 * Observer-only: handlers never return a block decision and never mutate event
 * input. `agent_end`, `session_shutdown` and `ui_prompt_end` are never
 * subscribed.
 */
interface Hooks {
  on_agent_finish: string[]
  on_ask_user: string[]
  askTools: Set<string>
}

/** Read the config on the first Main agent session, once; stay inert after a failure. */
function createHookLoader(): () => Hooks | undefined {
  let hooks: Hooks | undefined
  let failed = false
  return () => {
    if (hooks !== undefined) return hooks
    if (failed) return undefined
    try {
      const config = loadConfig()
      hooks = {
        on_agent_finish: config.on_agent_finish,
        on_ask_user: config.on_ask_user,
        askTools: new Set(config.extra_ask_user_tool),
      }
      return hooks
    } catch (err) {
      failed = true
      throw err
    }
  }
}

function sessionIdOf(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId()
}

export default function (pi: ExtensionAPI): void {
  const gate = openMainAgentGate(process.env, process.pid, isProcessAlive)
  if (gate === undefined) return

  const hooks = createHookLoader()
  const mainHooks = (ctx: ExtensionContext): Hooks | undefined =>
    gate.isMainAgent(sessionIdOf(ctx)) ? hooks() : undefined

  pi.on('session_start', (event, ctx) => {
    if (gate.observeSessionStart(event.reason, sessionIdOf(ctx))) hooks()
  })

  pi.on('agent_settled', (_event, ctx) => {
    const config = mainHooks(ctx)
    if (config === undefined || !ctx.isIdle()) return
    // Hold Finished while Active subagents exist (ADR 0002): suppress this
    // fire; the Main agent resumes on completion and settles again.
    if (hasActiveSubagents()) return
    runCommands(config.on_agent_finish)
  })

  pi.on('ui_prompt_start', (_event, ctx) => {
    const config = mainHooks(ctx)
    if (config === undefined) return
    runCommands(config.on_ask_user)
  })

  pi.on('tool_call', (event, ctx) => {
    const config = mainHooks(ctx)
    if (config === undefined || !config.askTools.has(event.toolName)) return
    runCommands(config.on_ask_user)
  })
}
