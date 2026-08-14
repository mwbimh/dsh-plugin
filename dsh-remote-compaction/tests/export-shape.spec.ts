import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import * as invariant from '../src/invariant.ts'

describe('published plugin shapes', () => {
  it('exports one default service class', () => {
    expect(plugin.default).toBe(plugin.RemoteCompactionEngine)
    expect(plugin.RemoteCompactionEngine.prototype).toBeInstanceOf(Object)
    expect(Object.getOwnPropertyNames(plugin.RemoteCompactionEngine.prototype).sort())
      .toEqual(['constructor', 'summarize'])
  })

  it('keeps the invariant companion a named function plugin', () => {
    expect('default' in invariant).toBe(false)
    expect(invariant.name).toBe('dsh-remote-compaction-invariant')
    expect(invariant.inject).toEqual(['invariants'])
    expect(typeof invariant.apply).toBe('function')
  })
})
