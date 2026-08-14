/**
 * Remote compaction engine for the version-pinned BasicCompactionEngine hook.
 *
 * @module dsh-remote-compaction
 */

import type { Context } from '@deepseek-ai/cordis'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { RemoteCompactionCoordinator } from './coordinator.js'
import { RemoteCompactionError } from './errors.js'
import {
  decideRemoteOutcome,
  resolveConversationTarget,
  type RemoteCompactionMode,
} from './policy.js'
import { OpenAICompactTransport, serializeCompactionInput } from './transport.js'

/** Configuration layered on the exact Basic engine version. */
export interface Config extends BasicCompactionConfig {
  readonly mode?: RemoteCompactionMode
  readonly provider?: string
  readonly model?: string
  readonly baseURL?: string
  readonly credentialRef?: string
  readonly timeoutMs?: number
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  readonly capabilityTtlMs?: number
  readonly unavailableTtlMs?: number
}

interface SummarizationInput {
  readonly system?: string
  readonly tools?: readonly ToolSchema[]
  readonly messages: readonly Message[]
}

/**
 * Minimal rc.5 protected-hook boundary. Basic does not publicly export this
 * result type, which is one reason this package remains private.
 */
type SummaryResultBoundary = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  usage?: TokenUsage
} & (
  | { rawOutput: ContentBlock[]; llmStreamCall: true }
  | { rawOutput?: ContentBlock[]; llmStreamCall?: never }
)

const modeSchema = z.union([z.const('auto'), z.const('remote-only'), z.const('disabled')])
const remoteFields = z.object({
  mode: modeSchema.default('disabled'),
  provider: z.string().default('openai'),
  model: z.string().default(''),
  baseURL: z.string().default('https://api.openai.com/v1'),
  credentialRef: z.string().default('OPENAI_API_KEY'),
  timeoutMs: z.number().step(1).min(1).default(30_000),
  maxRequestBytes: z.number().step(1).min(1).default(4_000_000),
  maxResponseBytes: z.number().step(1).min(1).default(4_000_000),
  capabilityTtlMs: z.number().step(1).min(1).default(3_600_000),
  unavailableTtlMs: z.number().step(1).min(1).default(30_000),
}) as unknown as z<Required<Pick<Config,
  | 'mode'
  | 'provider'
  | 'model'
  | 'baseURL'
  | 'credentialRef'
  | 'timeoutMs'
  | 'maxRequestBytes'
  | 'maxResponseBytes'
  | 'capabilityTtlMs'
  | 'unavailableTtlMs'>>>

/** Remote provider that delegates every non-summarization concern to Basic. */
export class RemoteCompactionEngine extends BasicCompactionEngine {
  static override inject = [...BasicCompactionEngine.inject, 'credentials']

  static override Config = z.intersect([
    BasicCompactionEngine.Config,
    remoteFields,
  ]) as unknown as z<Config>

  private readonly remote: RemoteCompactionCoordinator
  private readonly remoteConfig: Required<Pick<Config,
    | 'mode'
    | 'provider'
    | 'model'
    | 'baseURL'
    | 'credentialRef'
    | 'timeoutMs'
    | 'maxRequestBytes'
    | 'maxResponseBytes'
    | 'capabilityTtlMs'
    | 'unavailableTtlMs'>>

  constructor(ctx: Context, config: Config) {
    const {
      mode,
      provider,
      model,
      baseURL,
      credentialRef: credentialReference,
      timeoutMs,
      maxRequestBytes,
      maxResponseBytes,
      capabilityTtlMs,
      unavailableTtlMs,
      ...basicConfig
    } = config
    super(ctx, basicConfig)
    const normalized = {
      mode,
      provider,
      model,
      baseURL,
      credentialRef: credentialReference,
      timeoutMs,
      maxRequestBytes,
      maxResponseBytes,
      capabilityTtlMs,
      unavailableTtlMs,
    } as Required<Pick<Config,
      | 'mode'
      | 'provider'
      | 'model'
      | 'baseURL'
      | 'credentialRef'
      | 'timeoutMs'
      | 'maxRequestBytes'
      | 'maxResponseBytes'
      | 'capabilityTtlMs'
      | 'unavailableTtlMs'>>
    this.remoteConfig = {
      ...normalized,
    }
    const transport = new OpenAICompactTransport(this.remoteConfig)
    const ref = credentialRef(this.remoteConfig.credentialRef)
    this.remote = new RemoteCompactionCoordinator({
      supportedTtlMs: this.remoteConfig.capabilityTtlMs,
      unavailableTtlMs: this.remoteConfig.unavailableTtlMs,
      resolveCredential: async () => (await ctx.credentials.resolve(ref))?.value,
      compact: request => transport.compact(request),
    })
    ctx.effect(() => async () => this.remote.dispose(), 'dsh-remote-compaction.lifecycle')
  }

  /**
   * Exercise the official remote transport, then fail closed because its
   * canonical opaque output cannot be represented by Basic's text summary hook.
   */
  protected override async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResultBoundary> {
    if (this.remoteConfig.mode === 'disabled') return super.summarize(input, agent, signal)
    try {
      const latest = agent.session.requestHeader()?.config
      const target = resolveConversationTarget(
        this.remoteConfig,
        latest,
        agent.options,
      )
      const result = await this.remote.compact({
        provider: target.provider,
        model: target.model,
        baseURL: this.remoteConfig.baseURL,
        input: serializeCompactionInput(input),
        ...(signal === undefined ? {} : { signal }),
      })
      throw new RemoteCompactionError(
        'incompatible-response',
        `OpenAI compact output (${result.output.length} items) is canonical opaque context and cannot be projected into the Basic text summary hook`,
      )
    } catch (error: unknown) {
      return decideRemoteOutcome(
        this.remoteConfig.mode,
        error,
        () => super.summarize(input, agent, signal),
      )
    }
  }
}

export { RemoteCompactionError } from './errors.js'
export type { RemoteCompactionErrorCode } from './errors.js'
export { OpenAICompactTransport, normalizeCompactResponse, serializeCompactionInput } from './transport.js'
export default RemoteCompactionEngine
