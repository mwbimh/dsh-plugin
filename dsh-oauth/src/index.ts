/** Keyless OAuth credential-bridge spike for the DSH `llm/stream` seam. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/** Loader configuration for one managed route and credential reference. */
export interface Config {
  route: string
  credentialRef: string
  refreshEndpoint: string
  expiresAt: number
  refreshWindowMs?: number
}

export const Config: z<Config> = z.object({
  route: z.string().required(),
  credentialRef: z.string().required(),
  refreshEndpoint: z.string().required(),
  expiresAt: z.number().required(),
  refreshWindowMs: z.number().default(30_000),
})

export const name = 'dsh-oauth'
export const inject = ['llm', 'credentials']

interface RefreshResponse {
  accessToken: string
  expiresAt: number
}

/** Install request-time refresh before the existing adapter resolves its credential. */
export function apply(ctx: Context, config: Config): void {
  const ref = credentialRef(config.credentialRef)
  const refreshWindowMs = config.refreshWindowMs ?? 30_000
  let expiresAt = config.expiresAt
  let refresh: Promise<void> | undefined
  let disposed = false
  const refreshAbort = new AbortController()

  const ensureFresh = async (): Promise<void> => {
    if (disposed) throw new Error('dsh-oauth: bridge disposed')
    if (Date.now() + refreshWindowMs < expiresAt) return
    refresh ??= (async () => {
      const response = await fetch(config.refreshEndpoint, { method: 'POST', signal: refreshAbort.signal })
      if (!response.ok) throw new Error(`dsh-oauth: refresh failed (${response.status})`)
      const body = await response.json() as Partial<RefreshResponse>
      if (typeof body.accessToken !== 'string' || body.accessToken.length === 0
        || typeof body.expiresAt !== 'number' || !Number.isFinite(body.expiresAt)) {
        throw new Error('dsh-oauth: refresh response is invalid')
      }
      if (disposed) throw new Error('dsh-oauth: bridge disposed during refresh')
      await ctx.credentials.set(ref, body.accessToken)
      expiresAt = body.expiresAt
    })().finally(() => {
      refresh = undefined
    })
    await refresh
  }

  ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => {
    if (options.provider !== config.route) return next()
    return (async function* () {
      await ensureFresh()
      yield* next()
    })()
  })

  ctx.effect(() => async () => {
    disposed = true
    refreshAbort.abort('dsh-oauth bridge disposed')
    try {
      await refresh
    } catch (_refreshAbortedByDisposal) {
      // Disposal owns this abort; the request observing the flight keeps the failure.
    }
  })
}
