import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_NAME = '@deepseek-ai/dsh-remote-control'
const PROFILE = 'web'
const REQUIRED = process.env.DSH_INSTALL_SMOKE_REQUIRED === '1'
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function artifactFilename(name, version) {
  return `${name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`
}

export function assessCliCapabilities(help, pluginHelp) {
  const missing = []
  if (!help.includes('--dump-config')) missing.push('--dump-config')
  if (!help.includes('plugin') || !pluginHelp.includes('--profile')) missing.push('plugin --profile')
  return missing
}

export function buildProfilePatch({ lanPort, managementPort, statePath }) {
  const yamlPath = statePath.replaceAll('\\', '/').replaceAll("'", "''")
  return [
    '- id: dsh-remote-control.gateway',
    '  config:',
    '    enabled: true',
    '    lan: true',
    "    address: '127.0.0.1'",
    `    port: ${lanPort}`,
    `    managementPort: ${managementPort}`,
    `    statePath: '${yamlPath}'`,
    '',
  ].join('\n')
}

function commandNeedsShell(command) {
  return process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)
}

function locateCli() {
  if (process.env.DSH_INSTALL_SMOKE_COMMAND?.trim()) return process.env.DSH_INSTALL_SMOKE_COMMAND.trim()
  const locator = process.platform === 'win32'
    ? spawnSync('where.exe', ['dsh'], { encoding: 'utf8' })
    : spawnSync('which', ['dsh'], { encoding: 'utf8' })
  if (locator.status !== 0) return undefined
  const candidates = locator.stdout.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  if (process.platform !== 'win32') return candidates[0]
  return candidates.find(candidate => /\.(?:exe|cmd|bat)$/i.test(candidate)) ?? candidates[0]
}

function runCapture(command, args, env = process.env) {
  return spawnSync(command, args, {
    cwd: packageDir,
    encoding: 'utf8',
    env,
    maxBuffer: 16 * 1024 * 1024,
    shell: commandNeedsShell(command),
  })
}

function runChecked(command, args, env, label) {
  process.stdout.write(`install:smoke ${label}\n`)
  const result = runCapture(command, args, env)
  if (result.error !== undefined || result.status !== 0) {
    throw new Error([
      `${label} failed (${result.error?.message ?? `exit ${result.status ?? 'unknown'}`})`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'))
  }
  return `${result.stdout}${result.stderr}`
}

function skip(reason) {
  const message = `install:smoke SKIP: ${reason}`
  if (REQUIRED) throw new Error(`${message} (DSH_INSTALL_SMOKE_REQUIRED=1)`)
  process.stdout.write(`${message}\n`)
}

async function reserveLoopbackPorts(count) {
  const servers = []
  try {
    for (let index = 0; index < count; index += 1) {
      const server = createServer()
      servers.push(server)
      await new Promise((accept, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', accept)
      })
    }
    return servers.map((server) => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('could not reserve a loopback port')
      return address.port
    })
  } finally {
    await Promise.all(servers.map(server => new Promise(resolveClose => server.close(resolveClose))))
  }
}

function startCli(command, args, env) {
  const child = spawn(command, args, {
    cwd: packageDir,
    env,
    shell: commandNeedsShell(command),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', chunk => { stdout = `${stdout}${String(chunk)}`.slice(-64 * 1024) })
  child.stderr?.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-64 * 1024) })
  return { child, output: () => `${stdout}${stderr}` }
}

async function waitForManagement(url, processState, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (processState.child.exitCode !== null) {
      throw new Error(`profile exited before the management listener was ready\n${processState.output()}`)
    }
    try {
      const response = await fetch(`${url}/dsh-remote-control/v1/management/devices`)
      if (response.status === 200) return
    } catch {
      // The loopback listener has not bound yet.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error(`timed out waiting for the management listener\n${processState.output()}`)
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return true
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit(true)
    })
  })
}

async function stopCli(child) {
  if (child.exitCode !== null || child.pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { encoding: 'utf8' })
    await waitForExit(child, 5_000)
    return
  }
  child.kill('SIGINT')
  if (await waitForExit(child, 5_000)) return
  child.kill('SIGTERM')
  if (await waitForExit(child, 2_000)) return
  child.kill('SIGKILL')
  await waitForExit(child, 2_000)
}

async function readJson(response, label) {
  const text = await response.text()
  if (!response.ok) throw new Error(`${label} failed: HTTP ${response.status} ${text}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} returned non-JSON data: ${text}`)
  }
}

async function exerciseRemoteApi(lanUrl, managementUrl) {
  const { createRemoteControlClient, generateDeviceIdentity } = await import('../lib/index.js')
  const invitation = await readJson(await fetch(
    `${managementUrl}/dsh-remote-control/v1/management/pairing/open`,
    { method: 'POST' },
  ), 'pairing invitation')
  const identity = generateDeviceIdentity()
  const client = createRemoteControlClient({
    baseUrl: lanUrl,
    identity,
    hostPublicKey: invitation.hostPublicKey,
  })
  try {
    await client.pair(invitation, 'install-smoke')
    process.stdout.write('install:smoke pair PASS\n')

    const listed = await client.list()
    if (!listed || !Array.isArray(listed.items)) throw new Error('session.list returned no items array')
    process.stdout.write('install:smoke list PASS\n')

    const firstSession = listed.items.find(item => typeof item?.sessionId === 'string')
    if (firstSession === undefined) {
      await client.history({ sessionId: 'install-smoke-no-such-session' }).then(
        () => { throw new Error('session.history unexpectedly accepted an id absent from the latest list') },
        () => undefined,
      )
      process.stdout.write('install:smoke history PASS (no sessions; authorization rejection verified)\n')
    } else {
      await client.history({ sessionId: firstSession.sessionId, maxMessages: 1 })
      process.stdout.write('install:smoke history PASS\n')
    }

    const devices = await readJson(await fetch(
      `${managementUrl}/dsh-remote-control/v1/management/devices`,
    ), 'device list')
    if (!Array.isArray(devices.devices) || !devices.devices.some(device => device.deviceId === identity.deviceId)) {
      throw new Error('paired device is absent from the management list')
    }

    const revoked = await readJson(await fetch(
      `${managementUrl}/dsh-remote-control/v1/management/devices/revoke`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: identity.deviceId }),
      },
    ), 'device revoke')
    if (revoked.revoked !== true) throw new Error('device revoke did not report success')
    await client.list().then(
      () => { throw new Error('revoked device unexpectedly retained access') },
      () => undefined,
    )
    process.stdout.write('install:smoke revoke PASS\n')
  } finally {
    client.dispose()
  }
}

export async function main() {
  const cli = locateCli()
  if (cli === undefined) return skip('no dsh CLI found on PATH; set DSH_INSTALL_SMOKE_COMMAND to a real rc.5-compatible executable')

  const helpResult = runCapture(cli, ['--help'])
  const pluginHelpResult = runCapture(cli, ['plugin', '--help'])
  if (helpResult.error !== undefined || pluginHelpResult.error !== undefined) {
    return skip(`could not execute ${cli}: ${helpResult.error?.message ?? pluginHelpResult.error?.message}`)
  }
  const missing = assessCliCapabilities(
    `${helpResult.stdout}${helpResult.stderr}`,
    `${pluginHelpResult.stdout}${pluginHelpResult.stderr}`,
  )
  if (missing.length > 0) return skip(`dsh CLI lacks required capabilities: ${missing.join(', ')}`)

  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
  const tarball = join(packageDir, '.artifacts', artifactFilename(manifest.name, manifest.version))
  if (!existsSync(tarball)) throw new Error(`packed artifact is missing: ${tarball}`)

  const home = await mkdtemp(join(tmpdir(), 'dsh-remote-control-install-smoke-'))
  const env = { ...process.env, DSH_HOME: home }
  const profileDir = join(home, 'profiles', PROFILE)
  const patchPath = join(profileDir, 'cordis.patch.yml')
  let installed = false
  let runtime
  let failure
  try {
    runChecked(cli, ['plugin', '--profile', PROFILE, 'add', tarball], env, 'add')
    installed = true

    const defaultDump = runChecked(cli, ['--profile', PROFILE, '--dump-config'], env, 'dump')
    if (!defaultDump.includes(PACKAGE_NAME) || !defaultDump.includes('enabled: false')) {
      throw new Error('config dump does not contain the installed disabled-by-default plugin')
    }

    const [lanPort, managementPort] = await reserveLoopbackPorts(2)
    await writeFile(patchPath, buildProfilePatch({
      lanPort,
      managementPort,
      statePath: join(home, 'remote-control', 'state.json'),
    }))
    const enabledDump = runChecked(cli, ['--profile', PROFILE, '--dump-config'], env, 'dump enabled override')
    if (!enabledDump.includes('enabled: true') || !enabledDump.includes(`managementPort: ${managementPort}`)) {
      throw new Error('config dump did not apply the isolated smoke override')
    }

    process.stdout.write('install:smoke start\n')
    runtime = startCli(cli, ['--profile', PROFILE, '--port', '0'], env)
    const lanUrl = `http://127.0.0.1:${lanPort}`
    const managementUrl = `http://127.0.0.1:${managementPort}`
    await waitForManagement(managementUrl, runtime)
    process.stdout.write('install:smoke start PASS\n')
    await exerciseRemoteApi(lanUrl, managementUrl)
  } catch (error) {
    failure = error
  } finally {
    if (runtime !== undefined) {
      try {
        await stopCli(runtime.child)
      } catch (error) {
        failure ??= error
      }
    }
    if (installed) {
      try {
        await writeFile(patchPath, '[]\n')
        runChecked(cli, ['plugin', '--profile', PROFILE, 'remove', PACKAGE_NAME], env, 'uninstall')
        const uninstalledDump = runChecked(cli, ['--profile', PROFILE, '--dump-config'], env, 'dump after uninstall')
        if (uninstalledDump.includes(PACKAGE_NAME)) {
          failure ??= new Error('uninstalled package remains in the config dump')
        }
      } catch (error) {
        failure ??= error
      }
    }
    try {
      await rm(home, { recursive: true, force: true })
    } catch (error) {
      failure ??= error
    }
  }
  if (failure !== undefined) throw failure
  process.stdout.write('install:smoke PASS (isolated DSH_HOME removed)\n')
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`install:smoke FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
