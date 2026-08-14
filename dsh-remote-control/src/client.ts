import type { DeviceIdentity, PairingInvitation } from './types.ts'
import { signTranscript, verifyTranscript } from './identity.ts'
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

export interface RemoteControlClientOptions {
  baseUrl: string
  identity: DeviceIdentity
  hostPublicKey: string
  fetch?: typeof fetch
}

export interface RemoteControlClient {
  pair(invitation: PairingInvitation, friendlyName: string): Promise<void>
  list(options?: { signal?: AbortSignal }): Promise<unknown>
  history(request: { sessionId: string; beforeSeq?: number; maxMessages?: number }, options?: { signal?: AbortSignal }): Promise<unknown>
  invoke(operation: string, payload: unknown, options?: { signal?: AbortSignal }): Promise<unknown>
  dispose(): void
}

/** Create a client that proves possession of its device key on every request. */
export function createRemoteControlClient(options: RemoteControlClientOptions): RemoteControlClient {
  const request = options.fetch ?? fetch
  const controller = new AbortController()
  let disposed = false

  const client: RemoteControlClient = {
    async pair(invitation, friendlyName) {
      assertActive()
      if (invitation.hostPublicKey !== options.hostPublicKey) {
        throw new Error('dsh-remote-control: host identity mismatch')
      }
      if (invitation.version !== PROTOCOL_VERSION
        || !verifyTranscript(options.hostPublicKey, transcriptForInvitation(invitation), invitation.hostSignature)) {
        throw new Error('dsh-remote-control: host authentication failed')
      }
      const pairingChallenge = derivePairingChallenge(invitation, options.identity.deviceId, options.identity.publicKey)
      const signature = signTranscript(options.identity.privateKey, transcriptForPairingRequest(
        invitation,
        pairingChallenge,
        options.identity.deviceId,
        options.identity.publicKey,
        friendlyName,
      ))
      const response = await request(new URL('/dsh-remote-control/v1/pair', invitation.lanUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          pairingId: invitation.pairingId,
          pairingChallenge,
          deviceId: options.identity.deviceId,
          publicKey: options.identity.publicKey,
          friendlyName,
          signature,
        }),
      })
      await readHostResponse(response, options.hostPublicKey, (status, body) => transcriptForPairingResponse(
        invitation.pairingId,
        options.hostPublicKey,
        options.identity.deviceId,
        options.identity.publicKey,
        status,
        body,
      ))
    },
    list(requestOptions) {
      return client.invoke('session.list', {}, requestOptions)
    },
    history(historyRequest, requestOptions) {
      return client.invoke('session.history', historyRequest, requestOptions)
    },
    async invoke(operation, payload, requestOptions) {
      assertActive()
      const signal = combineSignals(controller.signal, requestOptions?.signal)
      const challengeResponse = await request(new URL('/dsh-remote-control/v1/challenge', options.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({ deviceId: options.identity.deviceId }),
      })
      const challenge = await readHostResponse(
        challengeResponse,
        options.hostPublicKey,
        (status, body) => transcriptForChallengeResponse(
          options.hostPublicKey,
          options.identity.deviceId,
          status,
          body,
        ),
      ) as { version: number; hostPublicKey: string; challengeId: string; challenge: string }
      if (challenge.version !== PROTOCOL_VERSION || challenge.hostPublicKey !== options.hostPublicKey) {
        throw new Error('dsh-remote-control: host authentication failed')
      }
      const unsigned = { deviceId: options.identity.deviceId, challengeId: challenge.challengeId, operation, payload }
      const transcript = transcriptForInvoke(
        challenge.challengeId,
        challenge.challenge,
        options.hostPublicKey,
        options.identity.deviceId,
        operation,
        payload,
      )
      const response = await request(new URL('/dsh-remote-control/v1/invoke', options.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({ ...unsigned, signature: signTranscript(options.identity.privateKey, transcript) }),
      })
      return readHostResponse(response, options.hostPublicKey, (status, body) => transcriptForInvokeResponse(
        challenge.challengeId,
        options.hostPublicKey,
        options.identity.deviceId,
        operation,
        status,
        body,
      ))
    },
    dispose() {
      if (disposed) return
      disposed = true
      controller.abort(new Error('client disposed'))
    },
  }

  function assertActive(): void {
    if (disposed) throw new Error('dsh-remote-control: client is disposed')
  }

  return client
}

async function readHostResponse(
  response: Response,
  hostPublicKey: string,
  transcript: (status: number, body: unknown) => string,
): Promise<unknown> {
  const body: unknown = await response.json()
  const signature = response.headers.get(HOST_SIGNATURE_HEADER)
  if (signature === null || !verifyTranscript(hostPublicKey, transcript(response.status, body), signature)) {
    throw new Error('dsh-remote-control: host authentication failed')
  }
  if (!response.ok) {
    const code = typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : `HTTP ${response.status}`
    throw new Error(`dsh-remote-control: ${code}`)
  }
  return body
}

function combineSignals(first: AbortSignal, second?: AbortSignal): AbortSignal {
  return second === undefined ? first : AbortSignal.any([first, second])
}
