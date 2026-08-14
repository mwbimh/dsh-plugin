import { createHmac } from 'node:crypto'
import type { PairingInvitation } from './types.ts'

export const PROTOCOL_VERSION = 2
export const HOST_SIGNATURE_HEADER = 'x-dsh-remote-host-signature'

/** Authenticate the host-created invitation received over the trusted pairing channel. */
export function transcriptForInvitation(invitation: PairingInvitation): string {
  return JSON.stringify({
    version: PROTOCOL_VERSION,
    purpose: 'pairing.invitation',
    pairingId: invitation.pairingId,
    code: invitation.code,
    expiresAt: invitation.expiresAt,
    hostPublicKey: invitation.hostPublicKey,
    lanUrl: invitation.lanUrl,
  })
}

/** Derive a non-reusable code proof bound to one device public key. */
export function derivePairingChallenge(
  invitation: PairingInvitation,
  deviceId: string,
  publicKey: string,
): string {
  const context = JSON.stringify({
    version: PROTOCOL_VERSION,
    purpose: 'pairing.code-challenge',
    pairingId: invitation.pairingId,
    expiresAt: invitation.expiresAt,
    hostPublicKey: invitation.hostPublicKey,
    lanUrl: invitation.lanUrl,
    deviceId,
    publicKey,
  })
  return createHmac('sha256', invitation.code).update(context).digest('base64url')
}

/** Prove device-key possession while binding every pairing identity field. */
export function transcriptForPairingRequest(
  invitation: PairingInvitation,
  pairingChallenge: string,
  deviceId: string,
  publicKey: string,
  friendlyName: string,
): string {
  return JSON.stringify({
    version: PROTOCOL_VERSION,
    purpose: 'pairing.request',
    pairingId: invitation.pairingId,
    pairingChallenge,
    expiresAt: invitation.expiresAt,
    hostPublicKey: invitation.hostPublicKey,
    lanUrl: invitation.lanUrl,
    deviceId,
    publicKey,
    friendlyName,
  })
}

/** Authenticate a host pairing response and bind it to the submitted key. */
export function transcriptForPairingResponse(
  pairingId: string,
  hostPublicKey: string,
  deviceId: string,
  publicKey: string,
  status: number,
  body: unknown,
): string {
  return JSON.stringify({
    version: PROTOCOL_VERSION,
    purpose: 'pairing.response',
    pairingId,
    hostPublicKey,
    deviceId,
    publicKey,
    status,
    body,
  })
}

/** Authenticate a host challenge response before the device signs it. */
export function transcriptForChallengeResponse(
  hostPublicKey: string,
  deviceId: string,
  status: number,
  body: unknown,
): string {
  return JSON.stringify({
    version: PROTOCOL_VERSION,
    purpose: 'challenge.response',
    hostPublicKey,
    deviceId,
    status,
    body,
  })
}

/** Device-signed, single-use invocation transcript. */
export function transcriptForInvoke(
  challengeId: string,
  challenge: string,
  hostPublicKey: string,
  deviceId: string,
  operation: string,
  payload: unknown,
): string {
  return JSON.stringify({
    version: PROTOCOL_VERSION,
    purpose: 'invoke.request',
    challengeId,
    challenge,
    hostPublicKey,
    deviceId,
    operation,
    payload,
  })
}

/** Authenticate a host invocation response and prevent cross-request replay. */
export function transcriptForInvokeResponse(
  challengeId: string,
  hostPublicKey: string,
  deviceId: string,
  operation: string,
  status: number,
  body: unknown,
): string {
  return JSON.stringify({
    version: PROTOCOL_VERSION,
    purpose: 'invoke.response',
    challengeId,
    hostPublicKey,
    deviceId,
    operation,
    status,
    body,
  })
}
