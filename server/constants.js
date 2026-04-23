export const parent = Symbol('parent')

// Server defaults
export const DEFAULT_PORT = 3001
export const DEFAULT_TIMEOUT_MS = 60 * 1000
export const DEFAULT_MAX_MESSAGE_SIZE_MB = 5
export const DEFAULT_MAX_POST_SIZE_MB = 50

// Server bounds
export const MIN_TIMEOUT_MS = 10_000
export const MAX_PORT = 65535
