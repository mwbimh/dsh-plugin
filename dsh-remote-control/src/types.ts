/** A capability accepted by the first remote-control protocol version. */
export type Capability = 'sessions.read'

/** A long-lived Ed25519 device identity. */
export interface DeviceIdentity {
  deviceId: string
  publicKey: string
  privateKey: string
}

/** Metadata retained for one paired client device. */
export interface PairedDevice {
  deviceId: string
  publicKey: string
  friendlyName: string
  capabilities: Capability[]
  pairedAt: string
  lastSeenAt: string | null
  revokedAt: string | null
}

/** One locally opened, short-lived pairing invitation. */
export interface PairingInvitation {
  pairingId: string
  code: string
  expiresAt: number
  hostPublicKey: string
  lanUrl: string
}

/** Minimal session-list row exposed by the read-only listener. */
export interface RemoteSessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: string
  origin?: 'subagent'
}

/** Minimal history event exposed by the read-only listener. */
export interface RemoteHistoryEntry {
  event: {
    seq: number
    type: string
    time: number
    data: unknown
    ignorable?: boolean
  }
}

/** DSH public-service adapter used after authentication and authorization. */
export interface SessionsReadAdapter {
  list(options: { signal: AbortSignal }): Promise<{ items: RemoteSessionSummary[] }>
  history(
    request: { sessionId: string; beforeSeq?: number; maxMessages?: number },
    options: { signal: AbortSignal },
  ): Promise<{ events: RemoteHistoryEntry[]; hasMore: boolean }>
}

/** A redacted security audit record. */
export interface AuditEvent {
  at: string
  deviceId?: string
  operation: string
  result: 'allowed' | 'denied'
  reason?: string
}

/** Storage interface for paired-device authorization state. */
export interface TrustStore {
  get(deviceId: string): PairedDevice | undefined
  put(device: PairedDevice): void
  revoke(deviceId: string, at: string): boolean
  list(): PairedDevice[]
}
