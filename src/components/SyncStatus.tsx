import { useEffect } from 'react'
import { useStore } from '#src/store/useStore.ts'

/**
 * The sync state, always on screen.
 *
 * Automatic sync that cannot be observed is worse than manual sync: a silent
 * failure is indistinguishable from success, and an expired token found weeks
 * later is the worst version of that. Syncing may succeed quietly; it may never
 * fail quietly.
 *
 * The pending count is a number on purpose. "3 changes pending" is checkable;
 * "sync may be delayed" is not.
 */
export default function SyncStatus() {
  const { sync, syncNow, refreshPending, configured } = useStore()

  useEffect(() => {
    void refreshPending()
  }, [refreshPending])

  if (!configured) return null

  const tone =
    sync.error && sync.errorKind !== 'offline'
      ? 'text-red-600'
      : sync.pending > 0 || sync.error
        ? 'opacity-70'
        : 'opacity-40'

  return (
    <button
      className={`flex w-full items-center justify-center gap-1.5 py-1 text-xs ${tone}`}
      onClick={() => void syncNow()}
      disabled={sync.running}
      title="Sync now"
    >
      {sync.running ? (
        <>Syncing…</>
      ) : sync.error ? (
        <>{sync.error}</>
      ) : sync.pending > 0 ? (
        <>
          {sync.pending} change{sync.pending === 1 ? '' : 's'} pending
        </>
      ) : sync.lastSyncAt ? (
        <>Synced {ago(sync.lastSyncAt)}</>
      ) : (
        <>Not synced yet</>
      )}
    </button>
  )
}

function ago(iso: string): string {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000
  if (seconds < 60) return 'just now'
  const minutes = seconds / 60
  if (minutes < 60) return `${Math.round(minutes)} min ago`
  const hours = minutes / 60
  if (hours < 24) return `${Math.round(hours)}h ago`
  return `${Math.round(hours / 24)}d ago`
}
