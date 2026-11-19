import { describe, expect, it } from 'vitest'

import { hasActiveSubagents } from '../src/active-subagents.js'

const MANAGER_KEY = Symbol.for('pi-subagents:manager')

function withRegistry(entry: unknown, fn: () => void): void {
  const saved = (globalThis as Record<symbol, unknown>)[MANAGER_KEY]
  try {
    if (entry === undefined) {
      // biome-ignore lint: test seam deletes the global registry entry
      delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY]
    } else {
      ;(globalThis as Record<symbol, unknown>)[MANAGER_KEY] = entry
    }
    fn()
  } finally {
    if (saved === undefined) {
      delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY]
    } else {
      ;(globalThis as Record<symbol, unknown>)[MANAGER_KEY] = saved
    }
  }
}

describe('hasActiveSubagents (Active subagent seam)', () => {
  it('is false when the pi-subagents registry is absent (fail-loud: notify)', () => {
    withRegistry(undefined, () => {
      expect(hasActiveSubagents()).toBe(false)
    })
  })

  it('is true when the registry reports running or queued', () => {
    withRegistry({ hasRunning: () => true }, () => {
      expect(hasActiveSubagents()).toBe(true)
    })
  })

  it('is false when the registry reports idle', () => {
    withRegistry({ hasRunning: () => false }, () => {
      expect(hasActiveSubagents()).toBe(false)
    })
  })

  it('is false when hasRunning throws (fail-loud: notify)', () => {
    withRegistry(
      {
        hasRunning: () => {
          throw new Error('probe failed')
        },
      },
      () => {
        expect(hasActiveSubagents()).toBe(false)
      },
    )
  })

  it('is false when the registry entry has no hasRunning function', () => {
    withRegistry({}, () => {
      expect(hasActiveSubagents()).toBe(false)
    })
  })
})
