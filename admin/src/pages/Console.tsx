import React, { useState, useEffect } from 'react';
import { api } from '../api';

interface UserProfile {
  id?: string;
  username: string;
  displayName: string | null;
  email: string | null;
  isAdmin: boolean;
  isBootstrap?: boolean;
  status?: string;
  roles?: Array<{ id: string; description: string | null }>;
  readSources: string[];
  writeSources: string[];
}

interface ApiKey {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  status: 'active' | 'revoked';
}

export function ConsolePage() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newToken, setNewToken] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [revokingName, setRevokingName] = useState<string | null>(null);

  const loadAll = () => {
    setLoading(true);
    Promise.all([
      api.me().then(setProfile).catch(() => {}),
      api.meApiKeys().then(setApiKeys).catch(() => {}),
    ]).finally(() => setLoading(false));
  };

  useEffect(() => { loadAll(); }, []);

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!newKeyName.trim()) return;
    setCreating(true);
    try {
      const result = await api.meCreateApiKey(newKeyName.trim());
      setNewToken(result.token);
      setNewKeyName('');
      loadAll(); // refresh list
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create API key');
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (name: string) => {
    if (!confirm(`Revoke API key "${name}"? This cannot be undone.`)) return;
    setRevokingName(name);
    setError('');
    try {
      await api.meRevokeApiKey(name);
      loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Revoke failed');
    } finally {
      setRevokingName(null);
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
  };

  if (loading) {
    return (
      <div style={{ padding: 24, color: 'var(--text-muted)' }}>
        Loading...
      </div>
    );
  }

  return (
    <>
      <h1 className="page-title">Console</h1>

      {error && (
        <div className="warning-bar" style={{ marginBottom: 16 }}>
          {error}
          <button
            onClick={() => setError('')}
            style={{ float: 'right', background: 'none', border: 'none', color: 'var(--warning)', cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>
      )}

      {/* ── Profile ── */}
      <div className="health-panel" style={{ marginBottom: 24 }}>
        <div className="section-title">Profile</div>
        {profile ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
              <span style={{ color: 'var(--text-muted)' }}>Username</span>
              <span style={{ fontWeight: 500 }}>{profile.username}</span>
            </div>
            {profile.displayName && (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
                <span style={{ color: 'var(--text-muted)' }}>Display Name</span>
                <span>{profile.displayName}</span>
              </div>
            )}
            {profile.email && (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
                <span style={{ color: 'var(--text-muted)' }}>Email</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{profile.email}</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
              <span style={{ color: 'var(--text-muted)' }}>Role</span>
              <span>
                {profile.isAdmin ? (
                  <span className="badge badge-admin">Admin</span>
                ) : (
                  <span className="badge badge-read">User</span>
                )}
              </span>
            </div>
            {profile.roles && profile.roles.length > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
                <span style={{ color: 'var(--text-muted)' }}>Assigned Roles</span>
                <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {profile.roles.map(r => (
                    <span key={r.id} className="badge badge-read" title={r.description ?? ''}>
                      {r.id}{r.description ? ` (${r.description})` : ''}
                    </span>
                  ))}
                </span>
              </div>
            )}
          </div>
        ) : (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '8px 0' }}>
            Unable to load profile.
          </div>
        )}
      </div>

      {/* ── API Keys ── */}
      <div className="health-panel">
        <div className="section-title">Your API Keys</div>

        {newToken && (
          <div style={{
            background: 'rgba(34,197,94,0.1)',
            border: '1px solid var(--success)',
            borderRadius: 8,
            padding: '12px 16px',
            marginBottom: 16,
          }}>
            <div style={{ fontWeight: 600, color: 'var(--success)', marginBottom: 8 }}>
              ✓ API key created! Copy it now — it won't be shown again.
            </div>
            <div className="code-block" style={{ position: 'relative' }}>
              <code style={{ fontSize: 13, wordBreak: 'break-all' }}>{newToken}</code>
              <button
                className="copy-btn"
                onClick={() => handleCopy(newToken!)}
              >
                Copy
              </button>
            </div>
          </div>
        )}

        <form onSubmit={handleCreateKey} style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
          <input
            type="text"
            placeholder="Key name (e.g. my-laptop)"
            value={newKeyName}
            onChange={e => setNewKeyName(e.target.value)}
            style={{ maxWidth: 260 }}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={creating || !newKeyName.trim()}
          >
            {creating ? 'Creating...' : 'Create API Key'}
          </button>
        </form>

        {apiKeys.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '8px 0' }}>
            No API keys yet. Create one above.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Created</th>
                <th>Last Used</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {apiKeys.map(k => (
                <tr key={k.id}>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{k.name}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {new Date(k.created_at).toLocaleDateString()}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}
                  </td>
                  <td>
                    <span className={`badge ${k.status === 'active' ? 'badge-success' : 'badge-error'}`}>
                      {k.status}
                    </span>
                  </td>
                  <td>
                    {k.status === 'active' && (
                      <button
                        className="btn btn-danger"
                        style={{ fontSize: 11, padding: '3px 10px' }}
                        disabled={revokingName === k.name}
                        onClick={() => handleRevoke(k.name)}
                      >
                        {revokingName === k.name ? '...' : 'Revoke'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}