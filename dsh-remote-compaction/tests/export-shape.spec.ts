import { readFile } from 'node:fs/promises'
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

  it('is publication-blocked until exact rc.5 artifacts can verify the protected hook', async () => {
    const packageJson = JSON.parse(await readFile(
      new URL('../package.json', import.meta.url),
      'utf8',
    )) as {
      private?: boolean
      publishConfig?: unknown
      scripts?: Record<string, string>
    }
    expect(packageJson.private).toBe(true)
    expect(packageJson.publishConfig).toBeUndefined()
    expect(packageJson.scripts?.prepare).toBe('tsc --build --force && tsdown')
    expect(packageJson.scripts?.prepack).toBe('tsc --build --force && tsdown')
    expect(packageJson.scripts?.['pack:check'])
      .toBe('npm run build && node scripts/pack-package.mjs && node scripts/pack-smoke.mjs')
  })
})
