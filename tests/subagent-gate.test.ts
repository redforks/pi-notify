import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'

import {
  MAIN_AGENT_PID_ENV,
  MainAgentGate,
  inheritedSubagentMarker,
  isProcessAlive,
  openMainAgentGate,
} from '../src/subagent-gate.js'

const alive = () => true
const dead = () => false

function envWith(value: string | undefined): Record<string, string | undefined> {
  return value === undefined ? {} : { [MAIN_AGENT_PID_ENV]: value }
}

function exitedPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', () => resolve(child.pid as number))
  })
}

const probeThrowing = (code: string) => () => {
  throw Object.assign(new Error(`kill failed: ${code}`), { code })
}

describe('process ancestry marker', () => {
  it('an absent marker means the process claimed no Main agent', () => {
    expect(inheritedSubagentMarker(envWith(undefined), 1000, alive)).toBe(false)
  })

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['not a number', 'main'],
    ['zero', '0'],
    ['negative', '-7'],
    ['fractional', '12.5'],
    ['own pid', '1000'],
  ])('%s is not an inherited Subagent', (_label, value) => {
    expect(inheritedSubagentMarker(envWith(value), 1000, alive)).toBe(false)
  })

  it('a different live pid is an inherited Subagent', () => {
    expect(inheritedSubagentMarker(envWith('4242'), 1000, alive)).toBe(true)
  })

  it('a different dead pid is not: the intermediary that set it is gone', () => {
    expect(inheritedSubagentMarker(envWith('4242'), 1000, dead)).toBe(false)
  })

  it('accepts a marker value with surrounding whitespace', () => {
    expect(inheritedSubagentMarker(envWith(' 4242 '), 1000, alive)).toBe(true)
  })
})

describe('isProcessAlive', () => {
  it('is true for this process', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('is false for a process that has exited', async () => {
    const pid = await exitedPid()
    expect(isProcessAlive(pid)).toBe(false)
  })

  it('is false when the probe reports ESRCH', () => {
    expect(isProcessAlive(1234, probeThrowing('ESRCH'))).toBe(false)
  })

  it.each(['EPERM', 'EINVAL', 'ENOSYS'])(
    'stays inert (alive) when the probe fails with %s',
    (code) => {
      expect(isProcessAlive(1234, probeThrowing(code))).toBe(true)
    },
  )
})

describe('openMainAgentGate', () => {
  it('claims a fresh process, exporting its own pid', () => {
    const env = envWith(undefined)
    const gate = openMainAgentGate(env, 1000, alive)
    expect(gate).toBeInstanceOf(MainAgentGate)
    expect(env[MAIN_AGENT_PID_ENV]).toBe('1000')
  })

  it('stays inert in an inherited Subagent and leaves the marker untouched', () => {
    const env = envWith('4242')
    expect(openMainAgentGate(env, 1000, alive)).toBeUndefined()
    expect(env[MAIN_AGENT_PID_ENV]).toBe('4242')
  })

  it('reclaims a process whose marker points at a dead pid', () => {
    const env = envWith('4242')
    expect(openMainAgentGate(env, 1000, dead)).toBeInstanceOf(MainAgentGate)
    expect(env[MAIN_AGENT_PID_ENV]).toBe('1000')
  })

  it('recognises its own marker as this process already claiming Main', () => {
    const env = envWith('1000')
    const gate = openMainAgentGate(env, 1000, alive)
    expect(gate).toBeInstanceOf(MainAgentGate)
    // A caller that already claimed the process must treat a second
    // `session_start` with reason "startup" as a Subagent, not a Main agent.
    expect(gate?.observeSessionStart('startup', 'in-process-subagent')).toBe(false)
  })
})

describe('MainAgentGate session lifecycle', () => {
  it('claims the session the process is first bound to', () => {
    const gate = MainAgentGate.claimingProcess()
    expect(gate.observeSessionStart('startup', 'main')).toBe(true)
    expect(gate.isMainAgent('main')).toBe(true)
  })

  it('treats a later startup session as a Subagent', () => {
    const gate = MainAgentGate.claimingProcess()
    gate.observeSessionStart('startup', 'main')
    expect(gate.observeSessionStart('startup', 'subagent')).toBe(false)
    expect(gate.isMainAgent('subagent')).toBe(false)
    expect(gate.isMainAgent('main')).toBe(true)
  })

  it.each(['reload', 'new', 'resume', 'fork'] as const)(
    'a %s session is a Main agent too',
    (reason) => {
      const gate = MainAgentGate.claimingProcess()
      gate.observeSessionStart('startup', 'main')
      expect(gate.observeSessionStart(reason, `driven-${reason}`)).toBe(true)
      expect(gate.isMainAgent(`driven-${reason}`)).toBe(true)
    },
  )

  it('in a process that already claimed Main, startup is a Subagent and reload is not', () => {
    const gate = MainAgentGate.alreadyClaimed()
    expect(gate.observeSessionStart('startup', 'subagent')).toBe(false)
    expect(gate.observeSessionStart('reload', 'main')).toBe(true)
    expect(gate.isMainAgent('subagent')).toBe(false)
    expect(gate.isMainAgent('main')).toBe(true)
  })

  it('lazily claims the first session to emit an event when session_start never arrives', () => {
    const gate = MainAgentGate.claimingProcess()
    expect(gate.isMainAgent('main')).toBe(true)
  })

  it('never demotes a session already claimed as the Main agent', () => {
    const gate = MainAgentGate.claimingProcess()
    expect(gate.isMainAgent('main')).toBe(true)
    // A `session_start` arriving after the fact must not silence a Main agent
    // that has already notified.
    expect(gate.observeSessionStart('startup', 'main')).toBe(true)
    expect(gate.isMainAgent('main')).toBe(true)
  })

  it('treats an unclassified session as a Main agent (fail-loud)', () => {
    const gate = MainAgentGate.alreadyClaimed()
    gate.observeSessionStart('startup', 'subagent')
    expect(gate.isMainAgent('subagent')).toBe(false)
    expect(gate.isMainAgent('never-announced')).toBe(true)
  })
})
