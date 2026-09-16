import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'

import createExtension from '../src/index.js'
import { MAIN_AGENT_PID_ENV, type SessionStartReason } from '../src/subagent-gate.js'
import { type FakeAPI, emit, exitedPid, idleCtx, makeFakeAPI, sessionCtx, waitUntil } from './fake-host.js'

const sessionStart = (reason: SessionStartReason) => ({ type: 'session_start', reason })
const askEvent = { type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'select' }
const toolCallEvent = {
  type: 'tool_call',
  toolCallId: 'call-gate',
  toolName: 'ask_user_question',
  input: {},
}

// Appends `byte` to `marker` only once the marker already holds `n` bytes, so
// the written content order is deterministic no matter how concurrent shells
// are scheduled.
function appendAfter(marker: string, byte: string, n: number): string {
  return `while [ "$(wc -c < '${marker}' 2>/dev/null || echo 0)" -lt ${n} ]; do sleep 0.01; done; printf '${byte}' >> '${marker}'`
}

// Temp home holding the config: the extension resolves the home from the
// process environment, so tests point HOME at a fresh temp dir.
let homeDir: string
let savedHome: string | undefined
let savedUserProfile: string | undefined
let savedMarker: string | undefined

function writeConfig(contents: string | object) {
  mkdirSync(join(homeDir, '.pi'), { recursive: true })
  writeFileSync(
    join(homeDir, '.pi', 'pi-notify.json'),
    typeof contents === 'string' ? contents : JSON.stringify(contents),
  )
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'pi-notify-home-'))
  savedHome = process.env.HOME
  savedUserProfile = process.env.USERPROFILE
  savedMarker = process.env[MAIN_AGENT_PID_ENV]
  process.env.HOME = homeDir
  delete process.env.USERPROFILE
  // Each test starts as an unclaimed process; the gate exports this marker at
  // load, so a stale value would make the next factory look like a reload.
  delete process.env[MAIN_AGENT_PID_ENV]
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  if (savedUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = savedUserProfile
  if (savedMarker === undefined) delete process.env[MAIN_AGENT_PID_ENV]
  else process.env[MAIN_AGENT_PID_ENV] = savedMarker
  vi.restoreAllMocks()
})

describe('walking skeleton: on_agent_finish', () => {
  it('runs each on_agent_finish command in array order on idle settle', async () => {
    const marker = join(homeDir, 'order.txt')
    writeConfig({ on_agent_finish: [appendAfter(marker, 'a', 0), appendAfter(marker, 'b', 1)] })
    const api = makeFakeAPI()
    createExtension(api as never)
    emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true))
    await waitUntil(() => existsSync(marker) && readFileSync(marker, 'utf8') === 'ab')
  })

  it('handler returns without awaiting the child (fire-and-forget)', async () => {
    const marker = join(homeDir, 'async.txt')
    writeConfig({ on_agent_finish: [`sleep 0.5; printf done > '${marker}'`] })
    const api = makeFakeAPI()
    createExtension(api as never)
    const handlers = api.handlers.get('agent_settled') ?? []
    expect(handlers).toHaveLength(1)
    const start = Date.now()
    emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true))
    expect(Date.now() - start).toBeLessThan(400)
    expect(existsSync(marker)).toBe(false)
    await waitUntil(() => existsSync(marker))
  })

  it('absent config file loads silently and fires nothing', () => {
    const api = makeFakeAPI()
    expect(() => createExtension(api as never)).not.toThrow()
    emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true))
    expect(api.handlers.get('agent_settled')).toHaveLength(1)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('empty arrays load and stay silent', () => {
    writeConfig({ on_agent_finish: [], on_ask_user: [], extra_ask_user_tool: [] })
    const api = makeFakeAPI()
    expect(() => createExtension(api as never)).not.toThrow()
    emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true))
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('commands inherit environment and cwd unchanged', async () => {
    const marker = join(homeDir, 'env.txt')
    process.env.PI_NOTIFY_TEST_SENTINEL = 'sentinel-42'
    try {
      writeConfig({ on_agent_finish: [`pwd > '${marker}'; printenv PI_NOTIFY_TEST_SENTINEL >> '${marker}'`] })
      const api = makeFakeAPI()
      createExtension(api as never)
      emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true))
      await waitUntil(() => existsSync(marker))
      const lines = readFileSync(marker, 'utf8').trim().split('\n')
      expect(lines[0]).toBe(process.cwd())
      expect(lines[1]).toBe('sentinel-42')
    } finally {
      delete process.env.PI_NOTIFY_TEST_SENTINEL
    }
  })

  it('command stdout/stderr are ignored: a chatty command still completes', async () => {
    const marker = join(homeDir, 'chatty.txt')
    writeConfig({
      on_agent_finish: [`echo chatty-stdout; echo chatty-stderr >&2; printf done > '${marker}'`],
    })
    const api = makeFakeAPI()
    createExtension(api as never)
    emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true))
    await waitUntil(() => existsSync(marker))
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('a settle with isIdle() false fires nothing', async () => {
    const marker = join(homeDir, 'idle-false.txt')
    writeConfig({ on_agent_finish: [`printf x > '${marker}'`] })
    const api = makeFakeAPI()
    createExtension(api as never)
    emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(false))
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(marker)).toBe(false)
  })

  it('never subscribes agent_end or session_shutdown', () => {
    writeConfig({ on_agent_finish: [`printf x >> '${join(homeDir, 'never.txt')}'`] })
    const api = makeFakeAPI()
    createExtension(api as never)
    expect(api.handlers.has('agent_end')).toBe(false)
    expect(api.handlers.has('session_shutdown')).toBe(false)
  })

  it('shell features work through sh -c', async () => {
    const marker = join(homeDir, 'shell.txt')
    writeConfig({ on_agent_finish: [`echo hello-$(echo world) > '${marker}'`] })
    const api = makeFakeAPI()
    createExtension(api as never)
    emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true))
    await waitUntil(() => existsSync(marker))
    expect(readFileSync(marker, 'utf8').trim()).toBe('hello-world')
  })
})

describe('config validation (fail-loud)', () => {
  it.each([
    ['syntax error', '{not json,', 'invalid JSON'],
    ['trailing comma', '{"on_agent_finish": [],}', 'invalid JSON'],
    ['non-object root (array)', '[1, 2]', 'must be an object'],
    ['non-object root (string)', '"just a string"', 'must be an object'],
    ['non-object root (number)', '42', 'must be an object'],
    ['non-object root (null)', 'null', 'must be an object'],
    ['non-array on_agent_finish', { on_agent_finish: 'notify_send' }, 'on_agent_finish'],
    ['non-array on_ask_user', { on_ask_user: 'notify_send' }, 'on_ask_user'],
    ['non-array extra_ask_user_tool', { extra_ask_user_tool: 'ask_user_question' }, 'extra_ask_user_tool'],
    ['null field value', { on_agent_finish: null }, 'on_agent_finish'],
    ['numeric entry', { on_agent_finish: [42] }, 'on_agent_finish'],
    ['object entry', { on_agent_finish: [{ command: 'x' }] }, 'on_agent_finish'],
    ['null entry', { on_ask_user: [null] }, 'on_ask_user'],
    ['non-string tool entry', { extra_ask_user_tool: [7] }, 'extra_ask_user_tool'],
    ['unknown key', { on_agent_finishh: [] }, 'on_agent_finishh'],
    ['unknown key alongside valid', { on_agent_finish: [], extra: [] }, 'extra'],
  ])('%s throws naming the file and reason', (_label, body, fragment) => {
    writeConfig(body as never)
    // The factory subscribes first; the loud failure belongs to the first Main
    // session, so each assertion drives a fresh, unclaimed extension.
    const trigger = () => {
      delete process.env[MAIN_AGENT_PID_ENV]
      const api = makeFakeAPI()
      expect(() => createExtension(api as never)).not.toThrow()
      emit(api, 'session_start', sessionStart('startup'), sessionCtx())
    }
    expect(trigger).toThrowError(
      expect.objectContaining({ message: expect.stringContaining('pi-notify.json') }),
    )
    expect(trigger).toThrowError(
      expect.objectContaining({ message: expect.stringContaining(fragment) }),
    )
  })

  it('missing fields default to empty arrays', async () => {
    writeConfig({})
    const api = makeFakeAPI()
    expect(() => createExtension(api as never)).not.toThrow()
    // An all-default config fires nothing on an idle settle.
    emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true))
    await new Promise((r) => setTimeout(r, 200))
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('a failed load leaves the extension inert instead of re-throwing', () => {
    writeConfig('{not json,')
    const api = makeFakeAPI()
    expect(() => createExtension(api as never)).not.toThrow()
    expect(() => emit(api, 'session_start', sessionStart('startup'), sessionCtx())).toThrow()
    expect(() => emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true))).not.toThrow()
    expect(() => emit(api, 'ui_prompt_start', askEvent, sessionCtx())).not.toThrow()
    expect(() => emit(api, 'tool_call', toolCallEvent, sessionCtx())).not.toThrow()
  })

  it('partial configs load: only the configured hook fires', async () => {
    const marker = join(homeDir, 'partial.txt')
    writeConfig({ on_agent_finish: [`printf fired > '${marker}'`] })
    const api = makeFakeAPI()
    expect(() => createExtension(api as never)).not.toThrow()
    emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true))
    await waitUntil(() => existsSync(marker))
  })

  it('config is read once, at the first Main session: later file changes are never reloaded', async () => {
    const markerA = join(homeDir, 'first.txt')
    const markerB = join(homeDir, 'second.txt')
    writeConfig({ on_agent_finish: [`printf a > '${markerA}'`] })
    const api = makeFakeAPI()
    createExtension(api as never)
    emit(api, 'session_start', sessionStart('startup'), sessionCtx())
    // Rewrite the config after the read; the extension must keep the old snapshot.
    writeConfig({ on_agent_finish: [`printf b > '${markerB}'`] })
    emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true))
    await waitUntil(() => existsSync(markerA))
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(markerB)).toBe(false)
  })

  it('config file is never written by the extension', async () => {
    const marker = join(homeDir, 'readonly.txt')
    writeConfig({ on_agent_finish: [`printf x > '${marker}'`] })
    const configPath = join(homeDir, '.pi', 'pi-notify.json')
    const before = readFileSync(configPath, 'utf8')
    const api = makeFakeAPI()
    createExtension(api as never)
    emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true))
    await waitUntil(() => existsSync(marker))
    expect(readFileSync(configPath, 'utf8')).toBe(before)
  })
})

describe('runner edge semantics (#10)', () => {
  it('duplicate commands run once per slot, in position order', async () => {
    const marker = join(homeDir, 'dup.txt')
    writeConfig({ on_agent_finish: [`printf 'x' >> '${marker}'`, `printf 'x' >> '${marker}'`] })
    const api = makeFakeAPI()
    createExtension(api as never)
    emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true))
    await waitUntil(() => existsSync(marker) && readFileSync(marker, 'utf8') === 'xx')
  })

  it('empty and whitespace-only entries are skipped with no spawn and no warning', async () => {
    const marker = join(homeDir, 'blank.txt')
    writeConfig({ on_agent_finish: ['', '   ', ' \t\n ', `printf ok > '${marker}'`] })
    const api = makeFakeAPI()
    createExtension(api as never)
    emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true))
    await waitUntil(() => existsSync(marker))
    await new Promise((r) => setTimeout(r, 200))
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('a spawn-level failure warns with the command and the error, without throwing', async () => {
    const emptyBin = mkdtempSync(join(tmpdir(), 'pi-notify-emptybin-'))
    const savedPath = process.env.PATH
    process.env.PATH = emptyBin
    try {
      writeConfig({ on_agent_finish: [`printf unreachable`] })
      const api = makeFakeAPI()
      createExtension(api as never)
      expect(() => emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true))).not.toThrow()
      await waitUntil(() => vi.mocked(console.warn).mock.calls.length > 0)
      const message = String(vi.mocked(console.warn).mock.calls[0]?.[0])
      expect(message).toContain('printf unreachable')
      expect(message).toMatch(/ENOENT|EACCES|\bsh\b/)
    } finally {
      process.env.PATH = savedPath
    }
  })

  it('{title}/{message}/{toolName} literals run unchanged and no env vars are added', async () => {
    const marker = join(homeDir, 'literal.txt')
    const envDump = join(homeDir, 'envdump.txt')
    process.env.PI_NOTIFY_RUNNER_PROBE = 'probe-10'
    try {
      writeConfig({
        on_agent_finish: [
          `printf '%s' '{title} {message} {toolName}' > '${marker}'`,
          `env > '${envDump}'`,
        ],
      })
      const api = makeFakeAPI()
      createExtension(api as never)
      emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true))
      await waitUntil(() => existsSync(marker) && existsSync(envDump))
      expect(readFileSync(marker, 'utf8')).toBe('{title} {message} {toolName}')
      const envText = readFileSync(envDump, 'utf8')
      expect(envText).toContain('PI_NOTIFY_RUNNER_PROBE=probe-10')
      expect(envText).not.toContain('PI_NOTIFY_COMMAND=')
      expect(envText).not.toContain('NOTIFY_TITLE=')
    } finally {
      delete process.env.PI_NOTIFY_RUNNER_PROBE
    }
  })

  it('a slow first command never delays later commands on the event path', async () => {
    const slow = join(homeDir, 'slow.txt')
    const quick = join(homeDir, 'quick.txt')
    writeConfig({
      on_agent_finish: [`sleep 2; printf done > '${slow}'`, `printf quick > '${quick}'`],
    })
    const api = makeFakeAPI()
    createExtension(api as never)
    const start = Date.now()
    emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true))
    await waitUntil(() => existsSync(quick))
    expect(Date.now() - start).toBeLessThan(1500)
    expect(readFileSync(quick, 'utf8')).toBe('quick')
  })

  it('non-zero exits and signals are ignored, later commands still run', async () => {
    const marker = join(homeDir, 'exitcode.txt')
    writeConfig({ on_agent_finish: [`exit 3`, `kill -TERM $$`, `printf survived > '${marker}'`] })
    const api = makeFakeAPI()
    createExtension(api as never)
    expect(() => emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true))).not.toThrow()
    await waitUntil(() => existsSync(marker))
    expect(readFileSync(marker, 'utf8')).toBe('survived')
    expect(console.warn).not.toHaveBeenCalled()
  })
})

describe('native ask-user hook', () => {
  const kinds = ['select', 'confirm', 'input', 'editor', 'custom'] as const

  it.each(kinds)('ui_prompt_start with kind %s runs on_ask_user commands in order', async (kind) => {
    const marker = join(homeDir, `ask-${kind}.txt`)
    writeConfig({ on_ask_user: [appendAfter(marker, 'a', 0), appendAfter(marker, 'b', 1)] })
    const api = makeFakeAPI()
    createExtension(api as never)
    emit(api, 'ui_prompt_start', { type: 'ui_prompt_start', reason: 'ui_prompt', kind }, sessionCtx())
    await waitUntil(() => existsSync(marker) && readFileSync(marker, 'utf8') === 'ab')
  })

  it('two separate waiting spans fire twice', async () => {
    const marker = join(homeDir, 'ask-twice.txt')
    writeConfig({ on_ask_user: [`printf 'x' >> '${marker}'`] })
    const api = makeFakeAPI()
    createExtension(api as never)
    emit(api, 'ui_prompt_start', { type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'select' }, sessionCtx())
    await waitUntil(() => existsSync(marker))
    emit(api, 'ui_prompt_start', { type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'input' }, sessionCtx())
    await waitUntil(() => readFileSync(marker, 'utf8') === 'xx')
  })

  it('a coalesced span fires once: one observed start = one fire, end adds nothing', async () => {
    const marker = join(homeDir, 'ask-once.txt')
    writeConfig({ on_ask_user: [`printf 'x' >> '${marker}'`] })
    const api = makeFakeAPI()
    createExtension(api as never)
    // The host coalesces nested/overlapping prompts into a single outer
    // ui_prompt_start; the extension fires once per observed start.
    emit(api, 'ui_prompt_start', { type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'select' }, sessionCtx())
    await waitUntil(() => existsSync(marker))
    emit(api, 'ui_prompt_end', { type: 'ui_prompt_end', reason: 'ui_prompt', kind: 'select' }, sessionCtx())
    await new Promise((r) => setTimeout(r, 300))
    expect(readFileSync(marker, 'utf8')).toBe('x')
  })

  it('ui_prompt_end is never subscribed and fires nothing', () => {
    writeConfig({ on_ask_user: [`printf x >> '${join(homeDir, 'never-end.txt')}'`] })
    const api = makeFakeAPI()
    createExtension(api as never)
    expect(api.handlers.has('ui_prompt_end')).toBe(false)
  })

  it('nothing fires when on_ask_user is empty', async () => {
    const marker = join(homeDir, 'ask-empty.txt')
    writeConfig({ on_ask_user: [], on_agent_finish: [`printf x > '${marker}'`] })
    const api = makeFakeAPI()
    createExtension(api as never)
    emit(api, 'ui_prompt_start', { type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'confirm' }, sessionCtx())
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(marker)).toBe(false)
    expect(console.warn).not.toHaveBeenCalled()
  })
})

describe('extra ask-tool hook (#12)', () => {
  const toolCall = (toolName: string) => ({
    type: 'tool_call',
    toolCallId: 'call-1',
    toolName,
    input: {},
  })

  function setup(extraAskUserTool: string[], onAskUser: string[]) {
    writeConfig({ on_ask_user: onAskUser, extra_ask_user_tool: extraAskUserTool })
    const api = makeFakeAPI()
    createExtension(api as never)
    return api
  }

  it('an exact tool_call match runs on_ask_user once and never blocks', async () => {
    const marker = join(homeDir, 'ask.txt')
    const api = setup(['ask_user_question'], [`printf fired > '${marker}'`])
    const results = emit(api, 'tool_call', toolCall('ask_user_question'), sessionCtx())
    expect(results).toEqual([undefined])
    await waitUntil(() => existsSync(marker))
    expect(readFileSync(marker, 'utf8')).toBe('fired')
  })

  it.each([
    ['different case', 'Ask_User_Question'],
    ['dashes', 'ask-user-question'],
    ['trailing space', 'ask_user_question '],
    ['prefix', 'ask_user_questio'],
    ['extended', 'ask_user_question_extra'],
  ])('near-miss %s fires nothing', async (_label, toolName) => {
    const marker = join(homeDir, 'near-miss.txt')
    const api = setup(['ask_user_question'], [`printf x > '${marker}'`])
    emit(api, 'tool_call', toolCall(toolName), sessionCtx())
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(marker)).toBe(false)
  })

  it('tool_execution_start and tool_execution_end are never subscribed', () => {
    const api = setup(['ask_user_question'], [`printf x > '${join(homeDir, 'exec.txt')}'`])
    expect(api.handlers.has('tool_execution_start')).toBe(false)
    expect(api.handlers.has('tool_execution_end')).toBe(false)
  })

  it('a duplicate tool-name entry still fires exactly once per call', async () => {
    const marker = join(homeDir, 'dup.txt')
    const api = setup(['ask_user_question', 'ask_user_question'], [`printf x >> '${marker}'`])
    emit(api, 'tool_call', toolCall('ask_user_question'), sessionCtx())
    await waitUntil(() => existsSync(marker))
    await new Promise((r) => setTimeout(r, 300))
    expect(readFileSync(marker, 'utf8')).toBe('x')
  })

  it('two separate matching calls fire twice', async () => {
    const marker = join(homeDir, 'twice.txt')
    const api = setup(['ask_user_question'], [`printf x >> '${marker}'`])
    emit(api, 'tool_call', toolCall('ask_user_question'), sessionCtx())
    emit(api, 'tool_call', { ...toolCall('ask_user_question'), toolCallId: 'call-2' }, sessionCtx())
    await waitUntil(() => existsSync(marker) && readFileSync(marker, 'utf8') === 'xx')
  })

  it('nothing fires when extra_ask_user_tool is empty', async () => {
    const marker = join(homeDir, 'empty-tools.txt')
    const api = setup([], [`printf x > '${marker}'`])
    emit(api, 'tool_call', toolCall('ask_user_question'), sessionCtx())
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(marker)).toBe(false)
  })
})

describe('overlap ordering (#13)', () => {
  // Deterministic completion-order checks with real shells: appendAfter makes
  // each entry wait for the bytes before it, so the marker sequence is stable
  // no matter how the shells are scheduled. Spawn order itself — the runner
  // FIFO — is pinned by the mocked-spawn tests in runner.test.ts and
  // extension-order.test.ts.
  const nativeAsk = { type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'select' }
  const settle = { type: 'agent_settled' }
  const toolAsk = {
    type: 'tool_call',
    toolCallId: 'call-overlap',
    toolName: 'ask_user_question',
    input: {},
  }

  function setup(onAskUser: string[], onAgentFinish: string[], extraAskUserTool: string[] = []) {
    writeConfig({ on_ask_user: onAskUser, on_agent_finish: onAgentFinish, extra_ask_user_tool: extraAskUserTool })
    const api = makeFakeAPI()
    createExtension(api as never)
    return api
  }


  it('an ask observed before a settle runs both lists, the ask entries completing first', async () => {
    const marker = join(homeDir, 'overlap-ask-first.txt')
    const api = setup(
      [appendAfter(marker, '1', 0), appendAfter(marker, '2', 1)],
      [appendAfter(marker, '3', 2), appendAfter(marker, '4', 3)],
    )
    emit(api, 'ui_prompt_start', nativeAsk, sessionCtx())
    emit(api, 'agent_settled', settle, idleCtx(true))
    await waitUntil(() => existsSync(marker) && readFileSync(marker, 'utf8') === '1234')
  })

  it('a third-party ask observed before a settle also completes its entries first', async () => {
    const marker = join(homeDir, 'overlap-tool-ask-first.txt')
    const api = setup(
      [appendAfter(marker, 'a', 0)],
      [appendAfter(marker, 'f', 1)],
      ['ask_user_question'],
    )
    emit(api, 'tool_call', toolAsk, sessionCtx())
    emit(api, 'agent_settled', settle, idleCtx(true))
    await waitUntil(() => existsSync(marker) && readFileSync(marker, 'utf8') === 'af')
  })

  it('neither hook suppresses the other: an ask and its settle both run', async () => {
    const askMarker = join(homeDir, 'overlap-ask.txt')
    const finishMarker = join(homeDir, 'overlap-finish.txt')
    const api = setup(
      [`printf asked > '${askMarker}'`],
      [`printf finished > '${finishMarker}'`],
    )
    emit(api, 'ui_prompt_start', nativeAsk, sessionCtx())
    emit(api, 'agent_settled', settle, idleCtx(true))
    await waitUntil(() => existsSync(askMarker) && existsSync(finishMarker))
    expect(readFileSync(askMarker, 'utf8')).toBe('asked')
    expect(readFileSync(finishMarker, 'utf8')).toBe('finished')
  })

  it('a settle observed before a later ask keeps the observed completion order', async () => {
    const marker = join(homeDir, 'overlap-finish-first.txt')
    const api = setup(
      [appendAfter(marker, '3', 2), appendAfter(marker, '4', 3)],
      [appendAfter(marker, '1', 0), appendAfter(marker, '2', 1)],
    )
    emit(api, 'agent_settled', settle, idleCtx(true))
    emit(api, 'ui_prompt_start', nativeAsk, sessionCtx())
    await waitUntil(() => existsSync(marker) && readFileSync(marker, 'utf8') === '1234')
  })


  it('an ask followed by a non-idle settle runs only the ask list', async () => {
    const askMarker = join(homeDir, 'overlap-non-idle-ask.txt')
    const finishMarker = join(homeDir, 'overlap-non-idle-finish.txt')
    const api = setup(
      [`printf asked > '${askMarker}'`],
      [`printf finished > '${finishMarker}'`],
    )
    emit(api, 'ui_prompt_start', nativeAsk, sessionCtx())
    emit(api, 'agent_settled', settle, idleCtx(false))
    await waitUntil(() => existsSync(askMarker))
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(finishMarker)).toBe(false)
  })
})

describe('subagent gate (#15)', () => {
  let foreign: ChildProcess | undefined
  let foreignPid = 0

  beforeAll(async () => {
    foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const child = foreign
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', reject)
    })
    foreignPid = child.pid as number
  })

  afterAll(() => {
    foreign?.kill('SIGKILL')
  })

  it('an inherited live marker subscribes nothing, fires nothing and never reads config', async () => {
    process.env[MAIN_AGENT_PID_ENV] = String(foreignPid)
    const marker = join(homeDir, 'subagent-silent.txt')
    writeConfig({
      on_agent_finish: [`printf x > '${marker}'`],
      on_ask_user: [`printf y >> '${marker}'`],
      extra_ask_user_tool: ['ask_user_question'],
    })
    const api = makeFakeAPI()
    expect(() => createExtension(api as never)).not.toThrow()
    expect(api.handlers.size).toBe(0)
    emit(api, 'session_start', sessionStart('startup'), sessionCtx())
    emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true))
    emit(api, 'ui_prompt_start', askEvent, sessionCtx())
    emit(api, 'tool_call', toolCallEvent, sessionCtx())
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(marker)).toBe(false)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('an inherited live marker keeps a present-but-invalid config silent', () => {
    process.env[MAIN_AGENT_PID_ENV] = String(foreignPid)
    writeConfig('{not json,')
    const api = makeFakeAPI()
    expect(() => createExtension(api as never)).not.toThrow()
    expect(api.handlers.size).toBe(0)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('a dead marker is reclaimed: the process claims Main and notifies again', async () => {
    process.env[MAIN_AGENT_PID_ENV] = String(await exitedPid())
    const marker = join(homeDir, 'reclaimed.txt')
    writeConfig({ on_agent_finish: [`printf x > '${marker}'`] })
    const api = makeFakeAPI()
    createExtension(api as never)
    expect(process.env[MAIN_AGENT_PID_ENV]).toBe(String(process.pid))
    emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true))
    await waitUntil(() => existsSync(marker))
  })

  it("this process's own marker (the /reload case) keeps notifying", async () => {
    process.env[MAIN_AGENT_PID_ENV] = String(process.pid)
    const marker = join(homeDir, 'reload.txt')
    writeConfig({ on_agent_finish: [`printf x > '${marker}'`] })
    const api = makeFakeAPI()
    createExtension(api as never)
    emit(api, 'session_start', sessionStart('reload'), sessionCtx())
    emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true))
    await waitUntil(() => existsSync(marker))
  })

  it('an in-process Subagent session is inert while the Main agent notifies', async () => {
    const finishMarker = join(homeDir, 'main-finish.txt')
    const askMarker = join(homeDir, 'main-ask.txt')
    writeConfig({
      on_agent_finish: [`printf x > '${finishMarker}'`],
      on_ask_user: [`printf y > '${askMarker}'`],
      extra_ask_user_tool: ['ask_user_question'],
    })
    const api = makeFakeAPI()
    createExtension(api as never)
    emit(api, 'session_start', sessionStart('startup'), sessionCtx('main'))
    emit(api, 'session_start', sessionStart('startup'), sessionCtx('subagent'))

    emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true, 'subagent'))
    emit(api, 'ui_prompt_start', askEvent, sessionCtx('subagent'))
    emit(api, 'tool_call', toolCallEvent, sessionCtx('subagent'))
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(finishMarker)).toBe(false)
    expect(existsSync(askMarker)).toBe(false)

    emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true, 'main'))
    emit(api, 'ui_prompt_start', askEvent, sessionCtx('main'))
    await waitUntil(() => existsSync(finishMarker) && existsSync(askMarker))
  })

  it.each(['reload', 'new', 'resume', 'fork'] as const)(
    'a %s session is a Main agent and notifies',
    async (reason) => {
      const marker = join(homeDir, `driven-${reason}.txt`)
      writeConfig({ on_agent_finish: [`printf x > '${marker}'`] })
      const api = makeFakeAPI()
      createExtension(api as never)
      emit(api, 'session_start', sessionStart('startup'), sessionCtx('main'))
      emit(api, 'session_start', sessionStart(reason), sessionCtx(`driven-${reason}`))
      emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true, `driven-${reason}`))
      await waitUntil(() => existsSync(marker))
    },
  )

  it('the first session to emit an event is Main when session_start never arrives', async () => {
    const marker = join(homeDir, 'lazy.txt')
    writeConfig({ on_agent_finish: [`printf x > '${marker}'`] })
    const api = makeFakeAPI()
    createExtension(api as never)
    emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true, 'never-announced'))
    await waitUntil(() => existsSync(marker))
  })

  it('a Subagent session never reads the config: a malformed file stays silent', () => {
    // The process already claimed a Main agent (as after `/reload`), so an
    // in-process Subagent's `startup` session_start must not touch the config.
    process.env[MAIN_AGENT_PID_ENV] = String(process.pid)
    writeConfig('{not json,')
    const api = makeFakeAPI()
    createExtension(api as never)
    expect(() =>
      emit(api, 'session_start', sessionStart('startup'), sessionCtx('subagent')),
    ).not.toThrow()
    expect(() =>
      emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true, 'subagent')),
    ).not.toThrow()
  })
})
