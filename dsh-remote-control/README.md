# @deepseek-ai/dsh-remote-control

Experimental, read-only remote access to a local DeepSeek Harness instance.

> **Development and trusted-test networks only. This phase uses signed plain HTTP and is not a secure production LAN transport.** LAN observers can read session responses. Do not expose it through wildcard binding, port forwarding, public DNS, a public reverse proxy, or an untrusted network. Use a separately authenticated encrypted tunnel when confidentiality is required.

The current package is deliberately small. It pairs a device with a pinned Ed25519 public key, authorizes only the `sessions.read` capability, and exposes only session listing and history reads through a DSH public-service adapter. The library can emit redacted allow/deny audit events only through the `audit` callback passed to `createRemoteControlServer`; the Cordis install entry does not connect that callback to an audit sink, so installing or activating the bundle does not persist audit records. Pairing is opened on a separate loopback-only management listener. The LAN listener has no route to DSH's existing anonymous `/api`. It does not provide remote prompts, tool execution, approvals, file access, terminal access, settings changes, event streaming, discovery, relay, or Internet exposure.

The Cordis patch ships disabled by default. The plugin uses named exports only; there is no default export.

The first phase uses a signed host invitation, a code-derived device-key proof during pairing, host-signed pairing/challenge/invocation responses, and a single-use device signature for each invocation. It does not provide transport confidentiality. The warning above is a deployment restriction, not a production-hardening recommendation.

## Requirements

- Node.js `^22.19 || >=24`
- pnpm `11.7.0`
- DSH `0.0.1-rc.5` API baseline

The runtime Cordis peer is pinned to `@deepseek-ai/cordis@4.0.1`. The implementation targets the reviewed DSH rc.5 `apiProxy.sessions.list/history` public service surface through structural injection; it does not import or bundle a concrete DSH provider. Loader tests compose a fake `apiProxy` service because the reviewed rc.5 DSH packages are not yet available as one installable npm dependency closure.

## Development

```sh
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
pnpm run check
pnpm run pack:check
```

`pnpm run install:smoke` builds, tests, packs, and then uses a real `dsh` CLI from `PATH` inside a fresh temporary `DSH_HOME`. It installs the tarball into the isolated `web` profile, dumps the disabled and enabled configurations, starts the profile on loopback, pairs a device, exercises list and history authorization, lists and revokes the device, uninstalls the package, and removes the temporary home. It never selects or writes a user profile. If no compatible CLI is available, the command prints an explicit `SKIP`; set `DSH_INSTALL_SMOKE_REQUIRED=1` to turn that condition into a failure, or set `DSH_INSTALL_SMOKE_COMMAND` to the path of a compatible executable. This source checkout is intended for local development; consumers should install the published package or a verified tarball, not rely on a GitHub-source install hook.

## Explicit-IP manual smoke test

This listener is an opt-in security boundary. Keep `enabled: false` until a trusted LAN smoke test is ready. Never bind to `0.0.0.0`, `::`, or an interface inferred from the host. Choose the exact private address assigned to the intended network interface, for example `192.168.1.23`.

1. Install the packed plugin into a disposable DSH profile.
2. Override `dsh-remote-control.gateway` with explicit ports, the intended interface, and a private state path:

```yaml
config:
  enabled: true
  lan: true
  address: 192.168.1.23
  port: 43721
  managementPort: 43722
  statePath: C:/Users/example/AppData/Local/dsh-remote-control/state.json
```

3. Start DSH. Confirm the LAN socket is exactly `192.168.1.23:43721`, the management socket is exactly `127.0.0.1:43722`, and DSH's existing `/api` port did not change.
4. On the host, open one short-lived invitation and transfer the JSON through a separate trusted channel:

```sh
curl -fsS -X POST http://127.0.0.1:43722/dsh-remote-control/v1/management/pairing/open > invitation.json
```

5. On the second device, install the same verified tarball and run the package client. Replace `session-id-from-list` after inspecting the list result:

```js
import { readFile } from 'node:fs/promises'
import { createRemoteControlClient, generateDeviceIdentity } from '@deepseek-ai/dsh-remote-control'

const invitation = JSON.parse(await readFile('invitation.json', 'utf8'))
const identity = generateDeviceIdentity()
const client = createRemoteControlClient({ baseUrl: invitation.lanUrl, identity, hostPublicKey: invitation.hostPublicKey })
await client.pair(invitation, 'manual-smoke-device')
console.log(await client.list())
console.log(await client.history({ sessionId: 'session-id-from-list' }))
client.dispose()
```

6. On the host, list and revoke the device. Its next request must fail before the DSH adapter:

```sh
curl -fsS http://127.0.0.1:43722/dsh-remote-control/v1/management/devices
curl -fsS -X POST -H 'content-type: application/json' --data '{"deviceId":"device-id-from-list"}' http://127.0.0.1:43722/dsh-remote-control/v1/management/devices/revoke
```

7. Verify history succeeds only for an id obtained from that device's latest successful list. A request before list, or for another id, must fail.
8. Verify an unpaired device, a revoked device, a replayed request, and every capability other than `sessions.read` are denied.
9. If the library host supplied an `audit` callback, confirm its output contains operation/result metadata but no message bodies, signatures, private keys, pairing codes, or authorization headers. The Cordis entry does not supply or persist this output.
10. Set `enabled: false`, stop DSH, and remove the disposable profile after the smoke test. Keep the state file private; it contains the host private key.

The package does not configure a firewall, TLS terminator, VPN, NAT rule, router port-forward, or public DNS. Those are outside its current scope.
