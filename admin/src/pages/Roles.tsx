import React, { useState, useEffect } from 'react';
import { api } from '../api';

interface Role {
  id: string;
  description?: string;
  sources: Record<string, 'read' | 'write'>;
  memberCount: number;
}

export function RolesPage() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newRoleId, setNewRoleId] = useState('');
  const [newRoleDesc, setNewRoleDesc] = useState('');
  const [grants, setGrants] = useState<Record<string, 'none' | 'read' | 'write'>>({});
  const allSourceIds = ['default', 'shared', 'customers', 'internal'];

  const fetchRoles = async () => {
    try {
      const data = await api.listRoles();
      setRoles(data.roles || []);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  useEffect(() => { fetchRoles(); }, []);

  const selected = roles.find(r => r.id === selectedId);

  const handleSelect = (id: string) => {
    setSelectedId(id);
    const r = roles.find(r => r.id === id);
    if (!r) { setGrants({}); return; }
    const g: Record<string, 'none' | 'read' | 'write'> = {};
    for (const sid of allSourceIds) {
      g[sid] = r.sources[sid] || 'none';
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
      fetchRoles();
    } catch (e: any) { setError(e.message); }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.createRole(newRoleId, newRoleDesc || undefined);
      setShowCreate(false); setNewRoleId(''); setNewRoleDesc('');
      fetchRoles();
    } catch (e: any) { setError(e.message); }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm(`Delete role "${id}"?`)) return;
    try {
      await api.deleteRole(id);
      if (selectedId === id) setSelectedId(null);
      fetchRoles();
    } catch (e: any) { setError(e.message); }
  };

  const cycleAccess = (sourceId: string) => {
    setGrants(prev => {
      const current = prev[sourceId] || 'none';
      const next = current === 'none' ? 'read' : current === 'read' ? 'write' : 'none';
      return { ...prev, [sourceId]: next };
    });
  };

  axios: string; // prevent ts unused import warning

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div style={{ padding: 24, display: 'flex', gap: 24 }}>
      {/* Left: role list */}
      <div style={{ minWidth: 240 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Roles</h2>
          <button onClick={() => setShowCreate(!showCreate)} style={{ padding: '6px 16px', background: '#111', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
            {showCreate ? 'Cancel' : '+ New'}
          </button>
        </div>

        {error && <div style={{ background: '#fef2f2', color: '#991b1b', padding: '8px 12px', borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{error}</div>}

        {showCreate && (
          <form onSubmit={handleCreate} style={{ marginBottom: 12, background: '#f9fafb', padding: 12, borderRadius: 6 }}>
            <input placeholder="Role ID" value={newRoleId} onChange={e => setNewRoleId(e.target.value)} required style={{ width: '100%', marginBottom: 6, padding: '6px 8px', borderRadius: 4, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' }} />
            <input placeholder="Description" value={newRoleDesc} onChange={e => setNewRoleDesc(e.target.value)} style={{ width: '100%', marginBottom: 6, padding: '6px 8px', borderRadius: 4, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' }} />
            <button type="submit" style={{ padding: '6px 16px', background: '#111', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>Create</button>
          </form>
        )}

        {roles.map(r => (
          <div key={r.id}
            onClick={() => handleSelect(r.id)}
            style={{
              padding: '10px 12px', cursor: 'pointer', borderRadius: 6, marginBottom: 4,
              background: selectedId === r.id ? '#eff6ff' : 'transparent',
              border: selectedId === r.id ? '1px solid #3b82f6' : '1px solid transparent',
            }}>
            <div style={{ fontWeight: 500, fontSize: 14 }}>{r.id}</div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{r.description || ''} · {r.memberCount} members</div>
          </div>
        ))}
      </div>

      {/* Right: source matrix */}
      <div style={{ flex: 1 }}>
        {selected ? (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>{selected.id}</h3>
              <button onClick={() => handleDelete(selected.id)}
                style={{ padding: '4px 10px', fontSize: 12, borderRadius: 4, border: '1px solid #ef4444', color: '#dc2626', cursor: 'pointer', background: '#fff' }}>
                Delete
              </button>
            </div>
            <p style={{ color: '#6b7280', fontSize: 13, marginBottom: 16 }}>{selected.description || 'No description'} · {selected.memberCount} members</p>

            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #e5e7eb', textAlign: 'left' }}>
                  <th style={{ padding: '8px 12px' }}>Source</th>
                  <th style={{ padding: '8px 12px' }}>Access</th>
                </tr>
              </thead>
              <tbody>
                {allSourceIds.map(sid => (
                  <tr key={sid} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '8px 12px', fontWeight: 500 }}>{sid}</td>
                    <td style={{ padding: '8px 12px' }}>
                      <button onClick={() => cycleAccess(sid)}
                        style={{
                          padding: '4px 12px', fontSize: 12, borderRadius: 4, cursor: 'pointer', border: '1px solid #d1d5db',
                          background: grants[sid] === 'write' ? '#059669' : grants[sid] === 'read' ? '#3b82f6' : '#f3f4f6',
                          color: grants[sid] !== 'none' ? '#fff' : '#374151',
                        }}>
                        {grants[sid] || 'none'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <button onClick={handleSaveGrants}
              style={{ marginTop: 16, padding: '8px 20px', background: '#111', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14 }}>
              Save Permissions
            </button>
          </div>
        ) : (
          <div style={{ color: '#9ca3af', padding: 40, textAlign: 'center' }}>Select a role to edit its permissions</div>
        )}
      </div>
    </div>
  );
}
