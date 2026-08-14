import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function runPackageManager(args: string[], cwd: string): string {
  const packageManager = process.env.npm_execpath
  if (packageManager === undefined) throw new Error('pack smoke must run through pnpm')
  const result = spawnSync(process.execPath, [packageManager, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  })
  if (result.status !== 0) {
    throw new Error([
      `pnpm ${args.join(' ')} failed with status ${String(result.status)}`,
      result.stdout,
      result.stderr,
    ].join('\n'))
  }
  return result.stdout
}

describe('dsh-quota packed artifact', () => {
  it('packs the exact runtime contract and installs into a NodeNext consumer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-quota-pack-'))
    temporaryRoots.push(root)
    const packDirectory = join(root, 'packed')
    await mkdir(packDirectory)

    runPackageManager(['run', 'build'], packageRoot)
    runPackageManager(['pack', '--pack-destination', packDirectory], packageRoot)

    const tarballs = (await readdir(packDirectory)).filter(file => file.endsWith('.tgz'))
    expect(tarballs).toHaveLength(1)
    const tarball = join(packDirectory, tarballs[0]!)
    const listing = spawnSync('tar', ['-tf', tarball], { encoding: 'utf8' })
    expect(listing.status, listing.stderr).toBe(0)
    expect(listing.stdout.trim().split(/\r?\n/).sort()).toEqual([
      'package/CHANGELOG.md',
      'package/LICENSE',
      'package/README.md',
      'package/cordis.patch.yml',
      'package/docs/compatibility.md',
      'package/docs/security.md',
      'package/docs/verification.md',
      'package/lib/index.js',
      'package/lib/invariant.js',
      'package/lib/public.js',
      'package/lib/types/index.d.ts',
      'package/lib/types/invariant.d.ts',
      'package/lib/types/public.d.ts',
      'package/package.json',
    ])

    const consumer = join(root, 'consumer')
    await mkdir(consumer)
    await writeFile(join(consumer, 'package.json'), JSON.stringify({
      name: 'dsh-quota-pack-consumer',
      private: true,
      type: 'module',
      dependencies: { '@dsh-plugins/dsh-quota': `file:${tarball.replaceAll('\\', '/')}` },
      devDependencies: { typescript: '^6.0.3' },
    }, undefined, 2))
    await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        noEmit: true,
        strict: true,
        target: 'ES2024',
      },
      include: ['consumer.mts'],
    }, undefined, 2))
    await writeFile(join(consumer, 'consumer.mts'), [
      "import * as Quota from '@dsh-plugins/dsh-quota'",
      "import * as Invariant from '@dsh-plugins/dsh-quota/invariant'",
      "import * as QuotaTypes from '@dsh-plugins/dsh-quota/types'",
      "import type { QuotaPluginDependencies } from '@dsh-plugins/dsh-quota'",
      "import type { QuotaProvider, QuotaService } from '@dsh-plugins/dsh-quota/types'",
      'const service: QuotaService | undefined = undefined',
      'const provider: QuotaProvider | undefined = undefined',
      'const composition: QuotaPluginDependencies = { providers: () => [] }',
      'const composed = Quota.createQuotaPlugin(composition)',
      'void service; void provider',
      "if ('default' in Quota) throw new Error('unexpected default export')",
      "if (Quota.name !== 'dsh-quota' || Invariant.name !== 'dsh-quota-invariant') throw new Error('unexpected name')",
      "if (composed.name !== 'dsh-quota') throw new Error('unexpected composed plugin')",
      "if (Object.keys(QuotaTypes).length !== 0) throw new Error('types subpath must be type-only')",
      '',
    ].join('\n'))

    runPackageManager(['install', '--prefer-offline', '--ignore-scripts'], consumer)
    runPackageManager(['exec', 'tsc', '--noEmit'], consumer)
    const execution = spawnSync(process.execPath, ['consumer.mts'], { cwd: consumer, encoding: 'utf8' })
    expect(execution.status, execution.stderr).toBe(0)

    const manifest = JSON.parse(await readFile(
      join(consumer, 'node_modules', '@dsh-plugins', 'dsh-quota', 'package.json'),
      'utf8',
    )) as { dsh?: { bundle?: { patch?: string } } }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  }, 120_000)
})
