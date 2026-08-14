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
    source: { kind: 'model'; provider: string; model: string }
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

interface CallSample {
  provider: string
  model: string
  usage?: ProviderUsage
}

interface ReplacementSlot {
  turn: number
  step: number
  sample: CallSample
}

/** Plain-JSON internal state suitable for a session-projection checkpoint. */
export interface ConversationUsageState {
  totals: UsageTotals
  routes: Record<string, RouteUsage>
  /** The only sample retained so an immediately repeated final can replace it. */
  lastCall?: ReplacementSlot
}

const routeKey = (provider: string, model: string): string =>
  `${provider.length}:${provider}${model}`

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
  return { totals: zeroTotals(), routes: {} }
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
  if (event.type === 'request/header') return state

  if (event.type === 'request/context') {
    const { provider, model, contextWindow } = event.data
    const key = routeKey(provider, model)
    const previous = state.routes[key]
    if (previous?.contextWindow === contextWindow) return state
    const { contextWindow: _previousContextWindow, ...previousWithoutContext } = previous ?? {
      provider,
      model,
      ...zeroTotals(),
    }
    const nextRoute: RouteUsage = {
      ...previousWithoutContext,
      ...(contextWindow === undefined ? {} : { contextWindow }),
    }
    const routes = { ...state.routes }
    if (routeIsEmpty(nextRoute)) {
      delete routes[key]
    } else {
      routes[key] = nextRoute
    }
    return {
      ...state,
      routes,
    }
  }

  if (event.type !== 'assistant/message') return state

  const source = event.data.message.source
  if (source.kind !== 'model' || source.provider.length === 0 || source.model.length === 0) {
    throw new Error(`assistant/message at seq ${event.seq} lacks model provenance`)
  }

  const sample: CallSample = {
    provider: source.provider,
    model: source.model,
    ...(event.data.usage === undefined ? {} : { usage: normalizedUsage(event.data.usage) }),
  }
  const lastCall = state.lastCall
  if (lastCall !== undefined) {
    if (event.data.turn === lastCall.turn && event.data.step === lastCall.step) {
      if (samplesEqual(lastCall.sample, sample)) return state
      return replaceSample(state, event.data.turn, event.data.step, lastCall.sample, sample)
    }
  }
  return appendSample(state, event.data.turn, event.data.step, sample)
}

/** Build the privacy-minimized public value from fold state. */
export function viewConversationUsage(state: ConversationUsageState): ConversationUsageProjection {
  return {
    ...state.totals,
    routes: Object.values(state.routes)
      .filter(route => route.measuredCalls + route.missingUsageCalls > 0)
      .map(route => ({ ...route }))
      .sort((left, right) =>
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

function appendSample(
  state: ConversationUsageState,
  turn: number,
  step: number,
  sample: CallSample,
): ConversationUsageState {
  return {
    ...state,
    totals: adjustedTotals(state.totals, sample, 1),
    routes: adjustedRoutes(state.routes, sample, 1),
    lastCall: { turn, step, sample },
  }
}

function replaceSample(
  state: ConversationUsageState,
  turn: number,
  step: number,
  previous: CallSample,
  sample: CallSample,
): ConversationUsageState {
  const withoutPrevious = adjustedTotals(state.totals, previous, -1)
  const routesWithoutPrevious = adjustedRoutes(state.routes, previous, -1)
  return {
    ...state,
    totals: adjustedTotals(withoutPrevious, sample, 1),
    routes: adjustedRoutes(routesWithoutPrevious, sample, 1),
    lastCall: { turn, step, sample },
  }
}

function adjustedRoutes(
  routes: Record<string, RouteUsage>,
  sample: CallSample,
  direction: 1 | -1,
): Record<string, RouteUsage> {
  const key = routeKey(sample.provider, sample.model)
  const previous = routes[key] ?? {
    provider: sample.provider,
    model: sample.model,
    ...zeroTotals(),
  }
  const nextRoute = {
    ...previous,
    ...adjustedTotals(previous, sample, direction),
  }
  const nextRoutes = { ...routes }
  if (routeIsEmpty(nextRoute)) {
    delete nextRoutes[key]
  } else {
    nextRoutes[key] = nextRoute
  }
  return nextRoutes
}

function routeIsEmpty(route: RouteUsage): boolean {
  return route.measuredCalls + route.missingUsageCalls === 0
    && route.contextWindow === undefined
}

function adjustedTotals(
  target: UsageTotals,
  sample: CallSample,
  direction: 1 | -1,
): UsageTotals {
  const result = { ...target }
  const usage = sample.usage
  if (usage === undefined) {
    result.missingUsageCalls += direction
    return checkedTotals(result)
  }
  result.measuredCalls += direction
  result.inputTokens += direction * usage.inputTokens
  result.outputTokens += direction * usage.outputTokens
  result.cacheReadTokens += direction * (usage.cacheReadTokens ?? 0)
  result.cacheWriteTokens += direction * (usage.cacheWriteTokens ?? 0)
  if (usage.reasoningTokens !== undefined) {
    result.reasoningTokens += direction * usage.reasoningTokens
    result.reasoningUsageCalls += direction
  }
  return checkedTotals(result)
}

function checkedTotals(totals: UsageTotals): UsageTotals {
  const fields = [
    'measuredCalls',
    'missingUsageCalls',
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
    'reasoningUsageCalls',
  ] as const satisfies readonly (keyof UsageTotals)[]
  for (const name of fields) {
    const value = totals[name]
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`aggregate ${name} must be a non-negative safe integer`)
    }
  }
  return totals
}
