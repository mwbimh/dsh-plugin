import { RemoteCompactionError } from './errors.js'

/** Text-only message subset accepted without losing DSH content. */
export interface SerializableMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: readonly { readonly type: string; readonly text?: string }[]
}

/** Basic summarization input fields used by the OpenAI transport. */
export interface SerializableCompactionInput {
  readonly system?: string
  readonly tools?: readonly unknown[]
  readonly messages: readonly SerializableMessage[]
}

/** One Responses API input item emitted by the lossless serializer. */
export interface OpenAIInputItem {
  readonly role: 'developer' | 'system' | 'user' | 'assistant'
  readonly content: string
}

/** Envelope-validated opaque output from `POST /responses/compact`. */
export interface OpenAICompactResult {
  readonly output: readonly Record<string, unknown>[]
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number }
}

/** Serialize the exact Basic-selected range when every block is plain text. */
export function serializeCompactionInput(input: SerializableCompactionInput): OpenAIInputItem[] {
  if (input.tools !== undefined && input.tools.length > 0) {
    throw new RemoteCompactionError(
      'incompatible-input',
      'remote compaction cannot losslessly serialize DSH tool schemas',
    )
  }
  const items: OpenAIInputItem[] = []
  if (input.system !== undefined) items.push({ role: 'developer', content: input.system })
  for (const message of input.messages) {
    if (!message.content.every(block => block.type === 'text' && typeof block.text === 'string')) {
      throw new RemoteCompactionError(
        'incompatible-input',
        'remote compaction cannot losslessly serialize a non-text DSH content block',
      )
    }
    items.push({
      role: message.role,
      content: message.content.map(block => block.text).join(''),
    })
  }
  return items
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate the response envelope and item discriminators while retaining opaque items. */
export function normalizeCompactResponse(value: unknown): OpenAICompactResult {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || value.object !== 'response.compaction'
    || !Array.isArray(value.output)
    || value.output.length === 0
    || !value.output.every(item => isRecord(item) && typeof item.type === 'string' && item.type.length > 0)) {
    throw new RemoteCompactionError('invalid-response', 'remote compaction returned an invalid response')
  }
  let usage: OpenAICompactResult['usage']
  if (value.usage !== undefined) {
    if (!isRecord(value.usage)
      || !Number.isSafeInteger(value.usage.input_tokens)
      || !Number.isSafeInteger(value.usage.output_tokens)
      || (value.usage.input_tokens as number) < 0
      || (value.usage.output_tokens as number) < 0) {
      throw new RemoteCompactionError('invalid-response', 'remote compaction returned invalid usage')
    }
    usage = {
      inputTokens: value.usage.input_tokens as number,
      outputTokens: value.usage.output_tokens as number,
    }
  }
  return { output: value.output, ...(usage === undefined ? {} : { usage }) }
}

/** Dependencies and bounds for the OpenAI HTTP transport. */
export interface OpenAICompactTransportOptions {
  readonly baseURL: string
  readonly timeoutMs: number
  readonly maxRequestBytes: number
  readonly maxResponseBytes: number
  readonly fetch?: typeof fetch
}

/** One compact request with its per-operation credential and cancellation. */
export interface OpenAICompactRequest {
  readonly apiKey: string
  readonly model: string
  readonly input: readonly OpenAIInputItem[]
  readonly signal: AbortSignal
}

/** Bounded, abortable transport for the official OpenAI compact endpoint. */
export class OpenAICompactTransport {
  private readonly fetch: typeof fetch

  constructor(private readonly options: OpenAICompactTransportOptions) {
    this.fetch = options.fetch ?? globalThis.fetch
  }

  /** Execute one stateless compact request. */
  async compact(request: OpenAICompactRequest): Promise<OpenAICompactResult> {
    request.signal.throwIfAborted()
    const timeout = new AbortController()
    const timeoutReason = new RemoteCompactionError('timeout', 'remote compaction timed out')
    const timer = setTimeout(() => timeout.abort(timeoutReason), this.options.timeoutMs)
    const signal = AbortSignal.any([request.signal, timeout.signal])
    try {
      const body = JSON.stringify({ model: request.model, input: request.input })
      if (new TextEncoder().encode(body).byteLength > this.options.maxRequestBytes) {
        throw new RemoteCompactionError('request-too-large', 'remote compaction request exceeded its byte limit')
      }
      let response: Response
      try {
        response = await this.fetch(
          `${this.options.baseURL.replace(/\/+$/, '')}/responses/compact`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${request.apiKey}`,
              'content-type': 'application/json',
            },
            body,
            signal,
          },
        )
      } catch {
        if (request.signal.aborted) throw request.signal.reason
        if (timeout.signal.aborted) throw timeoutReason
        throw new RemoteCompactionError('transport', 'remote compaction request failed')
      }
      if (!response.ok) throw await this.httpError(response)
      let bytes: Uint8Array
      try {
        bytes = await this.readBounded(response)
      } catch (error: unknown) {
        if (error instanceof RemoteCompactionError) throw error
        if (request.signal.aborted) throw request.signal.reason
        if (timeout.signal.aborted) throw timeoutReason
        throw new RemoteCompactionError('transport', 'remote compaction response failed')
      }
      let value: unknown
      try {
        value = JSON.parse(new TextDecoder().decode(bytes))
      } catch {
        throw new RemoteCompactionError('invalid-response', 'remote compaction returned invalid JSON')
      }
      return normalizeCompactResponse(value)
    } finally {
      clearTimeout(timer)
    }
  }

  private async readBounded(response: Response): Promise<Uint8Array> {
    const declared = response.headers.get('content-length')
    if (declared !== null && Number(declared) > this.options.maxResponseBytes) {
      throw new RemoteCompactionError('response-too-large', 'remote compaction response exceeded its byte limit')
    }
    if (response.body === null) return new Uint8Array()
    const chunks: Uint8Array[] = []
    let total = 0
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > this.options.maxResponseBytes) {
        try {
          void reader.cancel().catch(() => {})
        } catch {
          // Cancellation is best-effort; preserve the stable overflow classification.
        }
        throw new RemoteCompactionError('response-too-large', 'remote compaction response exceeded its byte limit')
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  }

  private async httpError(response: Response): Promise<RemoteCompactionError> {
    const status = response.status
    if (status === 401) {
      return new RemoteCompactionError('authentication', 'remote compaction authentication failed')
    }
    if (status === 403) {
      return new RemoteCompactionError('permission', 'remote compaction permission was denied')
    }
    if (status === 404 || status === 405 || status === 501) {
      return new RemoteCompactionError('unsupported', 'remote compaction is not supported by this target')
    }
    if (status === 408 || status === 409 || status === 429 || status >= 500) {
      return new RemoteCompactionError('temporarily-unavailable', 'remote compaction is temporarily unavailable')
    }
    return new RemoteCompactionError('invalid-request', 'remote compaction request was rejected')
  }
}
