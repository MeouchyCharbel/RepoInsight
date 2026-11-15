import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { AuthProvider, RequireAuth } from './auth';
import { AskPage } from './pages/Ask';
import { DocPage } from './pages/Doc';
import { IssuePage } from './pages/Issue';
import { LoginPage } from './pages/Login';
import { RepoPage } from './pages/Repo';
import { ReposPage } from './pages/Repos';
import { SearchPage } from './pages/Search';
import './styles.css';
import { Layout } from './ui';

const guarded = (el: React.ReactNode) => <RequireAuth>{el}</RequireAuth>;

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/', element: guarded(<ReposPage />) },
      { path: '/search', element: guarded(<SearchPage />) },
      { path: '/ask', element: guarded(<AskPage />) },
      { path: '/repos/:repoId', element: guarded(<RepoPage />) },
      { path: '/repos/:repoId/issues/:number', element: guarded(<IssuePage />) },
      { path: '/repos/:repoId/doc', element: guarded(<DocPage />) },
      { path: '*', element: <p className="muted">Page not found.</p> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </StrictMode>,
);
