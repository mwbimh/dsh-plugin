/**
 * Pure projection of durable conversation usage from a DSH session log.
 * Only finalized assistant messages are billable samples in this first
 * version. Stream chunks are deliberately ignored because retry attempts and
 * the final message can both carry usage for one `(turn, step)`.
 */

/** Provider-neutral token accounting for one model call. */
export interface ProviderUsage {
  /** Uncached input tokens. */
  inputTokens: number
  /** All output tokens; reasoning tokens are a subset, not an extra bucket. */
  outputTokens: number
  /** Provider-reported cached input reads. */
  cacheReadTokens?: number
  /** Provider-reported cache population writes. */
  cacheWriteTokens?: number
  /** Provider-reported reasoning subset of output tokens. */
  reasoningTokens?: number
}

interface RequestHeaderData {
  header: {
    config: { provider: string; model: string }
    system?: string
    tools?: readonly unknown[]
  }
  reason: 'initial' | 'resume' | 'change'
}

interface RequestContextData {
  provider: string
  model: string
  contextWindow?: number
}

interface AssistantChunkData {
  turn: number
  step: number
  chunk: { type: string; usage?: ProviderUsage }
}

interface AssistantMessageData {
  turn: number
  step: number
  message: {
    role: 'assistant'
    content: readonly unknown[]
    source: { kind: string; provider?: string; model?: string }
  }
  usage?: ProviderUsage
}

/** Minimal durable event vocabulary consumed by the projection. */
export type ConversationUsageEvent =
  | EventEnvelope<'request/header', RequestHeaderData>
  | EventEnvelope<'request/context', RequestContextData>
  | EventEnvelope<'assistant/chunk', AssistantChunkData>
  | EventEnvelope<'assistant/message', AssistantMessageData>

interface EventEnvelope<T extends string, D> {
  type: T
  seq: number
  time: number
  data: D
}

/** Token and call totals shared by a session and each provider/model route. */
export interface UsageTotals {
  measuredCalls: number
  missingUsageCalls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  /** Calls whose provider explicitly supplied `reasoningTokens`, including zero. */
  reasoningUsageCalls: number
}

/** Usage totals for one exact provider/model route. */
export interface RouteUsage extends UsageTotals {
  provider: string
  model: string
  /** Latest context capacity logged for this exact route, when available. */
  contextWindow?: number
}

/** Public per-session projection value. */
export interface ConversationUsageProjection extends UsageTotals {
  routes: RouteUsage[]
}

interface RouteContext {
  provider: string
  model: string
  contextWindow?: number
}

interface CallSample {
  provider: string
  model: string
  usage?: ProviderUsage
}

/** Plain-JSON internal state suitable for a session-projection checkpoint. */
export interface ConversationUsageState {
  headerRoute?: { provider: string; model: string }
  contexts: Record<string, RouteContext>
  calls: Record<string, CallSample>
}

const routeKey = (provider: string, model: string): string =>
  `${provider.length}:${provider}${model}`

const callKey = (turn: number, step: number): string => `${turn}:${step}`

const zeroTotals = (): UsageTotals => ({
  measuredCalls: 0,
  missingUsageCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  reasoningUsageCalls: 0,
})

/** Create the empty pure-fold state. */
export function createConversationUsageState(): ConversationUsageState {
  return { contexts: {}, calls: {} }
}

/**
 * Fold one durable session event. Unrelated events and every stream chunk
 * preserve the previous state reference.
 * @param state - state covering all earlier events.
 * @param event - next durable event.
 * @returns the next state.
 */
export function applyConversationUsageEvent(
  state: ConversationUsageState,
  event: ConversationUsageEvent,
): ConversationUsageState {
  if (event.type === 'request/header') {
    const { provider, model } = event.data.header.config
    if (state.headerRoute?.provider === provider && state.headerRoute.model === model) return state
    return { ...state, headerRoute: { provider, model } }
  }

  if (event.type === 'request/context') {
    const { provider, model, contextWindow } = event.data
    const key = routeKey(provider, model)
    const previous = state.contexts[key]
    if (previous?.contextWindow === contextWindow) return state
    return {
      ...state,
      contexts: {
        ...state.contexts,
        [key]: {
          provider,
          model,
          ...(contextWindow === undefined ? {} : { contextWindow }),
        },
      },
    }
  }

  if (event.type !== 'assistant/message') return state

  const source = event.data.message.source
  const provider = state.headerRoute?.provider ?? source.provider
  const model = state.headerRoute?.model ?? source.model
  if (provider === undefined || model === undefined) return state

  const key = callKey(event.data.turn, event.data.step)
  const sample: CallSample = {
    provider,
    model,
    ...(event.data.usage === undefined ? {} : { usage: normalizedUsage(event.data.usage) }),
  }
  const previous = state.calls[key]
  if (previous !== undefined && samplesEqual(previous, sample)) return state
  return { ...state, calls: { ...state.calls, [key]: sample } }
}

/** Build the privacy-minimized public value from fold state. */
export function viewConversationUsage(state: ConversationUsageState): ConversationUsageProjection {
  const totals = zeroTotals()
  const routes = new Map<string, RouteUsage>()

  for (const sample of Object.values(state.calls)) {
    const key = routeKey(sample.provider, sample.model)
    let route = routes.get(key)
    if (route === undefined) {
      const context = state.contexts[key]
      route = {
        provider: sample.provider,
        model: sample.model,
        ...(context?.contextWindow === undefined ? {} : { contextWindow: context.contextWindow }),
        ...zeroTotals(),
      }
      routes.set(key, route)
    }
    addSample(totals, sample)
    addSample(route, sample)
  }

  return {
    ...totals,
    routes: [...routes.values()].sort((left, right) =>
      left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model)),
  }
}

/** Deterministically rebuild a projection from a complete durable log. */
export function foldConversationUsage(
  events: readonly ConversationUsageEvent[],
): ConversationUsageProjection {
  let state = createConversationUsageState()
  for (const event of events) state = applyConversationUsageEvent(state, event)
  return viewConversationUsage(state)
}

function normalizedUsage(usage: ProviderUsage): ProviderUsage {
  const fields = [
    ['inputTokens', usage.inputTokens],
    ['outputTokens', usage.outputTokens],
    ['cacheReadTokens', usage.cacheReadTokens],
    ['cacheWriteTokens', usage.cacheWriteTokens],
    ['reasoningTokens', usage.reasoningTokens],
  ] as const
  for (const [name, value] of fields) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`${name} must be a non-negative safe integer`)
    }
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  }
}

function samplesEqual(left: CallSample, right: CallSample): boolean {
  if (left.provider !== right.provider || left.model !== right.model) return false
  if (left.usage === undefined || right.usage === undefined) return left.usage === right.usage
  return left.usage.inputTokens === right.usage.inputTokens
    && left.usage.outputTokens === right.usage.outputTokens
    && left.usage.cacheReadTokens === right.usage.cacheReadTokens
    && left.usage.cacheWriteTokens === right.usage.cacheWriteTokens
    && left.usage.reasoningTokens === right.usage.reasoningTokens
}

function addSample(target: UsageTotals, sample: CallSample): void {
  const usage = sample.usage
  if (usage === undefined) {
    target.missingUsageCalls += 1
    return
  }
  target.measuredCalls += 1
  target.inputTokens += usage.inputTokens
  target.outputTokens += usage.outputTokens
  target.cacheReadTokens += usage.cacheReadTokens ?? 0
  target.cacheWriteTokens += usage.cacheWriteTokens ?? 0
  if (usage.reasoningTokens !== undefined) {
    target.reasoningTokens += usage.reasoningTokens
    target.reasoningUsageCalls += 1
  }
}
