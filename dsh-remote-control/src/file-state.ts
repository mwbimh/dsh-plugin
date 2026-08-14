import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { generateDeviceIdentity } from './identity.ts'
import type { DeviceIdentity, PairedDevice, TrustStore } from './types.ts'

interface StoredState {
  version: 1
  identity: DeviceIdentity
  devices: PairedDevice[]
}

/** Persistent host identity and trust database stored in one mode-0600 state file. */
export interface FileState {
  identity: DeviceIdentity
  trustStore: TrustStore
}

/** Open or create the dedicated remote-control state file. */
export function openFileState(path: string): FileState {
  const existing = readState(path)
  const state = existing ?? { version: 1 as const, identity: generateDeviceIdentity(), devices: [] }
  const devices = new Map(state.devices.map(device => [device.deviceId, structuredClone(device)]))
  const persist = (): void => writeState(path, {
    version: 1,
    identity: state.identity,
    devices: [...devices.values()],
  })
  if (existing === undefined) persist()
  return {
    identity: structuredClone(state.identity),
    trustStore: {
      get(deviceId) {
        const device = devices.get(deviceId)
        return device === undefined ? undefined : structuredClone(device)
      },
      put(device) {
        devices.set(device.deviceId, structuredClone(device))
        persist()
      },
      revoke(deviceId, at) {
        const device = devices.get(deviceId)
        if (device === undefined || device.revokedAt !== null) return false
        devices.set(deviceId, { ...device, revokedAt: at })
        persist()
        return true
      },
      list() {
        return [...devices.values()].map(device => structuredClone(device))
      },
    },
  }
}

function readState(path: string): StoredState | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const value: unknown = JSON.parse(raw)
  if (!isStoredState(value)) throw new Error('dsh-remote-control: invalid state file')
  return value
}

function writeState(path: string, state: StoredState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
}

function isStoredState(value: unknown): value is StoredState {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<StoredState>
  return candidate.version === 1
    && typeof candidate.identity?.deviceId === 'string'
    && typeof candidate.identity.publicKey === 'string'
    && typeof candidate.identity.privateKey === 'string'
    && Array.isArray(candidate.devices)
}
