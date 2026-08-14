/** Stable remote-compaction failure categories used by fallback policy. */
export type RemoteCompactionErrorCode =
  | 'aborted'
  | 'authentication'
  | 'incompatible-input'
  | 'incompatible-response'
  | 'invalid-request'
  | 'invalid-response'
  | 'permission'
  | 'request-too-large'
  | 'response-too-large'
  | 'temporarily-unavailable'
  | 'timeout'
  | 'transport'
  | 'unsupported'

/** One classified failure from the remote compaction path. */
export class RemoteCompactionError extends Error {
  override readonly name = 'RemoteCompactionError'

  /**
   * Create a classified remote failure.
   * @param code - stable fallback-policy category.
   * @param message - credential- and content-free diagnostic.
   * @param options - optional original failure.
   */
  constructor(
    readonly code: RemoteCompactionErrorCode,
    message: string,
  ) {
    super(message)
  }
}
