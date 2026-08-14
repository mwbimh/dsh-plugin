import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const command = process.platform === 'win32'
  ? { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', 'npm pack --dry-run --json'] }
  : { file: 'npm', args: ['pack', '--dry-run', '--json'] }

const result = spawnSync(command.file, command.args, {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
  env: {
    ...process.env,
    npm_config_cache: join(tmpdir(), 'dsh-usage-analytics-npm-cache'),
  },
})
if (result.status !== 0) {
  throw new Error(result.stderr || result.stdout || 'npm pack --dry-run failed')
}

const packed = JSON.parse(result.stdout)
const files = packed[0]?.files?.map(file => file.path)
if (!Array.isArray(files)) throw new Error('npm pack --dry-run returned no file list')

const required = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/index.d.ts',
  'lib/invariant.js',
  'lib/invariant.d.ts',
]
for (const path of required) {
  if (!files.includes(path)) throw new Error(`packed artifact is missing ${path}`)
}

const forbidden = files.filter(path =>
  path.startsWith('src/')
  || path.startsWith('tests/')
  || path.startsWith('scripts/')
  || path.startsWith('.codex-plugin/')
  || path.endsWith('.map')
  || path.endsWith('package-lock.json'))
if (forbidden.length > 0) {
  throw new Error(`packed artifact contains forbidden files: ${forbidden.join(', ')}`)
}
