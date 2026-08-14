import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { isIP, SocketAddress } from 'node:net'
import { deviceIdForPublicKey, generateDeviceIdentity, signTranscript, verifyTranscript } from './identity.ts'
import {
  derivePairingChallenge,
  HOST_SIGNATURE_HEADER,
  PROTOCOL_VERSION,
  transcriptForChallengeResponse,
  transcriptForInvitation,
  transcriptForInvoke,
  transcriptForInvokeResponse,
  transcriptForPairingRequest,
  transcriptForPairingResponse,
} from './protocol.ts'
import type {
  AuditEvent,
  DeviceIdentity,
  PairingInvitation,
  PairedDevice,
  SessionsReadAdapter,
  TrustStore,
} from './types.ts'

export interface RemoteControlServerOptions {
  enabled: boolean
  listen: { lan: boolean; address: string; port: number }
  management?: { address: string; port: number }
  pairing?: { ttlMs: number; maxAttempts: number }
  challenges?: { ttlMs: number; maxOutstanding: number; maxPerDevice: number }
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
  const challengeLimits = options.challenges ?? { ttlMs: 30_000, maxOutstanding: 256, maxPerDevice: 8 }
  assertChallengeLimit(challengeLimits.ttlMs)
  assertChallengeLimit(challengeLimits.maxOutstanding)
  assertChallengeLimit(challengeLimits.maxPerDevice)
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

  const audit = (event: Omit<AuditEvent, 'at'>): void => {
    if (options.audit === undefined) return
    const { deviceId, ...redacted } = event
    options.audit({
      at: new Date().toISOString(),
      ...(deviceId !== undefined && isCanonicalDeviceId(deviceId) ? { deviceId } : {}),
      ...redacted,
    })
  }
  const pruneExpiredChallenges = (now: number): void => {
    for (const [challengeId, challenge] of challenges) {
      if (challenge.expiresAt < now) challenges.delete(challengeId)
    }
  }

  const api: RemoteControlServer = {
    get addresses() {
      return { lan: lanAddress, management: managementAddress }
    },
    async start() {
      if (!options.enabled || !options.listen.lan || server !== undefined || managementServer !== undefined) return
      const lanHost = normalizeIpAddress(options.listen.address)
      if (isUnspecifiedAddress(lanHost)) {
        throw new Error('dsh-remote-control: LAN listener requires an explicit interface address')
      }
      const managementHost = options.management === undefined
        ? undefined
        : normalizeIpAddress(options.management.address)
      if (managementHost !== undefined && !isLoopbackAddress(managementHost)) {
        throw new Error('dsh-remote-control: management listener must bind loopback')
      }
      try {
        if (options.management !== undefined && managementHost !== undefined) {
          managementServer = createServer((request, response) => {
            void routeManagement(request, response).catch((error: unknown) => {
              if (!response.headersSent) writeJson(response, 500, { error: 'internal' })
              else response.destroy(error instanceof Error ? error : undefined)
            })
          })
          managementServer.headersTimeout = limits.headersTimeoutMs
          managementServer.requestTimeout = limits.requestTimeoutMs
          managementServer.listen(options.management.port, managementHost)
          await once(managementServer, 'listening')
          const bound = managementServer.address()
          if (bound === null || typeof bound === 'string') throw new Error('dsh-remote-control: management address unavailable')
          const boundManagementHost = normalizeIpAddress(bound.address)
          if (!isLoopbackAddress(boundManagementHost)) throw new Error('dsh-remote-control: management listener must bind loopback')
          managementAddress = `http://${formatHost(boundManagementHost)}:${bound.port}`
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
        server.listen(options.listen.port, lanHost)
        await once(server, 'listening')
        const address = server.address()
        if (address === null || typeof address === 'string') throw new Error('dsh-remote-control: TCP address unavailable')
        const boundLanHost = normalizeIpAddress(address.address)
        if (isUnspecifiedAddress(boundLanHost)) {
          throw new Error('dsh-remote-control: LAN listener requires an explicit interface address')
        }
        lanAddress = `http://${formatHost(boundLanHost)}:${address.port}`
      } catch (error) {
        await api.dispose()
        throw error
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
        version: PROTOCOL_VERSION,
        pairingId: randomUUID(),
        code: randomBytes(16).toString('base64url'),
        expiresAt: Date.now() + pairing.ttlMs,
        hostPublicKey: identity.publicKey,
        lanUrl: lanAddress,
        hostSignature: '',
        attempts: 0,
        used: false,
      }
      invitation.hostSignature = signTranscript(identity.privateKey, transcriptForInvitation(invitation))
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
    const pairingChallenge = stringField(parsed, 'pairingChallenge')
    const publicKey = stringField(parsed, 'publicKey')
    const friendlyName = stringField(parsed, 'friendlyName')
    const claimedDeviceId = stringField(parsed, 'deviceId')
    const signature = stringField(parsed, 'signature')
    const respond = (status: number, body: unknown): void => writeSignedJson(
      response,
      status,
      body,
      transcriptForPairingResponse(
        pairingId ?? '',
        identity.publicKey,
        claimedDeviceId ?? '',
        publicKey ?? '',
        status,
        body,
      ),
      identity.privateKey,
    )
    const invitation = pairingId === undefined ? undefined : invitations.get(pairingId)
    if (invitation === undefined || pairingChallenge === undefined || publicKey === undefined
      || friendlyName === undefined || claimedDeviceId === undefined || signature === undefined) {
      respond(401, { error: 'pairing-denied' })
      return
    }
    invitation.attempts += 1
    const valid = !invitation.used && invitation.expiresAt >= Date.now()
      && invitation.attempts <= pairing.maxAttempts
    if (!valid) {
      audit({ operation: 'device.pair', result: 'denied', reason: 'invalid-pairing' })
      respond(401, { error: 'pairing-denied' })
      return
    }
    const expectedDeviceId = deviceIdForPublicKey(publicKey)
    if (claimedDeviceId !== expectedDeviceId) {
      audit({ operation: 'device.pair', result: 'denied', reason: 'identity-mismatch' })
      respond(401, { error: 'pairing-denied' })
      return
    }
    const publicInvite = publicInvitation(invitation)
    const expectedChallenge = derivePairingChallenge(publicInvite, claimedDeviceId, publicKey)
    const proofValid = safeEqual(expectedChallenge, pairingChallenge)
      && verifyTranscript(publicKey, transcriptForPairingRequest(
        publicInvite,
        pairingChallenge,
        claimedDeviceId,
        publicKey,
        friendlyName,
      ), signature)
    if (!proofValid) {
      audit({ operation: 'device.pair', result: 'denied', reason: 'key-proof-failed' })
      respond(401, { error: 'pairing-denied' })
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
    respond(201, { deviceId: device.deviceId, hostPublicKey: identity.publicKey, capabilities: device.capabilities })
  }

  async function handleChallenge(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parsed = await readObject(request, response, limits.maxFrameBytes)
    if (parsed === undefined) return
    const deviceId = stringField(parsed, 'deviceId')
    const respond = (status: number, body: unknown): void => writeSignedJson(
      response,
      status,
      body,
      transcriptForChallengeResponse(identity.publicKey, deviceId ?? '', status, body),
      identity.privateKey,
    )
    const device = deviceId === undefined ? undefined : options.trustStore.get(deviceId)
    if (device === undefined || device.revokedAt !== null) {
      audit({ operation: 'auth.challenge', result: 'denied', reason: 'unpaired' })
      respond(401, { error: 'authentication-failed' })
      return
    }
    pruneExpiredChallenges(Date.now())
    const deviceChallengeCount = [...challenges.values()].filter(item => item.deviceId === device.deviceId).length
    if (challenges.size >= challengeLimits.maxOutstanding || deviceChallengeCount >= challengeLimits.maxPerDevice) {
      audit({ deviceId: device.deviceId, operation: 'auth.challenge', result: 'denied', reason: 'challenge-limit' })
      respond(429, { error: 'challenge-limit' })
      return
    }
    const challengeId = randomUUID()
    const state: ChallengeState = {
      deviceId: device.deviceId,
      challenge: randomBytes(32).toString('base64url'),
      expiresAt: Date.now() + challengeLimits.ttlMs,
    }
    challenges.set(challengeId, state)
    respond(200, {
      version: PROTOCOL_VERSION,
      hostPublicKey: identity.publicKey,
      challengeId,
      challenge: state.challenge,
      expiresAt: state.expiresAt,
    })
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
    const auditedOperation = operation === 'session.list' || operation === 'session.history' ? operation : 'unknown'
    const respond = (status: number, body: unknown): void => writeSignedJson(
      response,
      status,
      body,
      transcriptForInvokeResponse(
        challengeId ?? '',
        identity.publicKey,
        deviceId ?? '',
        operation,
        status,
        body,
      ),
      identity.privateKey,
    )
    const challenge = challengeId === undefined ? undefined : challenges.get(challengeId)
    if (challengeId !== undefined) challenges.delete(challengeId)
    const device = deviceId === undefined ? undefined : options.trustStore.get(deviceId)
    const transcript = challenge === undefined || challengeId === undefined
      ? ''
      : transcriptForInvoke(challengeId, challenge.challenge, identity.publicKey, deviceId ?? '', operation, parsed.payload)
    const authenticated = challenge !== undefined && challenge.expiresAt >= Date.now()
      && challenge.deviceId === deviceId && device !== undefined && device.revokedAt === null
      && signature !== undefined && verifyTranscript(device.publicKey, transcript, signature)
    if (!authenticated) {
      audit({ operation: auditedOperation, result: 'denied', reason: 'authentication-failed' })
      respond(401, { error: 'authentication-failed' })
      return
    }
    if (!device.capabilities.includes('sessions.read')) {
      audit({ deviceId, operation: auditedOperation, result: 'denied', reason: 'capability-denied' })
      respond(403, { error: 'capability-denied' })
      return
    }
    if (operation !== 'session.list' && operation !== 'session.history') {
      audit({ deviceId, operation: auditedOperation, result: 'denied', reason: 'operation-denied' })
      respond(403, { error: 'operation-denied' })
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
        const result = await awaitAbortable(options.adapter.list({ signal: controller.signal }), controller.signal)
        controller.signal.throwIfAborted()
        authorizedSessions.set(device.deviceId, new Set(result.items.map(item => item.sessionId)))
        controller.signal.throwIfAborted()
        audit({ deviceId, operation, result: 'allowed' })
        controller.signal.throwIfAborted()
        respond(200, result)
        return
      }
      const payload = isObject(parsed.payload) ? parsed.payload : {}
      const sessionId = stringField(payload, 'sessionId')
      if (sessionId === undefined || !authorizedSessions.get(device.deviceId)?.has(sessionId)) {
        audit({ deviceId, operation, result: 'denied', reason: 'session-denied' })
        respond(403, { error: 'session-denied' })
        return
      }
      const beforeSeq = optionalNatural(payload.beforeSeq)
      const maxMessages = optionalNatural(payload.maxMessages)
      if (beforeSeq === false || maxMessages === false) {
        respond(400, { error: 'bad-request' })
        return
      }
      const result = await awaitAbortable(options.adapter.history({
        sessionId,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        ...(maxMessages === undefined ? {} : { maxMessages }),
      }, { signal: controller.signal }), controller.signal)
      controller.signal.throwIfAborted()
      audit({ deviceId, operation, result: 'allowed' })
      controller.signal.throwIfAborted()
      respond(200, result)
    } catch (error) {
      if (controller.signal.aborted) {
        if (!response.headersSent) respond(499, { error: 'cancelled' })
        return
      }
      if (!response.headersSent) respond(500, { error: 'internal' })
      else response.destroy(error instanceof Error ? error : undefined)
    } finally {
      clearTimeout(timer)
      active.delete(activeRequest)
      activeSettlements.delete(settlement)
      settle()
    }
  }

  return api
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

function writeSignedJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  transcript: string,
  privateKey: string,
): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    [HOST_SIGNATURE_HEADER]: signTranscript(privateKey, transcript),
  })
  response.end(JSON.stringify(body))
}

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

function publicInvitation(invitation: PairingState): PairingInvitation {
  return {
    version: invitation.version,
    pairingId: invitation.pairingId,
    code: invitation.code,
    expiresAt: invitation.expiresAt,
    hostPublicKey: invitation.hostPublicKey,
    lanUrl: invitation.lanUrl,
    hostSignature: invitation.hostSignature,
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

function isCanonicalDeviceId(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/u.test(value)
}

function assertChallengeLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('dsh-remote-control: challenge limits must be finite positive integers')
  }
}

function normalizeIpAddress(address: string): string {
  if (address.includes('%')) throw new Error('dsh-remote-control: listener requires an explicit IP address without a scope zone')
  const version = isIP(address)
  if (version === 0) throw new Error('dsh-remote-control: listener requires an explicit IP address')
  return new SocketAddress({
    address,
    port: 0,
    family: version === 4 ? 'ipv4' : 'ipv6',
  }).address
}

function isUnspecifiedAddress(address: string): boolean {
  return address === '0.0.0.0' || address === '::' || address === '::ffff:0.0.0.0'
}

async function awaitAbortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
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
