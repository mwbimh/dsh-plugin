import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as InvariantPlugin from '../src/invariant.ts'

describe('DSH bundle package contract', () => {
  it('exports a disposable invariant companion without a default export', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(InvariantPlugin)
    expect('default' in InvariantPlugin).toBe(false)
    expect(() => ctx.invariants.register('dsh-usage-analytics', () => {}))
      .toThrow(/already registered/)
    await fiber.dispose()
    const replacement = ctx.invariants.register('dsh-usage-analytics', () => {})
    await Promise.resolve(replacement)
    await Promise.resolve(replacement())
    await ctx.fiber.dispose()
  })

  it('declares only DSH bundle metadata and namespaced host rows', async () => {
    const packageJson = JSON.parse(await readFile(
      new URL('../package.json', import.meta.url),
      'utf8',
    )) as {
      dsh?: { bundle?: { patch?: string } }
      exports?: Record<string, unknown>
      files?: string[]
    }
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

    expect(packageJson.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(packageJson.exports).toHaveProperty('./invariant')
    expect(packageJson.files).toContain('cordis.patch.yml')
    expect(patch).toContain('id: dsh-usage-analytics')
    expect(patch).toContain('name: dsh-usage-analytics')
    expect(patch).toContain("name: 'dsh-usage-analytics/invariant'")
    expect(JSON.stringify(packageJson)).not.toContain('.codex-plugin')
    expect(JSON.stringify(packageJson)).not.toContain('marketplace')
  })
})
