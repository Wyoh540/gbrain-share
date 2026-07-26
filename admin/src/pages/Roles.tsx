import React, { useState, useEffect } from 'react';
import { api } from '../api';

interface Role {
  id: string;
  description?: string;
  sources: Record<string, 'read' | 'write'>;
  memberCount: number;
}

interface Source {
  id: string;
  name: string;
}

export function RolesPage() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newRoleId, setNewRoleId] = useState('');
  const [newRoleDesc, setNewRoleDesc] = useState('');
  const [grants, setGrants] = useState<Record<string, 'none' | 'read' | 'write'>>({});

  const fetchData = async () => {
    setError('');
    try {
      const [rolesData, sourcesData] = await Promise.all([
        api.listRoles(),
        api.listSources(),
      ]);
      setRoles(rolesData.roles || []);
      setSources(sourcesData.sources || []);
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    }
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

  const selected = roles.find(r => r.id === selectedId);

  const handleSelect = (id: string) => {
    setSelectedId(id);
    const r = roles.find(ro => ro.id === id);
    if (!r) { setGrants({}); return; }
    const g: Record<string, 'none' | 'read' | 'write'> = {};
    for (const s of sources) {
      g[s.id] = r.sources[s.id] || 'none';
    }
    setGrants(g);
  };

  const handleSaveGrants = async () => {
    if (!selectedId) return;
    const grantList = Object.entries(grants)
      .filter(([, v]) => v !== 'none')
      .map(([sourceId, access]) => ({ sourceId, access: access as 'read' | 'write' }));
    try {
      await api.setRoleSources(selectedId, grantList);
      fetchData();
    } catch (e: any) { setError(e.message); }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.createRole(newRoleId, newRoleDesc || undefined);
      setShowCreate(false); setNewRoleId(''); setNewRoleDesc('');
      fetchData();
    } catch (e: any) { setError(e.message); }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm(`Delete role "${id}"?`)) return;
    try {
      await api.deleteRole(id);
      if (selectedId === id) setSelectedId(null);
      fetchData();
    } catch (e: any) { setError(e.message); }
  };

  const cycleAccess = (sourceId: string) => {
    setGrants(prev => {
      const current = prev[sourceId] || 'none';
      const next = current === 'none' ? 'read' : current === 'read' ? 'write' : 'none';
      return { ...prev, [sourceId]: next };
    });
  };

  if (loading) return <div style={{ padding: 24, color: 'var(--text-secondary)' }}>Loading…</div>;

  return (
    <div style={{ padding: 24, display: 'flex', gap: 24 }}>
      {/* Left: role list */}
      <div style={{ minWidth: 240, maxWidth: 280 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Roles</h2>
          <button className="btn btn-secondary"
            onClick={() => setShowCreate(!showCreate)}
            style={{ fontSize: 13, padding: '4px 12px' }}>
            {showCreate ? 'Cancel' : '+ New'}
          </button>
        </div>

        {error && <div style={{ background: 'var(--error)', color: '#fff', padding: '8px 12px', borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{error}</div>}

        {showCreate && (
          <form onSubmit={handleCreate} style={{ marginBottom: 12, background: 'var(--bg-secondary)', padding: 12, borderRadius: 6, border: '1px solid var(--border)' }}>
            <input placeholder="Role ID (e.g. sales)" value={newRoleId} onChange={e => setNewRoleId(e.target.value)} required
              style={{ width: '100%', marginBottom: 6, padding: '6px 8px', borderRadius: 4, border: '1px solid var(--border)', fontSize: 13, boxSizing: 'border-box', background: 'var(--bg-primary)', color: 'var(--text-primary)' }} />
            <input placeholder="Description (optional)" value={newRoleDesc} onChange={e => setNewRoleDesc(e.target.value)}
              style={{ width: '100%', marginBottom: 8, padding: '6px 8px', borderRadius: 4, border: '1px solid var(--border)', fontSize: 13, boxSizing: 'border-box', background: 'var(--bg-primary)', color: 'var(--text-primary)' }} />
            <button type="submit" className="btn btn-primary" style={{ fontSize: 13, padding: '4px 14px' }}>Create</button>
          </form>
        )}

        {roles.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>
            No roles yet. Create one to get started.
          </div>
        ) : (
          roles.map(r => (
            <div key={r.id}
              onClick={() => handleSelect(r.id)}
              style={{
                padding: '10px 12px', cursor: 'pointer', borderRadius: 6, marginBottom: 4,
                background: selectedId === r.id ? 'var(--accent)' : 'transparent',
                border: selectedId === r.id ? '1px solid var(--accent)' : '1px solid transparent',
                color: selectedId === r.id ? '#fff' : 'var(--text-primary)',
              }}>
              <div style={{ fontWeight: 500, fontSize: 14 }}>{r.id}</div>
              <div style={{ fontSize: 12, opacity: selectedId === r.id ? 0.8 : 0.7 }}>
                {r.description || ''}{r.description ? ' · ' : ''}{r.memberCount} member{r.memberCount !== 1 ? 's' : ''}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Right: source matrix */}
      <div style={{ flex: 1 }}>
        {selected ? (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>{selected.id}</h3>
              <button onClick={() => handleDelete(selected.id)}
                style={{ padding: '4px 10px', fontSize: 12, borderRadius: 4, border: '1px solid var(--error)', color: 'var(--error)', cursor: 'pointer', background: 'transparent' }}>
                Delete
              </button>
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
              {selected.description || 'No description'} · {selected.memberCount} member{selected.memberCount !== 1 ? 's' : ''}
            </p>

            {sources.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', padding: 20, textAlign: 'center' }}>
                No sources configured. Add sources before assigning permissions.
              </div>
            ) : (
              <>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid var(--border)', textAlign: 'left' }}>
                      <th style={{ padding: '8px 12px', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600 }}>Source</th>
                      <th style={{ padding: '8px 12px', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600 }}>Access</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sources.map(s => (
                      <tr key={s.id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '8px 12px', fontWeight: 500 }}>{s.name || s.id}</td>
                        <td style={{ padding: '8px 12px' }}>
                          <button onClick={() => cycleAccess(s.id)}
                            className={`badge ${grants[s.id] === 'write' ? 'badge-write' : grants[s.id] === 'read' ? 'badge-read' : ''}`}
                            style={{
                              padding: '4px 12px', fontSize: 12, borderRadius: 4, cursor: 'pointer', border: '1px solid var(--border)',
                              background: grants[s.id] === 'write' ? 'var(--success)' : grants[s.id] === 'read' ? 'var(--accent)' : 'var(--bg-secondary)',
                              color: grants[s.id] !== 'none' ? '#fff' : 'var(--text-secondary)',
                            }}>
                            {grants[s.id] || 'none'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <button onClick={handleSaveGrants}
                  className="btn btn-primary"
                  style={{ marginTop: 16 }}>
                  Save Permissions
                </button>
              </>
            )}
          </div>
        ) : (
          <div style={{ color: 'var(--text-muted)', padding: 40, textAlign: 'center' }}>
            Select a role to edit its permissions
          </div>
        )}
      </div>
    </div>
  );
}
