import type { DeviceIdentity, PairingInvitation } from './types.ts'
import { signTranscript } from './identity.ts'
import { transcriptForInvoke } from './server.ts'

export interface RemoteControlClientOptions {
  baseUrl: string
  identity: DeviceIdentity
  hostPublicKey?: string
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
      if (invitation.hostPublicKey !== options.hostPublicKey && options.hostPublicKey !== undefined) {
        throw new Error('dsh-remote-control: host identity mismatch')
      }
      const response = await request(new URL('/dsh-remote-control/v1/pair', invitation.lanUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          pairingId: invitation.pairingId,
          code: invitation.code,
          deviceId: options.identity.deviceId,
          publicKey: options.identity.publicKey,
          friendlyName,
        }),
      })
      await readResponse(response)
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
      const challenge = await readResponse(challengeResponse) as { challengeId: string; challenge: string }
      const unsigned = { deviceId: options.identity.deviceId, challengeId: challenge.challengeId, operation, payload }
      const transcript = transcriptForInvoke(
        challenge.challengeId,
        challenge.challenge,
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
      return readResponse(response)
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

async function readResponse(response: Response): Promise<unknown> {
  const body: unknown = await response.json()
  if (!response.ok) {
    const code = typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : `HTTP ${response.status}`
    throw new Error(`dsh-remote-control: ${code}`)
  }
  return body
}

function combineSignals(first: AbortSignal, second?: AbortSignal): AbortSignal {
  return second === undefined ? first : AbortSignal.any([first, second])
}
