import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import createExtension from '../src/index.js'
import { MAIN_AGENT_PID_ENV } from '../src/subagent-gate.js'
import { makeFakeAPI, emit, idleCtx, sessionCtx, waitUntil } from './fake-host.js'

const MANAGER_KEY = Symbol.for('pi-subagents:manager')

let homeDir: string
let savedHome: string | undefined
let savedMarker: string | undefined
let savedRegistry: unknown

function writeConfig(contents: object) {
  mkdirSync(join(homeDir, '.pi'), { recursive: true })
  writeFileSync(join(homeDir, '.pi', 'pi-notify.json'), JSON.stringify(contents))
}

function setRegistry(hasRunning: (() => boolean) | undefined) {
  if (hasRunning === undefined) {
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY]
  } else {
    ;(globalThis as Record<symbol, unknown>)[MANAGER_KEY] = { hasRunning }
  }
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'pi-notify-hold-'))
  savedHome = process.env.HOME
  savedMarker = process.env[MAIN_AGENT_PID_ENV]
  savedRegistry = (globalThis as Record<symbol, unknown>)[MANAGER_KEY]
  process.env.HOME = homeDir
  delete process.env[MAIN_AGENT_PID_ENV]
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  if (savedMarker === undefined) delete process.env[MAIN_AGENT_PID_ENV]
  else process.env[MAIN_AGENT_PID_ENV] = savedMarker
  if (savedRegistry === undefined) delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY]
  else (globalThis as Record<symbol, unknown>)[MANAGER_KEY] = savedRegistry
  vi.restoreAllMocks()
})

describe('hold Finished while Active subagents exist (ADR 0002)', () => {
  it('suppresses on_agent_finish on idle settle while Active', async () => {
    const marker = join(homeDir, 'held.txt')
    writeConfig({ on_agent_finish: [`printf fired > '${marker}'`] })
    setRegistry(() => true)
    const api = makeFakeAPI()
    createExtension(api as never)
    emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true))
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(marker)).toBe(false)
  })

  it('fires on_agent_finish on idle settle when registry reports idle', async () => {
    const marker = join(homeDir, 'fired.txt')
    writeConfig({ on_agent_finish: [`printf fired > '${marker}'`] })
    setRegistry(() => false)
    const api = makeFakeAPI()
    createExtension(api as never)
    emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true))
    await waitUntil(() => existsSync(marker))
  })

  it('fires when the registry is absent (fail-loud)', async () => {
    const marker = join(homeDir, 'absent.txt')
    writeConfig({ on_agent_finish: [`printf fired > '${marker}'`] })
    setRegistry(undefined)
    const api = makeFakeAPI()
    createExtension(api as never)
    emit(api, 'agent_settled', { type: 'agent_settled' }, idleCtx(true))
    await waitUntil(() => existsSync(marker))
  })

  it('on_ask_user still fires while Active', async () => {
    const marker = join(homeDir, 'ask.txt')
    writeConfig({ on_ask_user: [`printf asked > '${marker}'`] })
    setRegistry(() => true)
    const api = makeFakeAPI()
    createExtension(api as never)
    emit(
      api,
      'ui_prompt_start',
      { type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'select' },
      sessionCtx(),
    )
    await waitUntil(() => existsSync(marker))
    expect(readFileSync(marker, 'utf8')).toBe('asked')
  })
})
