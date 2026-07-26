import React, { useState, useEffect } from 'react';
import { api } from '../api';

interface User {
  id: string;
  username: string;
  displayName?: string;
  email?: string;
  status: 'active' | 'disabled';
  isAdmin: boolean;
  mustResetPassword: boolean;
  roles: string[];
  createdAt: string;
}

interface Role {
  id: string;
  description?: string;
  sources: Record<string, 'read' | 'write'>;
  memberCount: number;
}

export function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editingUser, setEditingUser] = useState<string | null>(null);

  // Create form state
  const [formUser, setFormUser] = useState('');
  const [formPass, setFormPass] = useState('');
  const [formDisplay, setFormDisplay] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formAdmin, setFormAdmin] = useState(false);
  const [formSubmitting, setFormSubmitting] = useState(false);

  // Reset password state
  const [resetUser, setResetUser] = useState('');
  const [resetPass, setResetPass] = useState('');

  // Edit roles state
  const [editRolesUser, setEditRolesUser] = useState<User | null>(null);
  const [editRolesSelected, setEditRolesSelected] = useState<Set<string>>(new Set());
  const [editRolesSaving, setEditRolesSaving] = useState(false);

  const fetchData = async () => {
    setError('');
    try {
      const [usersData, rolesData] = await Promise.all([
        api.listUsers(),
        api.listRoles(),
      ]);
      setUsers(usersData.users || []);
      setRoles(rolesData.roles || []);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormSubmitting(true);
    try {
      await api.createUser(formUser, formPass, formDisplay || undefined, formEmail || undefined, formAdmin);
      setShowCreate(false);
      setFormUser(''); setFormPass(''); setFormDisplay(''); setFormEmail(''); setFormAdmin(false);
      fetchData();
    } catch (e: any) { setError(e.message); }
    setFormSubmitting(false);
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.resetUserPassword(resetUser, resetPass);
      setEditingUser(null);
      setResetUser(''); setResetPass('');
      fetchData();
    } catch (e: any) { setError(e.message); }
  };

  const handleStatus = async (userId: string, status: 'active' | 'disabled') => {
    try {
      await api.setUserStatus(userId, status);
      fetchData();
    } catch (e: any) { setError(e.message); }
  };

  const openEditRoles = (user: User) => {
    setEditRolesUser(user);
    setEditRolesSelected(new Set(user.roles || []));
  };

  const toggleRole = (roleId: string) => {
    setEditRolesSelected(prev => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  };

  const handleSaveRoles = async () => {
    if (!editRolesUser) return;
    setEditRolesSaving(true);
    try {
      await api.setUserRoles(editRolesUser.id, [...editRolesSelected]);
      setEditRolesUser(null);
      fetchData();
    } catch (e: any) { setError(e.message); }
    setEditRolesSaving(false);
  };

  if (loading) return <div style={{ padding: 24, color: 'var(--text-secondary)' }}>Loading…</div>;

  return (
    <div style={{ padding: 24 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>Users</h1>
        <button className="btn btn-primary" onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? 'Cancel' : '+ New User'}
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{ background: 'var(--error)', color: '#fff', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{error}</span>
          <button onClick={() => setError('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#fff', fontSize: 16, padding: 0, lineHeight: 1 }}>×</button>
        </div>
      )}

      {/* Create user modal */}
      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <form className="modal" onClick={e => e.stopPropagation()} onSubmit={handleCreate}>
            <div className="modal-title">Create User</div>
            <div style={{ marginBottom: 16 }}>
              <label>Username</label>
              <input placeholder="e.g. alice-example" value={formUser} onChange={e => setFormUser(e.target.value)} required autoFocus />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label>Password (min 10 characters)</label>
              <input type="password" placeholder="Min 10 characters" value={formPass} onChange={e => setFormPass(e.target.value)} required minLength={10} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label>Display Name</label>
              <input placeholder="e.g. Alice" value={formDisplay} onChange={e => setFormDisplay(e.target.value)} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label>Email</label>
              <input type="email" placeholder="alice@example.com" value={formEmail} onChange={e => setFormEmail(e.target.value)} />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label className="checkbox-label">
                <input type="checkbox" checked={formAdmin} onChange={e => setFormAdmin(e.target.checked)} />
                Admin (can manage users and roles)
              </label>
            </div>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={formSubmitting}>
                {formSubmitting ? 'Creating…' : 'Create User'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Edit Roles modal */}
      {editRolesUser && (
        <div className="modal-overlay" onClick={() => setEditRolesUser(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <div className="modal-title">Edit Roles — {editRolesUser.username}</div>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
              A user's effective permissions are the union of all assigned roles. Changes take effect on their next token.
            </p>

            {roles.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 20 }}>
                No roles defined yet. Create roles on the Roles page first.
              </div>
            ) : (
              <div className="checkbox-group" style={{ marginBottom: 20 }}>
                {roles.map(r => (
                  <label key={r.id} className="checkbox-label" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                    <input
                      type="checkbox"
                      checked={editRolesSelected.has(r.id)}
                      onChange={() => toggleRole(r.id)}
                    />
                    <div>
                      <div style={{ fontWeight: 500 }}>{r.id}</div>
                      {r.description && <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{r.description}</div>}
                      <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 2 }}>
                        Grants access to {Object.keys(r.sources).length} source{Object.keys(r.sources).length !== 1 ? 's' : ''}
                        {Object.entries(r.sources).slice(0, 3).map(([sid, acc]) => (
                          <span key={sid} style={{ marginLeft: 4 }}>
                            <span className={`badge ${acc === 'write' ? 'badge-write' : 'badge-read'}`} style={{ fontSize: 10 }}>{sid}:{acc}</span>
                          </span>
                        ))}
                        {Object.keys(r.sources).length > 3 && <span style={{ marginLeft: 4 }}>+{Object.keys(r.sources).length - 3} more</span>}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setEditRolesUser(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={handleSaveRoles} disabled={editRolesSaving || roles.length === 0}>
                {editRolesSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Users table */}
      {users.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
          No users yet. Create the first admin via the bootstrap endpoint, then add more users here.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Display</th>
              <th>Roles</th>
              <th>Status</th>
              <th>Admin</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id}>
                <td style={{ fontWeight: 500 }}>{u.username}</td>
                <td style={{ color: 'var(--text-secondary)' }}>{u.displayName || '—'}</td>
                <td>
                  {(u.roles || []).length === 0 ? (
                    <span style={{ color: 'var(--text-muted)' }}>—</span>
                  ) : (
                    (u.roles || []).map(r => (
                      <span key={r} className="badge badge-read" style={{ marginRight: 4 }}>{r}</span>
                    ))
                  )}
                </td>
                <td>
                  <span className={`badge ${u.status === 'active' ? 'badge-success' : 'badge-error'}`}>
                    {u.status}
                  </span>
                  {u.mustResetPassword && (
                    <span className="badge" style={{ marginLeft: 6, background: 'var(--warning)', color: '#fff', fontSize: 11 }}>
                      reset req.
                    </span>
                  )}
                </td>
                <td>
                  {u.isAdmin && <span className="badge badge-admin">admin</span>}
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button
                      className="btn btn-secondary"
                      style={{ fontSize: 12, padding: '4px 10px' }}
                      onClick={() => openEditRoles(u)}>
                      Roles
                    </button>
                    <button
                      className={`btn ${u.status === 'active' ? 'btn-secondary' : 'btn-primary'}`}
                      style={{ fontSize: 12, padding: '4px 10px' }}
                      onClick={() => handleStatus(u.id, u.status === 'active' ? 'disabled' : 'active')}>
                      {u.status === 'active' ? 'Disable' : 'Enable'}
                    </button>
                    {editingUser === u.id ? (
                      <form onSubmit={handleReset} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <input
                          type="password"
                          value={resetPass}
                          onChange={e => setResetPass(e.target.value)}
                          placeholder="New password"
                          style={{ width: 120, padding: '4px 8px', fontSize: 12, borderRadius: 4 }}
                          minLength={10}
                          autoFocus />
                        <button type="submit" className="btn btn-primary" style={{ fontSize: 12, padding: '4px 8px' }}>Save</button>
                        <button type="button" className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 8px' }}
                          onClick={() => { setEditingUser(null); setResetPass(''); }}>×</button>
                      </form>
                    ) : (
                      <button
                        className="btn btn-secondary"
                        style={{ fontSize: 12, padding: '4px 10px' }}
                        onClick={() => { setEditingUser(u.id); setResetUser(u.id); setResetPass(''); }}>
                        Reset PW
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 12 }}>
        {users.filter(u => u.status === 'active').length} active / {users.length} total
      </div>
    </div>
  );
}
