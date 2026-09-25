/**
 * A refusal meant for whoever called: written in plain words, because it ends
 * up in front of a person or a model as it stands. Transports pass the message
 * through untouched.
 */
export class ApiError extends Error {
  override name = 'ApiError'
}

/** Resolves a lookup or refuses in the caller's terms. */
export function found<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new ApiError(`That ${what} no longer exists.`)
  return value
}
