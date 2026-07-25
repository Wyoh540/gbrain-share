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

export function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editingUser, setEditingUser] = useState<string | null>(null);

  const [formUser, setFormUser] = useState('');
  const [formPass, setFormPass] = useState('');
  const [formDisplay, setFormDisplay] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formAdmin, setFormAdmin] = useState(false);

  const [resetUser, setResetUser] = useState('');
  const [resetPass, setResetPass] = useState('');

  const fetchUsers = async () => {
    try {
      const data = await api.listUsers();
      setUsers(data.users || []);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  useEffect(() => { fetchUsers(); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.createUser(formUser, formPass, formDisplay || undefined, formEmail || undefined, formAdmin);
      setShowCreate(false);
      setFormUser(''); setFormPass(''); setFormDisplay(''); setFormEmail(''); setFormAdmin(false);
      fetchUsers();
    } catch (e: any) { setError(e.message); }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.resetUserPassword(resetUser, resetPass);
      setResetUser(''); setResetPass('');
      fetchUsers();
    } catch (e: any) { setError(e.message); }
  };

  const handleStatus = async (userId: string, status: 'active' | 'disabled') => {
    try {
      await api.setUserStatus(userId, status);
      fetchUsers();
    } catch (e: any) { setError(e.message); }
  };

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Users</h2>
        <button onClick={() => setShowCreate(!showCreate)} style={{ padding: '8px 16px', background: '#111', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
          {showCreate ? 'Cancel' : '+ New User'}
        </button>
      </div>

      {error && <div style={{ background: '#fef2f2', color: '#991b1b', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 14 }}>{error}<button onClick={() => setError('')} style={{ marginLeft: 12, background: 'none', border: 'none', cursor: 'pointer', color: '#991b1b' }}>×</button></div>}

      {showCreate && (
        <form onSubmit={handleCreate} style={{ background: '#f9fafb', padding: 20, borderRadius: 8, marginBottom: 16 }}>
          <input placeholder="Username" value={formUser} onChange={e => setFormUser(e.target.value)} required style={{ marginRight: 8, padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db' }} />
          <input type="password" placeholder="Password (min 10)" value={formPass} onChange={e => setFormPass(e.target.value)} required minLength={10} style={{ marginRight: 8, padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db' }} />
          <input placeholder="Display name" value={formDisplay} onChange={e => setFormDisplay(e.target.value)} style={{ marginRight: 8, padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db' }} />
          <input type="email" placeholder="Email" value={formEmail} onChange={e => setFormEmail(e.target.value)} style={{ marginRight: 8, padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db' }} />
          <label style={{ marginRight: 16, fontSize: 13 }}><input type="checkbox" checked={formAdmin} onChange={e => setFormAdmin(e.target.checked)} /> Admin</label>
          <button type="submit" style={{ padding: '6px 16px', background: '#111', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Create</button>
        </form>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #e5e7eb', textAlign: 'left' }}>
            <th style={{ padding: '8px 12px' }}>Username</th>
            <th style={{ padding: '8px 12px' }}>Display</th>
            <th style={{ padding: '8px 12px' }}>Roles</th>
            <th style={{ padding: '8px 12px' }}>Status</th>
            <th style={{ padding: '8px 12px' }}>Admin</th>
            <th style={{ padding: '8px 12px' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map(u => (
            <tr key={u.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
              <td style={{ padding: '8px 12px', fontWeight: 500 }}>{u.username}</td>
              <td style={{ padding: '8px 12px', color: '#6b7280' }}>{u.displayName || '—'}</td>
              <td style={{ padding: '8px 12px' }}>{(u.roles || []).join(', ') || '—'}</td>
              <td style={{ padding: '8px 12px' }}>
                <span style={{ color: u.status === 'active' ? '#059669' : '#dc2626', fontSize: 13, fontWeight: 500 }}>
                  {u.status}
                  {u.mustResetPassword && <span style={{ color: '#d97706', marginLeft: 6 }}>(reset req.)</span>}
                </span>
              </td>
              <td style={{ padding: '8px 12px' }}>{u.isAdmin ? '✓' : ''}</td>
              <td style={{ padding: '8px 12px' }}>
                <button onClick={() => handleStatus(u.id, u.status === 'active' ? 'disabled' : 'active')}
                  style={{ marginRight: 6, padding: '4px 10px', fontSize: 12, borderRadius: 4, border: '1px solid #d1d5db', cursor: 'pointer', background: '#fff' }}>
                  {u.status === 'active' ? 'Disable' : 'Enable'}
                </button>
                {editingUser === u.id ? (
                  <form onSubmit={handleReset} style={{ display: 'inline' }}>
                    <input type="password" value={resetPass} onChange={e => setResetPass(e.target.value)} placeholder="New pw" style={{ width: 80, padding: '4px 6px', fontSize: 12, borderRadius: 4, border: '1px solid #d1d5db' }} minLength={10} />
                    <button type="submit" style={{ marginLeft: 4, padding: '4px 8px', fontSize: 12, borderRadius: 4, border: 'none', background: '#111', color: '#fff', cursor: 'pointer' }}>Save</button>
                  </form>
                ) : (
                  <button onClick={() => { setEditingUser(u.id); setResetUser(u.id); setResetPass(''); }}
                    style={{ padding: '4px 10px', fontSize: 12, borderRadius: 4, border: '1px solid #d1d5db', cursor: 'pointer', background: '#fff' }}>
                    Reset PW
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
