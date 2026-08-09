/** Identifiers. UUIDs so that two offline devices never collide. */
export function newId(): string {
  return crypto.randomUUID()
}

/** ISO-8601 UTC string. Every timestamp crossing the JSON boundary uses this. */
export function nowIso(): string {
  return new Date().toISOString()
}
