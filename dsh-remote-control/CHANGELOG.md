# Changelog

## 0.1.0 - 2026-08-14

- Add a disabled-by-default, independent LAN listener for signed `session.list` and `session.history` requests.
- Add loopback-only pairing/device management, code-bound Ed25519 device-key proof, host-signed protocol responses, single-use challenges, replay rejection, and immediate revocation.
- Add persistent host identity/trust state, bounded frames/challenges and timeouts, fail-closed cancellation, and redacted callback audit records.
- Add unit, real Loader composition, and loopback two-device end-to-end coverage plus an explicit-IP smoke procedure.
