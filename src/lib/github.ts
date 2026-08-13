/**
 * The GitHub Contents API, as a file store.
 *
 * Reads and writes JSON files in a private repository over HTTPS. No git, no
 * SSH — a browser can do neither, and none of this needs them.
 */

export interface RepoRef {
  owner: string
  repo: string
  token: string
}

export interface RemoteFile {
  path: string
  text: string
  /** Blob sha. Required to overwrite; a stale one is how a conflict surfaces. */
  sha: string
}

export type SyncErrorKind =
  | 'no-token'
  | 'unauthorized'
  | 'forbidden'
  | 'rate-limited'
  | 'conflict'
  | 'too-large'
  | 'offline'
  | 'unknown'

export class SyncError extends Error {
  // Plain fields, not constructor parameter properties: those are the one bit of
  // TypeScript Node cannot strip, and the tests import this file directly.
  readonly kind: SyncErrorKind
  /** When rate limited, the moment the allowance resets. */
  readonly retryAt?: Date

  constructor(kind: SyncErrorKind, message: string, retryAt?: Date) {
    super(message)
    this.name = 'SyncError'
    this.kind = kind
    this.retryAt = retryAt
  }
}

/** Message for the status line. Every one of these names what to do next. */
export function describe(error: unknown): string {
  if (!(error instanceof SyncError)) {
    return error instanceof Error ? error.message : 'Sync failed'
  }
  switch (error.kind) {
    case 'no-token':
      return 'No token yet — add one in Manage'
    case 'unauthorized':
      return 'Token expired or revoked — issue a new one'
    case 'forbidden':
      return 'That token cannot write to this repository'
    case 'rate-limited':
      return error.retryAt
        ? `GitHub rate limit — try again after ${error.retryAt.toLocaleTimeString()}`
        : 'GitHub rate limit reached'
    case 'conflict':
      return 'Another device wrote first — retrying'
    case 'too-large':
      return 'A file grew past 1MB — chunking needs revisiting'
    case 'offline':
      return 'Offline — changes are saved and will sync later'
    default:
      return error.message
  }
}

/**
 * UTF-8 safe base64.
 *
 * `btoa` throws on anything above U+00FF, so a single Korean meaning breaks it.
 * The bytes have to be produced explicitly.
 */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  // Chunked: spreading a megabyte of bytes into apply() blows the argument limit.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export function fromBase64(base64: string): string {
  const binary = atob(base64.replace(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

const API = 'https://api.github.com'

function classify(status: number, headers: Headers, body: string): SyncError {
  if (status === 401) return new SyncError('unauthorized', 'Bad credentials')
  if (status === 409 || status === 422) return new SyncError('conflict', 'Stale sha')
  if (status === 403 || status === 429) {
    // A 403 is either "no permission" or "rate limited"; the header separates them.
    if (headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(headers.get('x-ratelimit-reset'))
      return new SyncError(
        'rate-limited',
        'Rate limited',
        Number.isFinite(reset) ? new Date(reset * 1000) : undefined,
      )
    }
    return new SyncError('forbidden', 'Forbidden')
  }
  if (status === 413) return new SyncError('too-large', 'File too large')
  return new SyncError('unknown', `GitHub ${status}: ${body.slice(0, 200)}`)
}

export class GitHub {
  private readonly ref: RepoRef

  constructor(ref: RepoRef) {
    if (!ref.token) throw new SyncError('no-token', 'No token')
    this.ref = ref
  }

  private url(path: string): string {
    return `${API}/repos/${this.ref.owner}/${this.ref.repo}/contents/${path}`
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.ref.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }
  }

  private async request(url: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, headers: { ...this.headers(), ...init?.headers } })
    } catch {
      // fetch only rejects on a network failure; every HTTP status resolves.
      throw new SyncError('offline', 'Network unavailable')
    }
  }

  /** The file, or null when it does not exist yet. */
  async get(path: string): Promise<RemoteFile | null> {
    const res = await this.request(`${this.url(path)}?ref=HEAD`)
    if (res.status === 404) return null
    if (!res.ok) throw classify(res.status, res.headers, await res.text())

    const body = (await res.json()) as { content?: string; sha: string; size: number }
    if (body.content === undefined) {
      // Over 1MB the Contents API stops inlining content and only returns metadata.
      throw new SyncError('too-large', `${path} is ${body.size} bytes`)
    }
    return { path, text: fromBase64(body.content), sha: body.sha }
  }

  /** Creates or replaces a file. Omit `sha` to create; pass it to overwrite. */
  async put(path: string, text: string, message: string, sha?: string): Promise<string> {
    const res = await this.request(this.url(path), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, content: toBase64(text), ...(sha ? { sha } : {}) }),
    })
    if (!res.ok) throw classify(res.status, res.headers, await res.text())
    const body = (await res.json()) as { content: { sha: string } }
    return body.content.sha
  }

  /** Confirms the token can reach the repository, and reports write permission. */
  async check(): Promise<{ ok: boolean; canWrite: boolean; message: string }> {
    const res = await this.request(`${API}/repos/${this.ref.owner}/${this.ref.repo}`)
    if (res.status === 404) {
      // A private repo the token cannot see is indistinguishable from a missing
      // one — GitHub deliberately does not confirm that it exists.
      return { ok: false, canWrite: false, message: 'Repository not found, or the token cannot see it' }
    }
    if (!res.ok) {
      const error = classify(res.status, res.headers, await res.text())
      return { ok: false, canWrite: false, message: describe(error) }
    }
    const body = (await res.json()) as { permissions?: { push?: boolean }; full_name: string }
    const canWrite = body.permissions?.push === true
    return {
      ok: true,
      canWrite,
      message: canWrite ? `Connected to ${body.full_name}` : `${body.full_name} — read only`,
    }
  }
}
