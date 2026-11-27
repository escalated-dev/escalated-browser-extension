export class ApiError extends Error {
  status: number
  retryAfter?: number
  errors?: Record<string, string[]>

  constructor(
    message: string,
    status: number,
    extra: { retryAfter?: number; errors?: Record<string, string[]> } = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    if (extra.retryAfter !== undefined) this.retryAfter = extra.retryAfter
    if (extra.errors !== undefined) this.errors = extra.errors
  }
}
