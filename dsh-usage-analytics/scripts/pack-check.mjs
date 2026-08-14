import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const workspaceDir = dirname(packageDir)
const scratch = await mkdtemp(join(tmpdir(), 'dsh-usage-analytics-pack-'))
const packDir = join(scratch, 'pack')
const consumerDir = join(scratch, 'consumer')
const npmCache = join(scratch, 'npm-cache')

const expectedFiles = [
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'cordis.patch.yml',
  'lib/index.d.ts',
  'lib/index.js',
  'lib/invariant.d.ts',
  'lib/invariant.js',
  'package.json',
].sort()

function checkedSpawn(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim()
    throw new Error(`${file} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`)
  }
  return result.stdout
}

function cmdQuote(value) {
  if (/[\r\n"]/u.test(value)) {
    throw new Error(`cannot safely pass command argument: ${JSON.stringify(value)}`)
  }
  return `"${value}"`
}

function runNpm(args, cwd) {
  const command = process.platform === 'win32'
    ? process.execPath
    : 'npm'
  const npmArgs = process.platform === 'win32'
    ? [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...args]
    : args
  return checkedSpawn(command, npmArgs, {
    cwd,
    env: {
      ...process.env,
      npm_config_cache: npmCache,
    },
  })
}

function runPnpm(args, cwd) {
  const env = { ...process.env, npm_config_cache: npmCache }
  if (process.platform !== 'win32') return checkedSpawn('pnpm', args, { cwd, env })
  const commandLine = ['pnpm', ...args.map(cmdQuote)].join(' ')
  return checkedSpawn(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/s', '/c', commandLine],
    { cwd, env, windowsVerbatimArguments: true },
  )
}

function configuredDshCli() {
  const configured = process.env.DSH_USAGE_ANALYTICS_DSH_CLI
  if (configured === undefined || configured.trim() === '') return undefined
  const artifact = resolve(configured)
  return artifact.endsWith('.js') || artifact.endsWith('.mjs')
    ? { command: process.execPath, prefix: [artifact] }
    : { command: artifact, prefix: [] }
}

function runDsh(cli, args, env) {
  const fullArgs = [...cli.prefix, ...args]
  if (process.platform === 'win32' && cli.command.endsWith('.cmd')) {
    const commandLine = ['call', cmdQuote(cli.command), ...fullArgs.map(cmdQuote)].join(' ')
    return checkedSpawn(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', commandLine],
      { env, windowsVerbatimArguments: true },
    )
  }
  return checkedSpawn(cli.command, fullArgs, { env })
}

async function runDshProfileGate(cli, tarballPath) {
  const profile = `usage-analytics-pack-${process.pid}`
  const env = {
    ...process.env,
    DSH_HOME: join(scratch, 'dsh-home'),
  }
  const requiredDumpFragments = [
    '# == dsh-usage-analytics',
    'id: dsh-usage-analytics',
    'id: dsh-usage-analytics-invariant',
    'name: dsh-usage-analytics/invariant',
  ]
  let installed = false
  try {
    runDsh(cli, ['plugin', '--profile', profile, 'add', tarballPath], env)
    installed = true
    const installedDump = runDsh(cli, ['--profile', profile, '--dump-config'], env)
    for (const fragment of requiredDumpFragments) {
      if (!installedDump.includes(fragment)) {
        throw new Error(`DSH profile dump is missing ${JSON.stringify(fragment)}`)
      }
    }

    runDsh(cli, ['plugin', '--profile', profile, 'remove', 'dsh-usage-analytics'], env)
    installed = false
    const removedDump = runDsh(cli, ['--profile', profile, '--dump-config'], env)
    for (const fragment of requiredDumpFragments) {
      if (removedDump.includes(fragment)) {
        throw new Error(`DSH profile dump retained ${JSON.stringify(fragment)} after remove`)
      }
    }
    console.log('[pack-check] DSH profile add/dump/remove gate passed')
  } finally {
    if (installed) {
      runDsh(cli, ['plugin', '--profile', profile, 'remove', 'dsh-usage-analytics'], env)
    }
  }
}

try {
  await mkdir(packDir)
  await mkdir(consumerDir)

  const packOutput = runPnpm(['pack', '--json', '--pack-destination', packDir], packageDir)
  const jsonStart = packOutput.lastIndexOf('\n{')
  const manifest = JSON.parse(packOutput.slice(jsonStart < 0 ? 0 : jsonStart + 1))
  if (manifest === undefined || typeof manifest.filename !== 'string') {
    throw new Error('npm pack returned no tarball manifest')
  }

  const actualFiles = manifest.files?.map(file => file.path).sort()
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `packed artifact file list mismatch\nexpected: ${expectedFiles.join(', ')}\nactual: ${(actualFiles ?? []).join(', ')}`,
    )
  }

  const tarballPath = isAbsolute(manifest.filename)
    ? manifest.filename
    : join(packDir, manifest.filename)
  await writeFile(join(consumerDir, 'package.json'), JSON.stringify({
    name: 'dsh-usage-analytics-pack-consumer',
    private: true,
    type: 'module',
  }, null, 2))
  runNpm([
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    tarballPath,
  ], consumerDir)

  await writeFile(join(consumerDir, 'runtime-smoke.mjs'), `
import assert from 'node:assert/strict'
import * as plugin from 'dsh-usage-analytics'
import * as invariant from 'dsh-usage-analytics/invariant'

assert.equal(plugin.name, 'dsh-usage-analytics')
assert.equal(typeof plugin.apply, 'function')
assert.equal('default' in plugin, false)
assert.equal(invariant.name, 'dsh-usage-analytics-invariant')
assert.equal(typeof invariant.apply, 'function')
assert.equal('default' in invariant, false)
`)
  checkedSpawn(process.execPath, ['runtime-smoke.mjs'], { cwd: consumerDir })

  await writeFile(join(consumerDir, 'consumer.ts'), `
import {
  createConversationUsageState,
  type ConversationUsageProjection,
} from 'dsh-usage-analytics'
import { name as invariantName } from 'dsh-usage-analytics/invariant'

const projection: ConversationUsageProjection = {
  measuredCalls: 0,
  missingUsageCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  reasoningUsageCalls: 0,
  routes: [],
}

void [createConversationUsageState(), projection, invariantName]
`)
  await writeFile(join(consumerDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      exactOptionalPropertyTypes: true,
      lib: ['ESNext', 'DOM'],
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      noEmit: true,
      noUncheckedIndexedAccess: true,
      strict: true,
      target: 'ES2022',
    },
    include: ['consumer.ts'],
  }, null, 2))
  checkedSpawn(process.execPath, [
    join(workspaceDir, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--project',
    'tsconfig.json',
  ], { cwd: consumerDir })

  console.log(`[pack-check] clean ESM/NodeNext consumer passed for ${manifest.filename}`)

  const dshCli = configuredDshCli()
  if (dshCli === undefined) {
    console.log(
      '[pack-check] SKIP DSH profile add/dump/remove gate: '
      + 'set DSH_USAGE_ANALYTICS_DSH_CLI to an installed dsh executable or launcher artifact',
    )
  } else {
    await runDshProfileGate(dshCli, tarballPath)
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
