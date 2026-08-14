import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
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

describe('dsh-oauth packed artifact', () => {
  it('packs only published runtime files and installs into a NodeNext consumer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-oauth-pack-'))
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
    const files = listing.stdout.trim().split(/\r?\n/).sort()
    expect(files).toEqual([
      'package/CHANGELOG.md',
      'package/LICENSE',
      'package/README.md',
      'package/cordis.patch.yml',
      'package/docs/0001-credential-bridge-spike.md',
      'package/docs/security.md',
      'package/lib/index.js',
      'package/lib/invariant.js',
      'package/lib/types/index.d.ts',
      'package/lib/types/invariant.d.ts',
      'package/lib/types/public.d.ts',
      'package/lib/types/public.js',
      'package/package.json',
    ])
    expect(files.some(file => /(?:^|\/)(?:src|tests|coverage|node_modules)(?:\/|$)/.test(file))).toBe(false)

    const consumer = join(root, 'consumer')
    await mkdir(consumer)
    await writeFile(join(consumer, 'package.json'), JSON.stringify({
      name: 'dsh-oauth-pack-consumer',
      private: true,
      type: 'module',
      dependencies: {
        '@dsh-plugins/dsh-oauth': `file:${tarball.replaceAll('\\', '/')}`,
      },
      devDependencies: {
        '@deepseek-ai/cordis': '4.0.1',
        typescript: '^6.0.3',
      },
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
      "import * as OAuth from '@dsh-plugins/dsh-oauth'",
      "import * as Invariant from '@dsh-plugins/dsh-oauth/invariant'",
      "import * as OAuthTypes from '@dsh-plugins/dsh-oauth/types'",
      "import { Context } from '@deepseek-ai/cordis'",
      "import type { ManagedOAuthService, OAuthAccountService, OAuthRuntimeComposition } from '@dsh-plugins/dsh-oauth/types'",
      '// @ts-expect-error sensitive credentials are not part of the public types subpath',
      "import type { OAuthCredential } from '@dsh-plugins/dsh-oauth/types'",
      'const optionalAccountService: OAuthAccountService | undefined = undefined',
      'void optionalAccountService',
      "if ('default' in OAuth) throw new Error('unexpected default export')",
      "if (OAuth.name !== 'dsh-oauth' || Invariant.name !== 'dsh-oauth-invariant') throw new Error('unexpected plugin name')",
      "if (Object.keys(OAuthTypes).length !== 0) throw new Error('types subpath must not export runtime state')",
      'let disposed = false',
      'const managed: ManagedOAuthService = {',
      '  providers: () => [],',
      '  accounts: async () => [],',
      "  accountCredential: async () => { throw new Error('no account') },",
      "  login: async () => { throw new Error('no provider') },",
      '  logout: async () => {},',
      '  ensureFresh: async () => {},',
      '  rotate: async () => {},',
      '  ensureFreshForRoute: async () => undefined,',
      '  dispose: async () => { disposed = true },',
      '}',
      'const runtime: OAuthRuntimeComposition = { createService: () => managed }',
      'const ctx = new Context()',
      "ctx.provide('llm', {})",
      "ctx.provide('credentials', {})",
      "ctx.provide('commands', { register: () => () => {} })",
      "ctx.provide('dsh-oauth-runtime', runtime)",
      'OAuth.apply(ctx, {})',
      "if (ctx.get('dsh-oauth') !== managed) throw new Error('canonical apply did not publish its service')",
      'await ctx.fiber.dispose()',
      "if (!disposed) throw new Error('canonical apply did not dispose its service')",
      '',
    ].join('\n'))

    runPackageManager(['install', '--prefer-offline', '--ignore-scripts'], consumer)
    runPackageManager(['exec', 'tsc', '--noEmit'], consumer)
    const execution = spawnSync(process.execPath, ['consumer.mts'], { cwd: consumer, encoding: 'utf8' })
    expect(execution.status, execution.stderr).toBe(0)

    const installedManifest = JSON.parse(await readFile(
      join(consumer, 'node_modules', '@dsh-plugins', 'dsh-oauth', 'package.json'),
      'utf8',
    )) as { dsh?: { bundle?: { patch?: string } } }
    expect(installedManifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  }, 120_000)
})
