import type { PairedDevice, TrustStore } from './types.ts'

/** Create an in-memory trust store suitable for tests and ephemeral deployments. */
export function createMemoryTrustStore(initial: PairedDevice[] = []): TrustStore {
  const records = new Map(initial.map(device => [device.deviceId, structuredClone(device)]))
  return {
    get(deviceId) {
      const device = records.get(deviceId)
      return device === undefined ? undefined : structuredClone(device)
    },
    put(device) {
      records.set(device.deviceId, structuredClone(device))
    },
    revoke(deviceId, at) {
      const device = records.get(deviceId)
      if (device === undefined || device.revokedAt !== null) return false
      records.set(deviceId, { ...device, revokedAt: at })
      return true
    },
    list() {
      return [...records.values()].map(device => structuredClone(device))
    },
  }
}
