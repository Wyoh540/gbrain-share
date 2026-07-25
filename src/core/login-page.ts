/**
 * Browser login + password-reset pages for the /authorize flow.
 *
 * Pure functions — no dependencies, no Express, no side effects.
 * Every interpolated value is HTML-escaped.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const LOGIN_STYLE = `
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
background:#f9fafb;display:flex;justify-content:center;align-items:center;
min-height:100vh;margin:0}
.card{background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);
padding:40px;max-width:420px;width:100%;margin:16px}
h1{font-size:1.5rem;margin:0 0 8px;color:#111}
.sub{font-size:.9rem;color:#6b7280;margin:0 0 24px}
label{display:block;font-size:.85rem;font-weight:600;margin:16px 0 4px;color:#374151}
input{width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;
font-size:1rem;box-sizing:border-box}
input:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.15)}
button{width:100%;padding:12px;margin:24px 0 0;background:#111;color:#fff;
border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer}
button:hover{background:#333}
.error{background:#fef2f2;color:#991b1b;padding:10px 14px;border-radius:8px;
font-size:.85rem;margin:16px 0 0}
`;

export function renderLoginPage(opts: {
  clientName?: string;
  scopes: string[];
  nonce: string;
  error?: string;
}): string {
  const name = escapeHtml(opts.clientName || 'GBrain');
  const scopeList = opts.scopes.join(', ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — ${name}</title>
<style>${LOGIN_STYLE}</style>
</head>
<body>
<div class="card">
  <h1>Sign in to ${name}</h1>
  <p class="sub">${escapeHtml(scopeList)} access requested</p>
  <form method="post" action="/authorize/login" autocomplete="on">
    <input type="hidden" name="nonce" value="${escapeHtml(opts.nonce)}">
    <label for="username">Username</label>
    <input type="text" id="username" name="username" required autocomplete="username">
    <label for="password">Password</label>
    <input type="password" id="password" name="password" required autocomplete="current-password" minlength="10">
    <button type="submit">Sign in</button>
  </form>
  ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ''}
</div>
</body>
</html>`;
}

export function renderResetPasswordPage(opts: {
  nonce: string;
  username: string;
  error?: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reset Your Password — GBrain</title>
<style>${LOGIN_STYLE}</style>
</head>
<body>
<div class="card">
  <h1>Reset your password</h1>
  <p class="sub">Your password must be reset before you can continue.</p>
  <form method="post" action="/authorize/reset-password" autocomplete="on">
    <input type="hidden" name="nonce" value="${escapeHtml(opts.nonce)}">
    <input type="hidden" name="username" value="${escapeHtml(opts.username)}">
    <label for="password">Current password</label>
    <input type="password" id="password" name="password" required autocomplete="current-password">
    <label for="newPassword">New password (min 10 characters)</label>
    <input type="password" id="newPassword" name="newPassword" required autocomplete="new-password" minlength="10">
    <button type="submit">Reset password</button>
  </form>
  ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ''}
</div>
</body>
</html>`;
}
