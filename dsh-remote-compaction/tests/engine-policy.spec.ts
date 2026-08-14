import { describe, expect, it, vi } from 'vitest'
import { RemoteCompactionError } from '../src/errors.ts'
import {
  decideRemoteOutcome,
  resolveConversationTarget,
  resolveRemoteTarget,
} from '../src/policy.ts'

describe('remote engine policy', () => {
  it('prefers the latest durable route, then agent options, then configured target', () => {
    expect(resolveConversationTarget(
      { provider: 'openai', model: 'configured' },
      { provider: 'openai', model: 'durable' },
      { provider: 'openai', model: 'agent' },
    )).toEqual({ provider: 'openai', model: 'durable' })
    expect(resolveConversationTarget(
      { provider: 'openai', model: 'configured' },
      undefined,
      { provider: 'openai', model: 'agent' },
    )).toEqual({ provider: 'openai', model: 'agent' })
    expect(resolveConversationTarget(
      { provider: 'openai', model: 'configured' }, undefined, undefined,
    )).toEqual({ provider: 'openai', model: 'configured' })
    expect(resolveConversationTarget(
      { provider: 'openai', model: 'configured' },
      { provider: '', model: 'durable' },
      { provider: 'openai', model: '' },
    )).toEqual({ provider: 'openai', model: 'configured' })
  })

  it('resolves only the configured OpenAI provider and exact endpoint identity', () => {
    expect(resolveRemoteTarget({
      provider: 'openai', model: 'gpt-test', baseURL: 'https://api.example/v1/',
    })).toEqual({
      provider: 'openai', model: 'gpt-test', baseURL: 'https://api.example/v1',
      cacheKey: 'openai\ngpt-test\nhttps://api.example/v1',
    })
    expect(() => resolveRemoteTarget({
      provider: 'claude', model: 'model', baseURL: 'https://api.example/v1',
    })).toThrowError(expect.objectContaining({ code: 'unsupported' }))
    expect(() => resolveRemoteTarget({
      provider: 'openai', model: '', baseURL: 'https://api.example/v1',
    })).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    expect(() => resolveRemoteTarget({
      provider: 'openai', model: 'model', baseURL: 'not a URL',
    })).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    expect(() => resolveRemoteTarget({
      provider: 'openai', model: 'model', baseURL: 'http://api.example/v1',
    })).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    expect(resolveRemoteTarget({
      provider: 'openai', model: 'model', baseURL: 'http://localhost:8080/v1',
    }).baseURL).toBe('http://localhost:8080/v1')
    expect(resolveRemoteTarget({
      provider: 'openai', model: 'model', baseURL: 'http://127.0.0.1:8080/v1',
    }).baseURL).toBe('http://127.0.0.1:8080/v1')
  })

  it('falls back only for operational and protocol incompatibility failures in auto mode', async () => {
    const fallback = vi.fn(async () => 'basic-result')
    for (const code of [
      'unsupported', 'temporarily-unavailable', 'transport', 'timeout',
      'incompatible-input', 'incompatible-response',
    ] as const) {
      await expect(decideRemoteOutcome('auto', new RemoteCompactionError(code, code), fallback))
        .resolves.toBe('basic-result')
    }
    expect(fallback).toHaveBeenCalledTimes(6)
  })

  it('fails loud for trust and validation failures', async () => {
    const fallback = vi.fn(async () => 'basic-result')
    for (const code of [
      'authentication', 'permission', 'invalid-request', 'invalid-response', 'request-too-large', 'response-too-large',
    ] as const) {
      const error = new RemoteCompactionError(code, code)
      await expect(decideRemoteOutcome('auto', error, fallback)).rejects.toBe(error)
    }
    expect(fallback).not.toHaveBeenCalled()
  })

  it('never falls back in remote-only mode and preserves non-remote abort reasons', async () => {
    const fallback = vi.fn(async () => 'basic-result')
    const remote = new RemoteCompactionError('unsupported', 'unsupported')
    await expect(decideRemoteOutcome('remote-only', remote, fallback)).rejects.toBe(remote)
    const abort = new Error('caller cancelled')
    await expect(decideRemoteOutcome('auto', abort, fallback)).rejects.toBe(abort)
    await expect(decideRemoteOutcome(
      'auto', new RemoteCompactionError('invalid-response', 'invalid'), fallback,
    )).rejects.toMatchObject({ code: 'invalid-response' })
    expect(fallback).not.toHaveBeenCalled()
  })

  it('treats the official opaque success as incompatible with the Basic text hook', async () => {
    const fallback = vi.fn(async () => 'basic-result')
    const error = new RemoteCompactionError(
      'incompatible-response',
      'OpenAI compact output must remain canonical and cannot be projected to text',
    )
    await expect(decideRemoteOutcome('auto', error, fallback)).resolves.toBe('basic-result')
    await expect(decideRemoteOutcome('remote-only', error, fallback)).rejects.toBe(error)
  })
})
