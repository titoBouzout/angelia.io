export const parent = Symbol('parent')

// Server defaults
export const DEFAULT_PORT = 3001
// Sits comfortably
// under QUIC's typical 30s `max_idle_timeout` so the transport can't
// silently idle-close the session before our ping fires.
export const DEFAULT_TIMEOUT_MS = 40_000

// Server bounds
export const MIN_TIMEOUT_MS = 10_000
export const MAX_PORT = 65535
