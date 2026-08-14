import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
const tarball = join(packageRoot, '.pack', `${manifest.name}-${manifest.version}.tgz`)
const consumer = await mkdtemp(join(tmpdir(), 'dsh-remote-compaction-consumer-'))
const packageManagerCli = process.env.npm_execpath
const require = createRequire(import.meta.url)
const tsc = require.resolve('typescript/bin/tsc')

if (packageManagerCli === undefined) {
  throw new Error('pack smoke requires a package-manager lifecycle with npm_execpath')
}

function run(command, args) {
  execFileSync(command, args, { cwd: consumer, stdio: 'inherit' })
}

async function declarations(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await declarations(path))
    else if (entry.name.endsWith('.d.ts')) files.push(path)
  }
  return files
}

try {
  await writeFile(join(consumer, 'package.json'), JSON.stringify({
    name: 'dsh-remote-compaction-consumer-smoke',
    version: '0.0.0',
    private: true,
    type: 'module',
  }, null, 2))
  run(process.execPath, [
    packageManagerCli,
    '--ignore-workspace',
    'add',
    '--config.auto-install-peers=false',
    tarball,
    '@deepseek-ai/cordis@4.0.1',
    '@deepseek-ai/dsh-agent@0.1.0-rc.6',
    '@deepseek-ai/dsh-attachment@0.1.0-rc.6',
    '@deepseek-ai/dsh-brand@0.1.0-rc.6',
    '@deepseek-ai/dsh-commands@0.1.0-rc.6',
    '@deepseek-ai/dsh-compaction@0.1.0-rc.6',
    '@deepseek-ai/dsh-compaction-basic@0.1.0-rc.6',
    '@deepseek-ai/dsh-credentials@0.1.0-rc.6',
    '@deepseek-ai/dsh-invariants@0.1.0-rc.6',
    '@deepseek-ai/dsh-llm@0.1.0-rc.6',
    '@deepseek-ai/dsh-scope@0.1.0-rc.6',
    '@deepseek-ai/dsh-session-projection@0.1.0-rc.6',
    '@deepseek-ai/dsh-session@0.1.0-rc.6',
    '@deepseek-ai/dsh-system-prompt@0.1.0-rc.6',
    '@deepseek-ai/dsh-timeout@0.1.0-rc.6',
    '@deepseek-ai/dsh-token-meter@0.1.0-rc.6',
    '@deepseek-ai/dsh-typert-protocol@0.1.0-rc.6',
  ])
  await writeFile(join(consumer, 'index.ts'), [
    "import Remote, { RemoteCompactionEngine } from 'dsh-remote-compaction'",
    "import * as invariant from 'dsh-remote-compaction/invariant'",
    "import { OpenAICompactTransport } from 'dsh-remote-compaction/transport'",
    'void [Remote, RemoteCompactionEngine, invariant, OpenAICompactTransport]',
  ].join('\n'))
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ES2024',
      lib: ['ES2024', 'ESNext.Disposable', 'DOM', 'DOM.Iterable'],
      strict: true,
      skipLibCheck: false,
      noEmit: true,
    },
    include: ['index.ts'],
  }, null, 2))
  run(process.execPath, [tsc, '--project', 'tsconfig.json'])

  const installedRoot = join(consumer, 'node_modules', manifest.name)
  for (const path of await declarations(join(installedRoot, 'lib', 'types'))) {
    const content = await readFile(path, 'utf8')
    if (/from\s+['"][^'"]+\.ts['"]/.test(content)) {
      throw new Error(`declaration references missing TypeScript source: ${path}`)
    }
    if (/sourceMappingURL=.*\.d\.ts\.map/.test(content)) {
      throw new Error(`declaration references a missing declaration map: ${path}`)
    }
  }
  console.log('NodeNext tarball consumer (rc.6 declaration host): passed')
} finally {
  await rm(consumer, { recursive: true, force: true })
}
