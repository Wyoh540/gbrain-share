# Multi-User Auth + Role-Based Source Permissions — Design

**Date:** 2026-07-22
**Status:** Validated (brainstorming complete, pre-implementation)
**Branch:** `feat/multi-user-auth`

## Background

GBrain today has no human-user concept. Identity is per-OAuth-client
(`oauth_clients.source_id` for write, `federated_read` for read) or per-legacy
bearer token. The company-brain tutorial provisions "one OAuth client per
teammate" via CLI — there is no login, no password, no user-to-source
permission UI. The `users_admin` scope is declared in `src/core/scope.ts` but
unused by any operation.

This design adds a first-class user layer for a **single-company deployment**
(one brain, admin-managed users), where each teammate's MCP client
(Claude Code, Cursor, …) authenticates through a **browser login page** on the
existing OAuth 2.1 `authorization_code` + PKCE flow, and an admin assigns
source permissions **by role** through the existing `/admin` dashboard.

Decisions locked during brainstorming:

| Question | Decision |
|---|---|
| Deployment shape | Company-internal, one brain. No org/tenant modeling. |
| Consumption surface | MCP clients + browser login (authorization_code). No end-user web UI. |
| Identity provider | Password-only in phase 1. SSO (generic OIDC) in phase 2, seam preserved. |
| Permission granularity | Roles: role ↔ source matrix (`read`/`write`), users hold N roles, effective = union. No per-user overrides in phase 1. |
| Admin surface | Extend `/admin` SPA. Management ops go contract-first (`users_admin` scope) so CLI gets parity for free. |

## Approach selection

**Chosen — Approach A: users as first-class entities, role permissions
resolved dynamically at token validation.** Role changes take effect on the
user's next request (permissions are computed live in `verifyAccessToken`,
not baked into tokens). The read-enforcement layer is reused unchanged:
`sourceScopeOpts(ctx)` already prefers `auth.allowedSources` and
`resolveRequestedScope()` is fail-closed — the fuzz-tested SQL isolation
machinery applies to user tokens verbatim.

Rejected — Approach B (users only authenticate; permissions stay on
auto-provisioned per-user OAuth clients): permission snapshots baked into
clients, role edits require rewriting member clients, audit chain indirect.
Rejected — Approach C (Postgres RLS): invasive across the ~47-method engine;
project convention is application-layer enforcement (RLS enabled but zero
policies today).

## 1. Schema

One migration entry, applied in all three places per repo convention
(`src/schema.sql`, `src/core/pglite-schema.ts`, `MIGRATIONS` in
`src/core/migrate.ts`; engine parity pinned by `engine-parity.test.ts`).

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,              -- usr_<random>
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  email         TEXT,
  password_hash TEXT NOT NULL,                 -- argon2id via Bun.password
  status        TEXT NOT NULL DEFAULT 'active',   -- active | disabled
  is_admin      BOOLEAN NOT NULL DEFAULT false,   -- may manage users/roles
  must_reset_password BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id          TEXT PRIMARY KEY,              -- slug, e.g. 'sales'
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE role_source_permissions (
  role_id   TEXT NOT NULL REFERENCES roles(id)   ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  access    TEXT NOT NULL CHECK (access IN ('read','write')),  -- write implies read
  PRIMARY KEY (role_id, source_id)
);

CREATE TABLE user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- Pending browser logins for the /authorize flow (10-min TTL, swept with
-- expired tokens). `params` is jsonb — writes go through executeRawJsonb /
-- sql.json() per the repo's jsonb discipline (#2339 class).
CREATE TABLE oauth_pending_logins (
  nonce       TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  params      JSONB NOT NULL,
  expires_at  BIGINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE oauth_codes  ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE oauth_tokens ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
```

Design notes:

- **Effective permissions = union across the user's roles** (read union,
  write union). Phase 1 has no per-user override table; add
  `user_source_permissions` later only if needed.
- **`is_admin` is orthogonal to source access.** It gates user/role
  management only. Admins who read content hold roles like everyone else —
  one permission semantics, no hidden admin backdoor.
- **Machine clients unaffected.** `client_credentials` tokens carry
  `user_id = NULL` and keep the existing `oauth_clients.source_id +
  federated_read` path. Both subject types coexist in one `AuthInfo`.

## 2. Login & token flow

```
MCP client (Claude Code, Cursor, …)
  └─ GET /authorize?client_id=..&redirect_uri=..&code_challenge=..&state=..
       └─ custom authorize handler: render login page (username/password)
            └─ POST /authorize/login (one-time login nonce)
                 ├─ failure → generic "invalid credentials" + rate limit
                 └─ success → issue code (oauth_codes.user_id set) → 302
                      └─ POST /token (PKCE) → access+refresh tokens (user_id set)
                           └─ every MCP request: Bearer → verifyAccessToken → AuthInfo
```

Key decisions:

- **Login page lives in `provider.authorize()`** — it already receives the
  raw Express `res` (src/core/oauth-provider.ts:414). Instead of issuing a
  code immediately (today's zero-consent behavior), it stores the OAuth
  params in `oauth_pending_logins` and renders the form with a nonce.
  DB-backed nonce (not a signed cookie): consistent with the codebase,
  revocable, no key management. Swept by `sweepExpiredTokens`.
- **Password verification** via `Bun.password` (argon2id). Login endpoint
  rate-limited per IP and per username (existing token-bucket in
  `src/mcp/rate-limit.ts`). Error messages never distinguish "no such user"
  from "wrong password". `must_reset_password=true` routes to a forced
  change-password page before code issuance.
- **Login page is the consent screen** — it shows the client name and
  requested scopes. No separate consent step for first-party use.
- `exchangeAuthorizationCode` / `exchangeRefreshToken` `DELETE … RETURNING`
  carries `user_id`; `issueTokens` persists it on both token rows. Refresh
  rotation preserves the user binding.
- **`verifyAccessToken` stays the single choke point** — one query:
  `oauth_tokens` LEFT JOIN `oauth_clients`, LEFT JOIN `users` → `user_roles`
  → `role_source_permissions` with `array_agg(DISTINCT …)` for the read and
  write unions. `user_id IS NULL` takes today's branch unchanged.
  `status='disabled'` → `InvalidTokenError` — disabling a user is immediate,
  as are role changes (permissions computed per request, no snapshot, no
  cache in phase 1).

## 3. Authorization enforcement

`AuthInfo` (src/core/operations.ts:264) gains three optional fields:

```typescript
userId?: string;          // human user id; absent = machine client
username?: string;
writeSources?: string[];  // user's write union; machine clients: [sourceId]
```

**Read path: zero changes.** The user's read union populates the existing
`auth.allowedSources`; `sourceScopeOpts(ctx)` and the fail-closed
`resolveRequestedScope()` do the rest. This is Approach A's payoff.

**Write path: one choke helper.** Today's write authority is scalar
(`ctx.sourceId`). New `resolveWriteScope(ctx, requested?)`:

- requested source must be ∈ `writeSources`, else refuse (error lists the set)
- no requested source: use the write union if exactly 1; refuse if 0
  (read-only user); refuse + require explicit `--source` if >1
- machine clients get `writeSources = [sourceId]` → byte-identical behavior

Both subject types share one write-validation code path. `ctx.sourceId` is
filled with the user's default write source (sole write source, else first
read source) so legacy ops assuming a scalar don't break; the real gate is
always `resolveWriteScope`.

**Scopes unchanged.** Token scopes (`read`/`write`/`admin`) still gate
op-level access (`hasScope`, serve-http.ts:1693), orthogonal to source
permissions. The reserved `users_admin` scope is finally used: all user/role
management ops declare `scope: 'users_admin'` (`admin` implies it per the
existing hierarchy).

**Audit.** `mcp_request_log` gains a `username` column — human calls
attribute to a person (NULL for machine calls). Admin actions (user create,
role change, password reset) append to the existing JSONL audit pattern.

## 4. Admin surface & management ops

**Dashboard.** The `/admin` SPA gains two pages:

- **Users** — list (username / display name / roles / status / last active),
  create (admin sets initial password, `must_reset_password` default on),
  disable/enable, reset password, assign/remove roles.
- **Roles** — role list, create role, per-role source matrix
  (sources × none/read/write tri-state).

**Management ops are contract-first** in `src/core/operations.ts`:
`user_create`, `user_set_password`, `user_disable`, `user_assign_roles`,
`role_create`, `role_set_sources`, `users_list`, `roles_list` — all
`scope: 'users_admin'`. Because CLI + MCP are generated from this one file,
the CLI gains equivalent commands for free and `/admin/api/users/*` is just
an HTTP shell over the same ops. One implementation, three surfaces.

**Dashboard auth.** Bootstrap token is demoted to break-glass + first-admin
creation (setup wizard when the users table is empty). Afterwards admins log
in with username/password (`is_admin` check, session cookie).

**Password policy (phase 1, deliberately minimal).** Min length 10.
Admin-set initial password + forced first-login reset. No self-service
reset (no mail channel). No self-registration — accounts are admin-created,
which is a feature for a company-internal deployment.

## 5. Compatibility, SSO seam, testing

**Compatibility — one intentional behavior change.** Legacy `access_tokens`
and `client_credentials` clients are untouched. Existing
`authorization_code` clients (e.g. the ChatGPT connector) will see the login
page instead of an immediate code: live refresh tokens keep working until
expiry; re-authorization requires a user login. This is a strict security
upgrade (today `/authorize` issues a code to anyone holding a client_id)
and is called out in the CHANGELOG + upgrade notes.

**SSO seam (phase 2).** Add an `identities` table (`user_id, idp, subject`)
and a "Sign in with SSO" button on the same login page → OIDC redirect →
callback resolves `(idp, subject)` → user. Password is just one credential
type; the login page is the only change site, the token chain is untouched.
This is why authentication is funneled into `/authorize` alone.

**Testing (aligned with repo discipline).**

- Unit: login nonce TTL/single-use, genericized errors, dual-axis rate
  limiting, role-union computation, `resolveWriteScope` three branches,
  refresh preserving `user_id`, disabled-user immediacy.
- Engine parity: PGLite + Postgres (DATABASE_URL-gated e2e); migration runs
  on both engines.
- **Zero-leak fuzz extended to user tokens**: two users with disjoint roles;
  search / list / get_page / multi-source reads assert no cross-role
  leakage (reuses the existing fuzz suite).
- Management-op contract tests + admin API smoke tests.
- jsonb discipline: permission tables are pure relational columns;
  `oauth_pending_logins.params` writes use `executeRawJsonb` / `sql.json()`.

## Explicitly out of scope (phase 1)

- SSO / OIDC (phase 2, seam above)
- Per-user permission overrides (`user_source_permissions`)
- Self-service password reset / email flows
- Self-registration
- End-user web query UI (MCP clients only)
- Org/tenant modeling (single company, one brain)
