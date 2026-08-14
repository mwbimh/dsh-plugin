import Loader from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it } from 'vitest'
import * as Quota from '../src/index.ts'

describe('dsh-quota Loader export shape', () => {
  it('exports only the named function-plugin namespace', () => {
    expect('default' in Quota).toBe(false)
    expect(Object.keys(Quota).sort()).toEqual(['Config', 'apply', 'inject', 'name'])

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(Quota) as Record<string, unknown>
    expect(unwrapped).toBe(Quota)
    expect(unwrapped.name).toBe('dsh-quota')
    expect(unwrapped.inject).toEqual([])
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')
  })
})
