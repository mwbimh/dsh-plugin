import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as OAuthInvariant from '../src/invariant.ts'

const packageName = '@dsh-plugins/dsh-oauth'

describe('dsh-oauth invariant companion', () => {
  it('registers package ownership and releases it on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const companion = await ctx.plugin(OAuthInvariant)

    expect(() => ctx.invariants.register(packageName, () => {})).toThrow(/already registered/)

    await companion.dispose()
    const replacement = ctx.invariants.register(packageName, () => {})
    replacement()
    await ctx.fiber.dispose()
  })

  it('keeps its function-plugin namespace intact through Loader metadata', () => {
    expect('default' in OAuthInvariant).toBe(false)
    expect(OAuthInvariant.name).toBe('dsh-oauth-invariant')
    expect(OAuthInvariant.inject).toEqual(['invariants'])
    expect(typeof OAuthInvariant.apply).toBe('function')
  })
})
