import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import './index.css'
import AppShell from '#src/pages/AppShell.tsx'
import TodayPage from '#src/pages/TodayPage.tsx'
import ReviewPage from '#src/pages/ReviewPage.tsx'
import ManagePage from '#src/pages/ManagePage.tsx'
import ImportPage from '#src/pages/ImportPage.tsx'
import StatsPage from '#src/pages/StatsPage.tsx'
import BrowsePage from '#src/pages/BrowsePage.tsx'

// `basename` matches vite's `base` so the routes work under /cardbox/ on Pages.
const router = createBrowserRouter(
  [
    {
      path: '/',
      element: <AppShell />,
      children: [
        { index: true, element: <TodayPage /> },
        { path: 'review', element: <ReviewPage /> },
        { path: 'review/:deckId', element: <ReviewPage /> },
        { path: 'browse', element: <BrowsePage /> },
        { path: 'stats', element: <StatsPage /> },
        { path: 'import', element: <ImportPage /> },
        { path: 'manage', element: <ManagePage /> },
      ],
    },
  ],
  { basename: import.meta.env.BASE_URL.replace(/\/$/, '') },
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
