import { useState } from 'react'
import { GitHub, describe as describeError } from '#src/lib/github.ts'
import { clearRepoRef, getStoredRepo, setRepoRef } from '#src/lib/sync.ts'
import { useStore } from '#src/store/useStore.ts'

/**
 * Connecting a device.
 *
 * Entered once per device: each gets its own token so one can be revoked alone
 * if a phone is lost. The token goes to localStorage and never to IndexedDB —
 * IndexedDB is what the JSON export copies and what sync itself reads.
 */
export default function SyncSettings() {
  const { configured, reloadConfig, sync, syncNow } = useStore()
  const [repo, setRepo] = useState(getStoredRepo() || 'seming/card-box-data')
  const [token, setToken] = useState('')
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  async function connect() {
    const [owner, name] = repo.trim().split('/')
    if (!owner || !name || !token.trim()) {
      setResult({ ok: false, message: 'Need owner/repo and a token' })
      return
    }
    setChecking(true)
    setResult(null)
    try {
      // Checked before storing, so a typo is caught here rather than surfacing
      // as a failed sync hours later.
      const check = await new GitHub({ owner, repo: name, token: token.trim() }).check()
      if (!check.ok) return setResult({ ok: false, message: check.message })
      if (!check.canWrite) {
        return setResult({ ok: false, message: `${check.message}. Contents needs Read and write.` })
      }
      setRepoRef(owner, name, token.trim())
      setToken('')
      reloadConfig()
      setResult({ ok: true, message: check.message })
    } catch (error) {
      setResult({ ok: false, message: describeError(error) })
    } finally {
      setChecking(false)
    }
  }

  function disconnect() {
    clearRepoRef()
    reloadConfig()
    setResult(null)
  }

  return (
    <section className="space-y-3 rounded-lg border border-[var(--line)] p-4 text-sm">
      <div className="flex items-baseline justify-between">
        <h2 className="font-medium">Sync</h2>
        {configured && (
          <button className="text-xs opacity-50 underline underline-offset-2" onClick={disconnect}>
            Disconnect
          </button>
        )}
      </div>

      {configured ? (
        <>
          <p className="text-xs opacity-60">
            Connected to <code>{getStoredRepo()}</code>. Every sync is a commit, so the repository's
            history shows what changed and when — whether or not this screen is telling the truth.
          </p>
          <div className="flex items-center gap-3">
            <button
              className="rounded bg-[var(--accent)] px-4 py-2 text-[var(--on-accent)] disabled:opacity-40"
              disabled={sync.running}
              onClick={() => void syncNow()}
            >
              {sync.running ? 'Syncing…' : 'Sync now'}
            </button>
            <span className="text-xs opacity-60">
              {sync.error ?? (sync.pending > 0 ? `${sync.pending} pending` : 'Up to date')}
            </span>
          </div>
        </>
      ) : (
        <>
          <p className="text-xs opacity-60">
            A private repository holds the cards and the review log. Reviewing never waits for it —
            answers are saved locally first, and a sync only copies what is already safe.
          </p>
          <label className="block space-y-1">
            <span className="opacity-60">Repository</span>
            <input
              className="w-full rounded border border-[var(--line)] px-3 py-2"
              placeholder="owner/repo"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className="opacity-60">Fine-grained token</span>
            <input
              type="password"
              className="w-full rounded border border-[var(--line)] px-3 py-2"
              placeholder="github_pat_…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <button
            className="rounded bg-[var(--accent)] px-4 py-2 text-[var(--on-accent)] disabled:opacity-40"
            disabled={checking}
            onClick={() => void connect()}
          >
            {checking ? 'Checking…' : 'Connect'}
          </button>
          <p className="text-xs opacity-40">
            Contents: Read and write, scoped to that repository only. Stored on this device, never
            in the exported data.
          </p>
        </>
      )}

      {result && (
        <p className={`text-xs ${result.ok ? 'opacity-60' : 'text-red-600'}`}>{result.message}</p>
      )}
    </section>
  )
}
