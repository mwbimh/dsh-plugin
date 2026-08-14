import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { deviceIdForPublicKey, generateDeviceIdentity, verifyTranscript } from './identity.ts'
import type {
  AuditEvent,
  DeviceIdentity,
  PairingInvitation,
  PairedDevice,
  SessionsReadAdapter,
  TrustStore,
} from './types.ts'

const PROTOCOL_VERSION = 1

export interface RemoteControlServerOptions {
  enabled: boolean
  listen: { lan: boolean; address: string; port: number }
  management?: { address: string; port: number }
  pairing?: { ttlMs: number; maxAttempts: number }
  limits?: { maxFrameBytes: number; requestTimeoutMs: number; headersTimeoutMs: number }
  adapter: SessionsReadAdapter
  trustStore: TrustStore
  identity?: DeviceIdentity
  audit?: (event: AuditEvent) => void
}

interface PairingState extends PairingInvitation {
  attempts: number
  used: boolean
}

interface ChallengeState {
  deviceId: string
  challenge: string
  expiresAt: number
}

interface ActiveRequest {
  deviceId: string
  controller: AbortController
}

export interface RemoteControlServer {
  readonly addresses: { lan: string | null; management: string | null }
  start(): Promise<void>
  dispose(): Promise<void>
  openPairing(): PairingInvitation
  revokeDevice(deviceId: string): boolean
}

/** Create an isolated authenticated listener that never exposes the existing DSH `/api`. */
export function createRemoteControlServer(options: RemoteControlServerOptions): RemoteControlServer {
  const identity = options.identity ?? generateDeviceIdentity()
  const pairing = options.pairing ?? { ttlMs: 120_000, maxAttempts: 5 }
  const limits = options.limits ?? { maxFrameBytes: 1_048_576, requestTimeoutMs: 30_000, headersTimeoutMs: 5_000 }
  const invitations = new Map<string, PairingState>()
  const challenges = new Map<string, ChallengeState>()
  const authorizedSessions = new Map<string, Set<string>>()
  const active = new Set<ActiveRequest>()
  const connections = new Set<import('node:net').Socket>()
  const headerDeadlines = new Map<import('node:net').Socket, NodeJS.Timeout>()
  const activeSettlements = new Set<Promise<void>>()
  let server: Server | undefined
  let managementServer: Server | undefined
  let lanAddress: string | null = null
  let managementAddress: string | null = null

  const audit = (event: Omit<AuditEvent, 'at'>): void => options.audit?.({ at: new Date().toISOString(), ...event })

  const api: RemoteControlServer = {
    get addresses() {
      return { lan: lanAddress, management: managementAddress }
    },
    async start() {
      if (!options.enabled || !options.listen.lan || server !== undefined) return
      if (options.listen.address === '0.0.0.0' || options.listen.address === '::') {
        throw new Error('dsh-remote-control: LAN listener requires an explicit interface address')
      }
      server = createServer((request, response) => {
        const deadline = headerDeadlines.get(request.socket)
        if (deadline !== undefined) {
          clearTimeout(deadline)
          headerDeadlines.delete(request.socket)
        }
        void route(request, response).catch((error: unknown) => {
          if (!response.headersSent) writeJson(response, 500, { error: 'internal' })
          else response.destroy(error instanceof Error ? error : undefined)
        })
      })
      server.on('connection', (socket) => {
        connections.add(socket)
        const headerDeadline = setTimeout(() => {
          headerDeadlines.delete(socket)
          socket.destroy()
        }, limits.headersTimeoutMs)
        headerDeadlines.set(socket, headerDeadline)
        socket.once('close', () => {
          clearTimeout(headerDeadline)
          headerDeadlines.delete(socket)
          connections.delete(socket)
        })
      })
      server.headersTimeout = limits.headersTimeoutMs
      server.requestTimeout = limits.requestTimeoutMs
      server.listen(options.listen.port, options.listen.address)
      await once(server, 'listening')
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('dsh-remote-control: TCP address unavailable')
      lanAddress = `http://${formatHost(address.address)}:${address.port}`
      if (options.management !== undefined) {
        if (!isLoopbackAddress(options.management.address)) {
          await api.dispose()
          throw new Error('dsh-remote-control: management listener must bind loopback')
        }
        managementServer = createServer((request, response) => {
          void routeManagement(request, response).catch((error: unknown) => {
            if (!response.headersSent) writeJson(response, 500, { error: 'internal' })
            else response.destroy(error instanceof Error ? error : undefined)
          })
        })
        managementServer.headersTimeout = limits.headersTimeoutMs
        managementServer.requestTimeout = limits.requestTimeoutMs
        managementServer.listen(options.management.port, options.management.address)
        await once(managementServer, 'listening')
        const bound = managementServer.address()
        if (bound === null || typeof bound === 'string') throw new Error('dsh-remote-control: management address unavailable')
        managementAddress = `http://${formatHost(bound.address)}:${bound.port}`
      }
    },
    async dispose() {
      for (const request of active) request.controller.abort(new Error('server disposed'))
      challenges.clear()
      invitations.clear()
      const current = server
      const currentManagement = managementServer
      server = undefined
      managementServer = undefined
      lanAddress = null
      managementAddress = null
      current?.close()
      current?.closeAllConnections()
      currentManagement?.close()
      currentManagement?.closeAllConnections()
      for (const socket of connections) socket.destroy()
      await Promise.allSettled(activeSettlements)
      active.clear()
    },
    openPairing() {
      if (server === undefined || lanAddress === null) throw new Error('dsh-remote-control: listener is not running')
      const invitation: PairingState = {
        pairingId: randomUUID(),
        code: randomBytes(16).toString('base64url'),
        expiresAt: Date.now() + pairing.ttlMs,
        hostPublicKey: identity.publicKey,
        lanUrl: lanAddress,
        attempts: 0,
        used: false,
      }
      invitations.set(invitation.pairingId, invitation)
      return publicInvitation(invitation)
    },
    revokeDevice(deviceId) {
      const revoked = options.trustStore.revoke(deviceId, new Date().toISOString())
      if (!revoked) return false
      authorizedSessions.delete(deviceId)
      for (const [id, challenge] of challenges) if (challenge.deviceId === deviceId) challenges.delete(id)
      for (const request of active) if (request.deviceId === deviceId) request.controller.abort(new Error('device revoked'))
      audit({ deviceId, operation: 'device.revoke', result: 'allowed' })
      return true
    },
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'POST' && request.url === '/dsh-remote-control/v1/pair') {
      await handlePair(request, response)
      return
    }
    if (request.method === 'POST' && request.url === '/dsh-remote-control/v1/challenge') {
      await handleChallenge(request, response)
      return
    }
    if (request.method === 'POST' && request.url === '/dsh-remote-control/v1/invoke') {
      await handleInvoke(request, response)
      return
    }
    writeJson(response, 404, { error: 'not-found' })
  }

  async function routeManagement(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isLoopbackAddress(request.socket.remoteAddress ?? '')) {
      writeJson(response, 403, { error: 'loopback-required' })
      return
    }
    if (request.method === 'POST' && request.url === '/dsh-remote-control/v1/management/pairing/open') {
      writeJson(response, 201, api.openPairing())
      return
    }
    if (request.method === 'GET' && request.url === '/dsh-remote-control/v1/management/devices') {
      writeJson(response, 200, { devices: options.trustStore.list().map(redactDevice) })
      return
    }
    if (request.method === 'POST' && request.url === '/dsh-remote-control/v1/management/devices/revoke') {
      const body = await readObject(request, response, limits.maxFrameBytes)
      if (body === undefined) return
      const deviceId = stringField(body, 'deviceId')
      if (deviceId === undefined) {
        writeJson(response, 400, { error: 'bad-request' })
        return
      }
      const revoked = api.revokeDevice(deviceId)
      writeJson(response, revoked ? 200 : 404, { revoked })
      return
    }
    writeJson(response, 404, { error: 'not-found' })
  }

  async function handlePair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parsed = await readObject(request, response, limits.maxFrameBytes)
    if (parsed === undefined) return
    const pairingId = stringField(parsed, 'pairingId')
    const code = stringField(parsed, 'code')
    const publicKey = stringField(parsed, 'publicKey')
    const friendlyName = stringField(parsed, 'friendlyName')
    const claimedDeviceId = stringField(parsed, 'deviceId')
    const invitation = pairingId === undefined ? undefined : invitations.get(pairingId)
    if (invitation === undefined || code === undefined || publicKey === undefined || friendlyName === undefined || claimedDeviceId === undefined) {
      writeJson(response, 401, { error: 'pairing-denied' })
      return
    }
    invitation.attempts += 1
    const codeMatches = safeEqual(invitation.code, code)
    const valid = !invitation.used && invitation.expiresAt >= Date.now()
      && invitation.attempts <= pairing.maxAttempts && codeMatches
    if (!valid) {
      audit({ operation: 'device.pair', result: 'denied', reason: 'invalid-pairing' })
      writeJson(response, 401, { error: 'pairing-denied' })
      return
    }
    const expectedDeviceId = deviceIdForPublicKey(publicKey)
    if (claimedDeviceId !== expectedDeviceId) {
      audit({ operation: 'device.pair', result: 'denied', reason: 'identity-mismatch' })
      writeJson(response, 401, { error: 'pairing-denied' })
      return
    }
    invitation.used = true
    invitations.delete(invitation.pairingId)
    const now = new Date().toISOString()
    const device: PairedDevice = {
      deviceId: claimedDeviceId,
      publicKey,
      friendlyName: friendlyName.slice(0, 80),
      capabilities: ['sessions.read'],
      pairedAt: now,
      lastSeenAt: null,
      revokedAt: null,
    }
    options.trustStore.put(device)
    audit({ deviceId: device.deviceId, operation: 'device.pair', result: 'allowed' })
    writeJson(response, 201, { deviceId: device.deviceId, hostPublicKey: identity.publicKey, capabilities: device.capabilities })
  }

  async function handleChallenge(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parsed = await readObject(request, response, limits.maxFrameBytes)
    if (parsed === undefined) return
    const deviceId = stringField(parsed, 'deviceId')
    const device = deviceId === undefined ? undefined : options.trustStore.get(deviceId)
    if (device === undefined || device.revokedAt !== null) {
      audit({ ...(deviceId === undefined ? {} : { deviceId }), operation: 'auth.challenge', result: 'denied', reason: 'unpaired' })
      writeJson(response, 401, { error: 'authentication-failed' })
      return
    }
    const challengeId = randomUUID()
    const state: ChallengeState = {
      deviceId: device.deviceId,
      challenge: randomBytes(32).toString('base64url'),
      expiresAt: Date.now() + Math.min(limits.requestTimeoutMs, 30_000),
    }
    challenges.set(challengeId, state)
    writeJson(response, 200, { version: PROTOCOL_VERSION, challengeId, challenge: state.challenge, expiresAt: state.expiresAt })
  }

  async function handleInvoke(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const raw = await readRaw(request, response, limits.maxFrameBytes)
    if (raw === undefined) return
    let parsed: Record<string, unknown>
    try {
      const value: unknown = JSON.parse(raw)
      if (!isObject(value)) throw new Error('object required')
      parsed = value
    } catch {
      writeJson(response, 400, { error: 'bad-request' })
      return
    }
    const deviceId = stringField(parsed, 'deviceId')
    const challengeId = stringField(parsed, 'challengeId')
    const signature = stringField(parsed, 'signature')
    const operation = stringField(parsed, 'operation') ?? 'unknown'
    const challenge = challengeId === undefined ? undefined : challenges.get(challengeId)
    if (challengeId !== undefined) challenges.delete(challengeId)
    const device = deviceId === undefined ? undefined : options.trustStore.get(deviceId)
    const transcript = challenge === undefined || challengeId === undefined
      ? ''
      : transcriptForInvoke(challengeId, challenge.challenge, deviceId ?? '', operation, parsed.payload)
    const authenticated = challenge !== undefined && challenge.expiresAt >= Date.now()
      && challenge.deviceId === deviceId && device !== undefined && device.revokedAt === null
      && signature !== undefined && verifyTranscript(device.publicKey, transcript, signature)
    if (!authenticated) {
      audit({ ...(deviceId === undefined ? {} : { deviceId }), operation, result: 'denied', reason: 'authentication-failed' })
      writeJson(response, 401, { error: 'authentication-failed' })
      return
    }
    if (!device.capabilities.includes('sessions.read')) {
      audit({ deviceId, operation, result: 'denied', reason: 'capability-denied' })
      writeJson(response, 403, { error: 'capability-denied' })
      return
    }
    if (operation !== 'session.list' && operation !== 'session.history') {
      audit({ deviceId, operation, result: 'denied', reason: 'operation-denied' })
      writeJson(response, 403, { error: 'operation-denied' })
      return
    }
    const controller = new AbortController()
    let settle!: () => void
    const settlement = new Promise<void>(resolve => { settle = resolve })
    activeSettlements.add(settlement)
    const activeRequest = { deviceId: device.deviceId, controller }
    active.add(activeRequest)
    request.once('aborted', () => controller.abort(new Error('request aborted')))
    response.once('close', () => {
      if (!response.writableFinished) controller.abort(new Error('response closed'))
    })
    const timer = setTimeout(() => controller.abort(new Error('request timeout')), limits.requestTimeoutMs)
    try {
      if (operation === 'session.list') {
        const result = await options.adapter.list({ signal: controller.signal })
        authorizedSessions.set(device.deviceId, new Set(result.items.map(item => item.sessionId)))
        audit({ deviceId, operation, result: 'allowed' })
        writeJson(response, 200, result)
        return
      }
      const payload = isObject(parsed.payload) ? parsed.payload : {}
      const sessionId = stringField(payload, 'sessionId')
      if (sessionId === undefined || !authorizedSessions.get(device.deviceId)?.has(sessionId)) {
        audit({ deviceId, operation, result: 'denied', reason: 'session-denied' })
        writeJson(response, 403, { error: 'session-denied' })
        return
      }
      const beforeSeq = optionalNatural(payload.beforeSeq)
      const maxMessages = optionalNatural(payload.maxMessages)
      if (beforeSeq === false || maxMessages === false) {
        writeJson(response, 400, { error: 'bad-request' })
        return
      }
      const result = await options.adapter.history({
        sessionId,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        ...(maxMessages === undefined ? {} : { maxMessages }),
      }, { signal: controller.signal })
      audit({ deviceId, operation, result: 'allowed' })
      writeJson(response, 200, result)
    } catch (error) {
      if (controller.signal.aborted) {
        if (!response.headersSent) writeJson(response, 499, { error: 'cancelled' })
        return
      }
      throw error
    } finally {
      clearTimeout(timer)
      active.delete(activeRequest)
      activeSettlements.delete(settlement)
      settle()
    }
  }

  return api
}

export function transcriptForInvoke(
  challengeId: string,
  challenge: string,
  deviceId: string,
  operation: string,
  payload: unknown,
): string {
  return JSON.stringify({ version: PROTOCOL_VERSION, challengeId, challenge, deviceId, operation, payload })
}

async function readObject(request: IncomingMessage, response: ServerResponse, maxBytes: number): Promise<Record<string, unknown> | undefined> {
  const raw = await readRaw(request, response, maxBytes)
  if (raw === undefined) return undefined
  try {
    const value: unknown = JSON.parse(raw)
    if (!isObject(value)) throw new Error('object required')
    return value
  } catch {
    writeJson(response, 400, { error: 'bad-request' })
    return undefined
  }
}

async function readRaw(request: IncomingMessage, response: ServerResponse, maxBytes: number): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array)
    bytes += buffer.length
    if (bytes > maxBytes) {
      writeJson(response, 413, { error: 'frame-too-large' })
      request.destroy()
      return undefined
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

function publicInvitation(invitation: PairingState): PairingInvitation {
  return {
    pairingId: invitation.pairingId,
    code: invitation.code,
    expiresAt: invitation.expiresAt,
    hostPublicKey: invitation.hostPublicKey,
    lanUrl: invitation.lanUrl,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  return typeof value[field] === 'string' ? value[field] : undefined
}

function optionalNatural(value: unknown): number | undefined | false {
  if (value === undefined) return undefined
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : false
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function isLoopbackAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function redactDevice(device: PairedDevice): Omit<PairedDevice, 'publicKey'> & { publicKeyFingerprint: string } {
  return {
    deviceId: device.deviceId,
    friendlyName: device.friendlyName,
    capabilities: [...device.capabilities],
    pairedAt: device.pairedAt,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt,
    publicKeyFingerprint: device.deviceId,
  }
}
