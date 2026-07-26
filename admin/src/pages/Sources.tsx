import React, { useState, useEffect } from 'react';
import { api } from '../api';

interface Source {
  id: string;
  name: string;
  local_path?: string | null;
  remote_url?: string | null;
  federated?: boolean;
  page_count?: number;
  last_sync_at?: string | null;
  last_synced_at?: string | null;
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'Never';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function syncStatus(iso: string | null): { label: string; className: string } {
  if (!iso) return { label: 'Never', className: 'badge-error' };
  const hours = (Date.now() - new Date(iso).getTime()) / 3600000;
  if (hours < 1) return { label: 'Current', className: 'badge-success' };
  if (hours < 24) return { label: `${Math.floor(hours)}h ago`, className: 'badge-read' };
  return { label: `${Math.floor(hours / 24)}d ago`, className: 'badge-write' };
}

export function SourcesPage({ isAdmin }: { isAdmin: boolean }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchSources = async () => {
    setError('');
    try {
      if (isAdmin) {
        // Admin: full source list from admin API
        const data = await api.listSources();
        setSources(data.sources || []);
      } else {
        // Non-admin: only sources this user has permission to access
        const data = await api.meSources();
        setSources(Array.isArray(data) ? data : []);
      }
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  useEffect(() => { fetchSources(); }, [isAdmin]);

  if (loading) return <div style={{ padding: 24, color: 'var(--text-secondary)' }}>Loading…</div>;

  // Resolve last-sync field: admin API uses last_sync_at, user API uses last_synced_at from listSources()
  const syncField = (s: Source): string | null => (s.last_sync_at ?? s.last_synced_at) ?? null;

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>Sources</h1>
      </div>

      {error && (
        <div style={{ background: 'var(--error)', color: '#fff', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{error}</span>
          <button onClick={() => setError('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#fff', fontSize: 16, padding: 0, lineHeight: 1 }}>×</button>
        </div>
      )}

      {!isAdmin && sources.length > 0 && (
        <div style={{
          background: 'rgba(136, 170, 255, 0.08)',
          border: '1px solid rgba(136, 170, 255, 0.2)',
          borderRadius: 8,
          padding: '10px 14px',
          marginBottom: 16,
          fontSize: 13,
          color: 'var(--text-secondary)',
        }}>
          Showing {sources.length} data source{sources.length !== 1 ? 's' : ''} you have permission to access.
        </div>
      )}

      {sources.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
          {isAdmin ? (
            <>No sources registered. Run <code style={{ background: 'var(--bg-secondary)', padding: '2px 6px', borderRadius: 3 }}>gbrain sources add</code> to get started.</>
          ) : (
            <>No data sources assigned to your account. Contact an administrator to request access.</>
          )}
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>ID</th>
              <th>Pages</th>
              <th>Last Sync</th>
              <th>Remote URL</th>
              <th>Federated</th>
            </tr>
          </thead>
          <tbody>
            {sources.map(s => {
              const st = syncStatus(syncField(s));
              return (
                <tr key={s.id}>
                  <td style={{ fontWeight: 500 }}>{s.name}</td>
                  <td>
                    <code style={{ fontSize: 12, background: 'var(--bg-secondary)', padding: '2px 6px', borderRadius: 3 }}>{s.id}</code>
                  </td>
                  <td>
                    <span style={{ fontWeight: 500 }}>{s.page_count ?? 0}</span>
                  </td>
                  <td>
                    <span className={`badge ${st.className}`} title={syncField(s) || 'Never synced'}>
                      {st.label}
                    </span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 6 }}>
                      {timeAgo(syncField(s))}
                    </span>
                  </td>
                  <td>
                    {s.remote_url ? (
                      <code style={{ fontSize: 12, color: 'var(--text-secondary)' }} title={s.remote_url}>
                        {s.remote_url.length > 40 ? s.remote_url.slice(0, 40) + '…' : s.remote_url}
                      </code>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                  </td>
                  <td>
                    {s.federated ? (
                      <span className="badge badge-success">federated</span>
                    ) : (
                      <span className="badge" style={{ color: 'var(--text-muted)' }}>isolated</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 12 }}>
        {sources.reduce((sum, s) => sum + (s.page_count || 0), 0)} total pages across {sources.length} source{sources.length !== 1 ? 's' : ''}
      </div>
    </div>
  );
}
