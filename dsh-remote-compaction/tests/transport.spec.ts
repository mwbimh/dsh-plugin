import { describe, expect, it, vi } from 'vitest'
import {
  OpenAICompactTransport,
  normalizeCompactResponse,
  serializeCompactionInput,
} from '../src/transport.ts'
import { RemoteCompactionError } from '../src/errors.ts'

describe('OpenAI compact transport', () => {
  it('serializes only the Basic-selected text range', () => {
    expect(serializeCompactionInput({
      system: 'system',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'one' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
      ],
    })).toEqual([
      { role: 'developer', content: 'system' },
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
    ])
  })

  it('rejects blocks that cannot be represented losslessly', () => {
    expect(() => serializeCompactionInput({
      messages: [{ role: 'user', content: [{ type: 'tool-call' }] }],
    })).toThrowError(expect.objectContaining({ code: 'incompatible-input' }))
    expect(() => serializeCompactionInput({
      tools: [{ name: 'tool' }],
      messages: [],
    })).toThrowError(expect.objectContaining({ code: 'incompatible-input' }))
  })

  it('validates the official opaque response without pruning its output', () => {
    const output = [
      { id: 'msg_1', type: 'message', role: 'user', content: [] },
      { id: 'cmp_1', type: 'compaction', encrypted_content: 'ciphertext' },
    ]
    expect(normalizeCompactResponse({
      id: 'resp_1',
      object: 'response.compaction',
      output,
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    })).toEqual({ output, usage: { inputTokens: 3, outputTokens: 2 } })
  })

  it('rejects malformed success responses', () => {
    const malformed = [
      null,
      [],
      'response',
      {},
      { id: 1, object: 'response.compaction', output: [{}] },
      { id: 'id', object: 'wrong', output: [{}] },
      { id: 'id', object: 'response.compaction', output: {} },
      { id: 'id', object: 'response.compaction', output: [] },
      { id: 'id', object: 'response.compaction', output: [null] },
    ]
    for (const value of malformed) {
      expect(() => normalizeCompactResponse(value))
        .toThrowError(expect.objectContaining({ code: 'invalid-response' }))
    }
  })

  it('rejects every malformed usage field', () => {
    for (const usage of [
      null,
      { input_tokens: 1 },
      { input_tokens: 1.5, output_tokens: 2 },
      { input_tokens: 1, output_tokens: 2.5 },
      { input_tokens: -1, output_tokens: 2 },
      { input_tokens: 1, output_tokens: -2 },
    ]) {
      expect(() => normalizeCompactResponse({
        id: 'id', object: 'response.compaction', output: [{}], usage,
      })).toThrowError(expect.objectContaining({ code: 'invalid-response' }))
    }
  })

  it('sends the documented request and preserves caller abort', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      })
      expect(typeof init?.body).toBe('string')
      expect(JSON.parse(init?.body as string)).toEqual({
        model: 'gpt-test',
        input: [{ role: 'user', content: 'hello' }],
      })
      return new Response(JSON.stringify({
        id: 'resp_1', object: 'response.compaction',
        output: [{ type: 'compaction', encrypted_content: 'opaque' }],
      }))
    })
    const transport = new OpenAICompactTransport({
      baseURL: 'https://api.example/v1/',
      timeoutMs: 1_000,
      maxRequestBytes: 10_000,
      maxResponseBytes: 10_000,
      fetch: fetchMock,
    })
    const controller = new AbortController()
    await transport.compact({
      apiKey: 'secret', model: 'gpt-test', input: [{ role: 'user', content: 'hello' }],
      signal: controller.signal,
    })
    expect(fetchMock).toHaveBeenCalledWith('https://api.example/v1/responses/compact', expect.anything())

    controller.abort(new Error('caller cancelled'))
    await expect(transport.compact({
      apiKey: 'secret', model: 'gpt-test', input: [], signal: controller.signal,
    })).rejects.toThrow('caller cancelled')
  })

  it('classifies timeout, authentication, unsupported, rate limit, and invalid request', async () => {
    const cases = [
      [401, 'authentication'],
      [403, 'permission'],
      [404, 'unsupported'],
      [405, 'unsupported'],
      [501, 'unsupported'],
      [408, 'temporarily-unavailable'],
      [409, 'temporarily-unavailable'],
      [429, 'temporarily-unavailable'],
      [500, 'temporarily-unavailable'],
      [400, 'invalid-request'],
    ] as const
    for (const [status, code] of cases) {
      const transport = new OpenAICompactTransport({
        baseURL: 'https://api.example/v1', timeoutMs: 10, maxRequestBytes: 1_000, maxResponseBytes: 1_000,
        fetch: async () => new Response(JSON.stringify({ error: { code: 'test_code' } }), { status }),
      })
      await expect(transport.compact({
        apiKey: 'secret', model: 'gpt-test', input: [], signal: new AbortController().signal,
      })).rejects.toEqual(expect.objectContaining({ code }))
    }

    const timeoutTransport = new OpenAICompactTransport({
      baseURL: 'https://api.example/v1', timeoutMs: 1, maxRequestBytes: 1_000, maxResponseBytes: 1_000,
      fetch: async (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      }),
    })
    await expect(timeoutTransport.compact({
      apiKey: 'secret', model: 'gpt-test', input: [], signal: new AbortController().signal,
    })).rejects.toEqual(expect.objectContaining({ code: 'timeout' }))
  })

  it('bounds the response before JSON parsing', async () => {
    const transport = new OpenAICompactTransport({
      baseURL: 'https://api.example/v1', timeoutMs: 100, maxRequestBytes: 1_000, maxResponseBytes: 1,
      fetch: async () => new Response('{}'),
    })
    await expect(transport.compact({
      apiKey: 'secret', model: 'gpt-test', input: [], signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(RemoteCompactionError)

    const headerBound = new OpenAICompactTransport({
      baseURL: 'https://api.example/v1', timeoutMs: 100, maxRequestBytes: 1_000, maxResponseBytes: 1,
      fetch: async () => new Response('{}', { headers: { 'content-length': '2' } }),
    })
    await expect(headerBound.compact({
      apiKey: 'secret', model: 'gpt-test', input: [], signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'response-too-large' })
  })

  it('bounds the UTF-8 request before network I/O', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const transport = new OpenAICompactTransport({
      baseURL: 'https://api.example/v1', timeoutMs: 100, maxRequestBytes: 1, maxResponseBytes: 100,
      fetch: fetchMock,
    })
    await expect(transport.compact({
      apiKey: 'secret', model: '模型', input: [], signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'request-too-large' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('classifies network failure and invalid JSON without leaking causes', async () => {
    const network = new OpenAICompactTransport({
      baseURL: 'https://api.example/v1', timeoutMs: 100, maxRequestBytes: 100, maxResponseBytes: 100,
      fetch: async () => { throw new Error('secret network detail') },
    })
    await expect(network.compact({
      apiKey: 'secret', model: 'model', input: [], signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'transport', message: 'remote compaction request failed' })

    const invalidJson = new OpenAICompactTransport({
      baseURL: 'https://api.example/v1', timeoutMs: 100, maxRequestBytes: 100, maxResponseBytes: 100,
      fetch: async () => new Response('{'),
    })
    await expect(invalidJson.compact({
      apiKey: 'secret', model: 'model', input: [], signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'invalid-response' })

    const emptyBody = new OpenAICompactTransport({
      baseURL: 'https://api.example/v1', timeoutMs: 100, maxRequestBytes: 100, maxResponseBytes: 100,
      fetch: async () => new Response(null),
    })
    await expect(emptyBody.compact({
      apiKey: 'secret', model: 'model', input: [], signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'invalid-response' })
  })

  it('preserves a caller abort that occurs during fetch', async () => {
    const transport = new OpenAICompactTransport({
      baseURL: 'https://api.example/v1', timeoutMs: 100, maxRequestBytes: 100, maxResponseBytes: 100,
      fetch: async (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      }),
    })
    const controller = new AbortController()
    const reason = new Error('caller cancelled during fetch')
    const pending = transport.compact({
      apiKey: 'secret', model: 'model', input: [], signal: controller.signal,
    })
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })

  it('classifies timeout while reading the response body', async () => {
    const transport = new OpenAICompactTransport({
      baseURL: 'https://api.example/v1', timeoutMs: 1, maxRequestBytes: 100, maxResponseBytes: 100,
      fetch: async (_input, init) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(new Error('body aborted')), { once: true })
          },
        })
        return new Response(body)
      },
    })
    await expect(transport.compact({
      apiKey: 'secret', model: 'model', input: [], signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'timeout' })
  })

  it('preserves caller abort and classifies transport failure while reading a body', async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
    const callerTransport = new OpenAICompactTransport({
      baseURL: 'https://api.example/v1', timeoutMs: 100, maxRequestBytes: 100, maxResponseBytes: 100,
      fetch: async (_input, init) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true })
          },
        })
        return new Response(body)
      },
    })
    const controller = new AbortController()
    const reason = new Error('caller cancelled body')
    const pending = callerTransport.compact({
      apiKey: 'secret', model: 'model', input: [], signal: controller.signal,
    })
    await vi.waitFor(() => expect(bodyController).toBeDefined())
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)

    const failedBody = new OpenAICompactTransport({
      baseURL: 'https://api.example/v1', timeoutMs: 100, maxRequestBytes: 100, maxResponseBytes: 100,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(stream) { stream.error(new Error('body failed')) },
      })),
    })
    await expect(failedBody.compact({
      apiKey: 'secret', model: 'model', input: [], signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'transport', message: 'remote compaction response failed' })
  })

  it('uses global fetch when no transport override is supplied', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      id: 'id', object: 'response.compaction', output: [{}],
    })))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const transport = new OpenAICompactTransport({
        baseURL: 'https://api.example/v1', timeoutMs: 100, maxRequestBytes: 100, maxResponseBytes: 100,
      })
      await transport.compact({
        apiKey: 'secret', model: 'model', input: [], signal: new AbortController().signal,
      })
      expect(fetchMock).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
