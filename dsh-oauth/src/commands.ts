/** Token-free `/dsh-oauth` account lifecycle command integration. */
import { OAuthError } from './errors.ts'
import type { OAuthAccount, OAuthAccountId, OAuthService } from './types.ts'

/** Command result subset consumed by the DSH command registry. */
export type OAuthCommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/** Invocation fields used by the OAuth command handler. */
export interface OAuthCommandInvocation {
  readonly rawInput: string
  readonly signal: AbortSignal
}

/** Structural command definition accepted by `ctx.commands.register()`. */
export interface OAuthCommandDefinition {
  readonly name: string
  readonly description: string
  readonly input: { readonly hint: string }
  readonly recordInput: false
  readonly handler: (invocation: OAuthCommandInvocation) => OAuthCommandResult | Promise<OAuthCommandResult>
}

/** Structural registry surface used to keep the command package optional at compile time. */
export interface OAuthCommandRegistry {
  register(definition: OAuthCommandDefinition): () => void
}

const INPUT_HINT = 'accounts [provider] | login <provider> | logout <account-id> | rotate <account-id>'
const USAGE = `Usage: /dsh-oauth ${INPUT_HINT}`

/** Render account metadata without inspecting or resolving a credential. */
function renderAccount(account: OAuthAccount): string {
  const fields = [
    account.id,
    account.provider,
    account.displayName ?? '-',
    account.status,
    account.expiresAt === undefined ? 'expiry unknown' : `expires ${new Date(account.expiresAt).toISOString()}`,
    `scopes ${account.scopes.join(',') || '-'}`,
  ]
  return fields.join('\t')
}

/** Convert a known classified OAuth error or an unknown failure to safe command text. */
function safeFailure(operation: string, error: unknown): OAuthCommandResult {
  return {
    kind: 'error',
    text: error instanceof OAuthError ? error.message : `dsh-oauth: ${operation} failed`,
  }
}

/** Split command input without retaining it in any returned diagnostic. */
function parse(rawInput: string): readonly string[] {
  const trimmed = rawInput.trim()
  return trimmed.length === 0 ? [] : trimmed.split(/\s+/u)
}

/**
 * Register the token-free account lifecycle command.
 *
 * `recordInput` is always false because login/account identifiers and future
 * provider flow inputs must never be copied to `command/run` session events.
 *
 * @param registry - DSH command registry.
 * @param service - OAuth public lifecycle service.
 * @returns disposer returned by the registry.
 */
export function installOAuthCommands(registry: OAuthCommandRegistry, service: OAuthService): () => void {
  return registry.register({
    name: 'dsh-oauth',
    description: 'Manage OAuth accounts and credential rotation.',
    input: { hint: INPUT_HINT },
    recordInput: false,
    async handler({ rawInput, signal }): Promise<OAuthCommandResult> {
      const args = parse(rawInput)
      const operation = args[0]
      try {
        if (operation === 'accounts' && args.length <= 2) {
          const accounts = await service.accounts(args[1])
          return {
            kind: 'success',
            text: accounts.length === 0 ? 'No OAuth accounts.' : accounts.map(renderAccount).join('\n'),
          }
        }
        if (operation === 'login' && args.length === 2) {
          const account = await service.login(args[1]!, { signal })
          return { kind: 'success', text: renderAccount(account) }
        }
        if (operation === 'logout' && args.length === 2) {
          await service.logout(args[1]! as OAuthAccountId)
          return { kind: 'success', text: 'OAuth account logged out.' }
        }
        if (operation === 'rotate' && args.length === 2) {
          await service.rotate(args[1]! as OAuthAccountId, { signal })
          return { kind: 'success', text: 'OAuth credential rotated.' }
        }
        return { kind: 'error', text: USAGE }
      } catch (error) {
        return safeFailure(operation!, error)
      }
    },
  })
}
