import { describe, expect, it } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as OAuth from '../src/index.ts'

describe('dsh-oauth Loader export shape', () => {
  it('keeps the function-plugin namespace intact through Loader unwrapExports', () => {
    expect('default' in OAuth).toBe(false)
    expect(Object.keys(OAuth).sort()).toEqual(['Config', 'apply', 'inject', 'name'])

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(OAuth) as Record<string, unknown>
    expect(unwrapped).toBe(OAuth)
    expect(unwrapped.name).toBe('dsh-oauth')
    expect(unwrapped.inject).toEqual(['llm', 'credentials', 'commands', 'dsh-oauth-runtime'])
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')
  })
})
