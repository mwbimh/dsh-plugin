import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import * as QuotaInvariant from '../src/invariant.ts'

const packageName = '@dsh-plugins/dsh-quota'

describe('dsh-quota invariant companion', () => {
  it('registers package ownership and releases it on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const companion = await ctx.plugin(QuotaInvariant)

    expect(() => ctx.invariants.register(packageName, () => {})).toThrow(/already registered/)

    await companion.dispose()
    const replacement = ctx.invariants.register(packageName, () => {})
    replacement()
    await ctx.fiber.dispose()
  })

  it('keeps its function-plugin namespace intact', () => {
    expect('default' in QuotaInvariant).toBe(false)
    expect(QuotaInvariant.name).toBe('dsh-quota-invariant')
    expect(QuotaInvariant.inject).toEqual(['invariants'])
    expect(typeof QuotaInvariant.apply).toBe('function')
  })
})
