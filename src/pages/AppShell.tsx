import { useEffect } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useStore } from '#src/store/useStore.ts'

/**
 * Mobile-first shell: content scrolls, navigation sits at the bottom within
 * thumb reach and inside the iOS home-indicator inset.
 */

const TABS = [
  { to: '/', label: 'Today', end: true },
  { to: '/import', label: 'Import', end: false },
  { to: '/manage', label: 'Manage', end: false },
]

export default function AppShell() {
  const load = useStore((s) => s.load)
  const ready = useStore((s) => s.ready)

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="flex min-h-dvh flex-col">
      {/* flex-col so a page can claim the full height and pin its controls low. */}
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-5 pt-6 pb-28">
        {ready ? <Outlet /> : <p className="text-sm opacity-50">Loading…</p>}
      </main>

      <nav
        className="fixed inset-x-0 bottom-0 border-t border-black/10 bg-paper/95 backdrop-blur"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="mx-auto flex max-w-2xl">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) =>
                `flex-1 py-4 text-center text-sm ${isActive ? 'font-semibold' : 'opacity-50'}`
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  )
}
