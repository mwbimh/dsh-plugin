import { describe, expect, it } from 'vitest'
import { OpenAICompactTransport } from '../src/transport.ts'

const apiKey = process.env.OPENAI_API_KEY
const model = process.env.OPENAI_COMPACTION_MODEL

describe.skipIf(apiKey === undefined || model === undefined)('OpenAI compact API', () => {
  it('returns the official canonical output from the live endpoint', async () => {
    if (apiKey === undefined || model === undefined) throw new Error('with-key test was not configured')
    const transport = new OpenAICompactTransport({
      baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      timeoutMs: 30_000,
      maxRequestBytes: 4_000_000,
      maxResponseBytes: 4_000_000,
    })
    const result = await transport.compact({
      apiKey,
      model,
      input: [{ role: 'user', content: 'Preserve this fact: the verification marker is RC5.' }],
      signal: AbortSignal.timeout(30_000),
    })
    expect(result.output.length).toBeGreaterThan(0)
  })
})
