/** Package invariant name used by DSH invariant discovery. */
export const name = 'dsh-remote-control'
export const inject: string[] = []

/** No runtime invariant: listener ownership is asserted by lifecycle and loopback tests. */
export function apply(): void {}
