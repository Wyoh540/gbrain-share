import React, { useState, useEffect } from 'react';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { AgentsPage } from './pages/Agents';
import { RequestLogPage } from './pages/RequestLog';
import { CalibrationPage } from './pages/Calibration';
import { JobsWatchPage } from './pages/JobsWatch';
import { UsersPage } from './pages/Users';
import { RolesPage } from './pages/Roles';
import { SourcesPage } from './pages/Sources';
import { ConsolePage } from './pages/Console';
import { api } from './api';

type Page = 'login' | 'dashboard' | 'agents' | 'log' | 'calibration' | 'jobs' | 'users' | 'roles' | 'sources' | 'console';

const ADMIN_ONLY: Page[] = ['dashboard', 'agents', 'log', 'calibration', 'jobs', 'users', 'roles'];

function getPage(): Page {
  const hash = window.location.hash.replace('#', '') || 'dashboard';
  if (['login', 'dashboard', 'agents', 'log', 'calibration', 'jobs', 'users', 'roles', 'sources', 'console'].includes(hash)) return hash as Page;
  return 'dashboard';
}

export function App() {
  const [page, setPage] = useState<Page>(getPage);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null); // null = loading

  // On mount (when not on login page), fetch user role
  useEffect(() => {
    if (getPage() === 'login') return;
    api.me()
      .then((profile: any) => setIsAdmin(profile.isAdmin === true))
      .catch(() => {
        // 401 → unauthenticated; redirect to login
        // Other errors → assume non-admin
        setIsAdmin(false);
      });
  }, []);

  // Redirect non-admin away from admin-only pages
  useEffect(() => {
    if (isAdmin === false && ADMIN_ONLY.includes(page)) {
      window.location.hash = 'console';
      setPage('console');
    }
  }, [isAdmin, page]);

  useEffect(() => {
    const onHash = () => {
      const p = getPage();
      // Block admin-only pages for non-admin (defense-in-depth)
      if (isAdmin === false && ADMIN_ONLY.includes(p)) {
        window.location.hash = 'console';
        setPage('console');
        return;
      }
      setPage(p);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [isAdmin]);

  const navigate = (p: Page) => {
    if (isAdmin === false && ADMIN_ONLY.includes(p)) {
      p = 'console';
    }
    window.location.hash = p;
    setPage(p);
  };

  if (page === 'login') {
    return <LoginPage onLogin={(admin: boolean) => {
      setIsAdmin(admin);
      navigate(admin ? 'dashboard' : 'console');
    }} />;
  }

  // Show loading while checking role
  if (isAdmin === null) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: 'var(--bg-primary)', color: 'var(--text-muted)' }}>
        Loading...
      </div>
    );
  }

  const handleSignOut = async () => {
    if (isAdmin) {
      if (!confirm('Sign out every active admin session, including other browsers and tabs? Each one will need to re-authenticate via a fresh magic link.')) {
        return;
      }
      try { await api.signOutEverywhere(); } catch { /* cookie likely invalid */ }
    }
    navigate('login');
  };

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="sidebar-logo">GBrain</div>
        <div className="sidebar-nav">
          {isAdmin && (
            <>
              <a className={`nav-item ${page === 'dashboard' ? 'active' : ''}`}
                 onClick={() => navigate('dashboard')}>Dashboard</a>
              <a className={`nav-item ${page === 'agents' ? 'active' : ''}`}
                 onClick={() => navigate('agents')}>Agents</a>
              <a className={`nav-item ${page === 'log' ? 'active' : ''}`}
                 onClick={() => navigate('log')}>Request Log</a>
              <a className={`nav-item ${page === 'calibration' ? 'active' : ''}`}
                 onClick={() => navigate('calibration')}>Calibration</a>
              <a className={`nav-item ${page === 'jobs' ? 'active' : ''}`}
                 onClick={() => navigate('jobs')}>Jobs Watch</a>
              <a className={`nav-item ${page === 'users' ? 'active' : ''}`}
                 onClick={() => navigate('users')}>Users</a>
              <a className={`nav-item ${page === 'roles' ? 'active' : ''}`}
                 onClick={() => navigate('roles')}>Roles</a>
            </>
          )}
          <a className={`nav-item ${page === 'sources' ? 'active' : ''}`}
             onClick={() => navigate('sources')}>Sources</a>
          <a className={`nav-item ${page === 'console' ? 'active' : ''}`}
             onClick={() => navigate('console')}>Console</a>
        </div>
        <div style={{ marginTop: 'auto', padding: '16px 12px', borderTop: '1px solid var(--border)' }}>
          <button
            onClick={handleSignOut}
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--text-secondary)',
              padding: '6px 10px',
              borderRadius: 6,
              fontSize: 12,
              cursor: 'pointer',
              width: '100%',
            }}
            title={isAdmin ? 'Revoke every active admin session' : 'Sign out'}
          >
            {isAdmin ? 'Sign out everywhere' : 'Sign out'}
          </button>
        </div>
      </nav>
      <main className="main">
        {page === 'dashboard' && isAdmin && <DashboardPage />}
        {page === 'agents' && isAdmin && <AgentsPage />}
        {page === 'log' && isAdmin && <RequestLogPage />}
        {page === 'calibration' && isAdmin && <CalibrationPage />}
        {page === 'jobs' && isAdmin && <JobsWatchPage />}
        {page === 'users' && isAdmin && <UsersPage />}
        {page === 'roles' && isAdmin && <RolesPage />}
        {page === 'sources' && <SourcesPage isAdmin={isAdmin} />}
        {page === 'console' && <ConsolePage />}
      </main>
    </div>
  );
}
