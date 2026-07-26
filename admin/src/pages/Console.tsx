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
  token?: string | null;
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
  const [visibleTokens, setVisibleTokens] = useState<Set<string>>(new Set());
  const [configGuideKey, setConfigGuideKey] = useState<string | null>(null);
  const [configTab, setConfigTab] = useState<'claude-code' | 'cursor' | 'generic'>('claude-code');

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
    if (!confirm(`Delete API key "${name}"? This cannot be undone.`)) return;
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
                <th>Token</th>
                <th>Created</th>
                <th>Last Used</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {apiKeys.map(k => {
                const isVisible = visibleTokens.has(k.id);
                const token = k.token || null;
                return (
                <tr key={k.id}>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{k.name}</td>
                  <td style={{ maxWidth: 320 }}>
                    {token ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {isVisible && (
                          <code style={{
                            fontSize: 11,
                            wordBreak: 'break-all',
                            userSelect: 'all',
                            flex: 1,
                            minWidth: 0,
                          }}>
                            {token}
                          </code>
                        )}
                        <button
                          className="btn btn-secondary"
                          style={{ fontSize: 10, padding: '2px 8px', whiteSpace: 'nowrap', flexShrink: 0 }}
                          onClick={() => {
                            setVisibleTokens(prev => {
                              const next = new Set(prev);
                              if (next.has(k.id)) next.delete(k.id); else next.add(k.id);
                              return next;
                            });
                          }}
                        >
                          {isVisible ? 'Hide' : 'Show'}
                        </button>
                        {isVisible && (
                          <button
                            className="btn btn-secondary"
                            style={{ fontSize: 10, padding: '2px 8px', whiteSpace: 'nowrap', flexShrink: 0 }}
                            onClick={() => handleCopy(token)}
                          >
                            Copy
                          </button>
                        )}
                      </div>
                    ) : (
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>N/A</span>
                    )}
                  </td>
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
                    <div style={{ display: 'flex', gap: 6 }}>
                      {k.status === 'active' && token && (
                        <button
                          className="btn btn-secondary"
                          style={{ fontSize: 11, padding: '3px 10px' }}
                          onClick={() => setConfigGuideKey(configGuideKey === k.id ? null : k.id)}
                        >
                          {configGuideKey === k.id ? 'Hide Guide' : 'Config'}
                        </button>
                      )}
                      {k.status === 'active' && (
                        <button
                          className="btn btn-danger"
                          style={{ fontSize: 11, padding: '3px 10px' }}
                          disabled={revokingName === k.name}
                          onClick={() => handleRevoke(k.name)}
                        >
                          {revokingName === k.name ? '...' : 'Delete'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );})}
            </tbody>
          </table>
        )}

        {/* ── Connection Config Guide ── */}
        {configGuideKey && (() => {
          const key = apiKeys.find(k => k.id === configGuideKey);
          if (!key || !key.token) return null;
          const serverUrl = window.location.origin;
          const token = key.token;
          const snippets: Record<string, string> = {
            'claude-code': [
              `# Add GBrain MCP to Claude Code`,
              `claude mcp add --transport http gbrain ${serverUrl}/mcp \\`,
              `  --header "Authorization: Bearer ${token}"`,
            ].join('\n'),
            cursor: [
              `// Add to .cursor/mcp.json:`,
              `{`,
              `  "mcpServers": {`,
              `    "gbrain": {`,
              `      "url": "${serverUrl}/mcp",`,
              `      "transport": "sse",`,
              `      "headers": {`,
              `        "Authorization": "Bearer ${token}"`,
              `      }`,
              `    }`,
              `  }`,
              `}`,
            ].join('\n'),
            generic: `Authorization: Bearer ${token}`,
          };
          return (
            <div style={{
              marginTop: 16,
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '16px 20px',
            }}>
              <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 14 }}>
                Connection Guide — <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>{key.name}</span>
              </div>
              <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 12 }}>
                Use this API key to connect your local MCP client. The config snippets below include your token.
              </p>
              <div className="tabs" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
                {(['claude-code', 'cursor', 'generic'] as const).map(tab => (
                  <div
                    key={tab}
                    className={`tab ${configTab === tab ? 'active' : ''}`}
                    onClick={() => setConfigTab(tab)}
                    style={{ textTransform: 'capitalize' }}
                  >
                    {tab === 'claude-code' ? 'Claude Code' : tab === 'cursor' ? 'Cursor' : 'Generic'}
                  </div>
                ))}
              </div>
              <div className="code-block" style={{ position: 'relative' }}>
                <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 }}>
                  {snippets[configTab]}
                </pre>
                <button className="copy-btn" onClick={() => handleCopy(snippets[configTab])}>
                  Copy
                </button>
              </div>
            </div>
          );
        })()}
      </div>
    </>
  );
}