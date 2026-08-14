import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto'
import type { DeviceIdentity } from './types.ts'

/** Generate a long-lived Ed25519 identity whose id is derived from its public key. */
export function generateDeviceIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  return {
    deviceId: deviceIdForPublicKey(publicKeyPem),
    publicKey: publicKeyPem,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

/** Derive the stable device id used to index a pinned public key. */
export function deviceIdForPublicKey(publicKey: string): string {
  return createHash('sha256').update(publicKey).digest('base64url')
}

/** Sign one protocol transcript with a device private key. */
export function signTranscript(privateKey: string, transcript: string): string {
  return cryptoSign(null, Buffer.from(transcript), privateKey).toString('base64url')
}

/** Verify one protocol transcript against a pinned device public key. */
export function verifyTranscript(publicKey: string, transcript: string, signature: string): boolean {
  try {
    return cryptoVerify(null, Buffer.from(transcript), publicKey, Buffer.from(signature, 'base64url'))
  } catch {
    return false
  }
}
