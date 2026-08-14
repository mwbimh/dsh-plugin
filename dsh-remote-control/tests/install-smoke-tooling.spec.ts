import { describe, expect, it } from 'vitest'
import {
  artifactFilename,
  assessCliCapabilities,
  buildProfilePatch,
} from '../scripts/install-smoke.mjs'

describe('install smoke tooling', () => {
  it('requires the profile-aware plugin and config-dump grammar', () => {
    const supported = assessCliCapabilities(
      'dsh plugin --profile tui add <package>\n--dump-config',
      'Usage: dsh plugin --profile <name> [args...]',
    )
    expect(supported).toEqual([])

    expect(assessCliCapabilities('dsh plugin add <package>', 'Usage: dsh plugin [args...]'))
      .toEqual(['--dump-config', 'plugin --profile'])
  })

  it('derives the packed filename without hard-coding the package version', () => {
    expect(artifactFilename('@deepseek-ai/dsh-remote-control', '0.1.0'))
      .toBe('deepseek-ai-dsh-remote-control-0.1.0.tgz')
  })

  it('writes a complete opt-in profile override with isolated state', () => {
    expect(buildProfilePatch({ lanPort: 43101, managementPort: 43102, statePath: 'C:/tmp/smoke/state.json' }))
      .toBe([
        '- id: dsh-remote-control.gateway',
        '  config:',
        '    enabled: true',
        '    lan: true',
        "    address: '127.0.0.1'",
        '    port: 43101',
        '    managementPort: 43102',
        "    statePath: 'C:/tmp/smoke/state.json'",
        '',
      ].join('\n'))
  })
})
