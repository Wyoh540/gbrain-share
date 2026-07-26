/**
 * Contract tests for the v0.x users_admin MCP ops.
 *
 * - Op metadata: pins scope, localOnly, mutating, and that each op exists in
 *   the registered `operations` array (auto-flows through tool-defs).
 * - Scope-enforcement smoke test: simulates the serve-http.ts:673 hasScope
 *   gate so we know tokens without users_admin get insufficient_scope on
 *   admin-only ops. Full HTTP-transport coverage lives in the E2E suite.
 * - No functional handler tests here: user/role mutators need an initialized
 *   auth subsystem (password hashing, token tables) not present in the PGLite
 *   test engine. Integration coverage lives in the E2E suite.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext, AuthInfo, Operation } from '../src/core/operations.ts';
import { hasScope } from '../src/core/scope.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function findOp(name: string): Operation {
  const op = operations.find(o => o.name === name);
  if (!op) throw new Error(`op not found: ${name}`);
  return op;
}

function ctxRemote(scopes: string[]): OperationContext {
  const auth: AuthInfo = {
    token: 'gbrain_at_xxx',
    clientId: 'gbrain_cl_test',
    clientName: 'test-client',
    scopes,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
  return {
    engine: engine as any,
    config: { engine: 'pglite' } as any,
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true,
    auth,
    sourceId: 'default',
  };
}

// ---------------------------------------------------------------------------
// Op metadata pins (auto-flow through tool-defs)
// ---------------------------------------------------------------------------

describe('users_admin op metadata', () => {
  const expected: Array<{
    name: string;
    scope: NonNullable<Operation['scope']>;
    mutating: boolean;
    localOnly: boolean;
  }> = [
    { name: 'users_list',        scope: 'users_admin', mutating: false, localOnly: false },
    { name: 'user_create',       scope: 'users_admin', mutating: true,  localOnly: false },
    { name: 'user_set_password', scope: 'users_admin', mutating: true,  localOnly: false },
    { name: 'user_disable',      scope: 'users_admin', mutating: true,  localOnly: false },
    { name: 'user_enable',       scope: 'users_admin', mutating: true,  localOnly: false },
    { name: 'user_assign_roles', scope: 'users_admin', mutating: true,  localOnly: false },
    { name: 'roles_list',        scope: 'users_admin', mutating: false, localOnly: false },
    { name: 'role_create',       scope: 'users_admin', mutating: true,  localOnly: false },
    { name: 'role_set_sources',  scope: 'users_admin', mutating: true,  localOnly: false },
    { name: 'role_delete',       scope: 'users_admin', mutating: true,  localOnly: false },
  ];
  for (const e of expected) {
    test(`${e.name}: scope=${e.scope}, mutating=${e.mutating}, localOnly=${e.localOnly}`, () => {
      const op = findOp(e.name);
      expect(op.scope).toBe(e.scope);
      expect(!!op.mutating).toBe(e.mutating);
      expect(!!op.localOnly).toBe(e.localOnly);
    });
  }
});

// ---------------------------------------------------------------------------
// Scope-enforcement smoke test
// Simulates serve-http.ts:673's hasScope gate. The full HTTP path (real
// bearer auth + middleware) lives in the E2E suite.
// ---------------------------------------------------------------------------

describe('users_admin scope enforcement (simulates serve-http gate)', () => {
  function gate(op: Operation, grantedScopes: string[]): { allowed: boolean; required: string } {
    const required = op.scope || 'read';
    return { allowed: hasScope(grantedScopes, required), required };
  }

  const allOps = [
    'users_list', 'user_create', 'user_set_password', 'user_disable', 'user_enable',
    'user_assign_roles', 'roles_list', 'role_create', 'role_set_sources', 'role_delete',
  ];

  test('read-only token is REJECTED for every users_admin op', () => {
    for (const name of allOps) {
      const r = gate(findOp(name), ['read']);
      expect(r.required).toBe('users_admin');
      expect(r.allowed).toBe(false);
    }
  });

  test('users_admin token is ALLOWED for all users_admin ops', () => {
    const granted = ['users_admin'];
    for (const name of allOps) {
      expect(gate(findOp(name), granted).allowed).toBe(true);
    }
  });

  test('admin token is ALLOWED for all users_admin ops (admin implies all)', () => {
    const granted = ['admin'];
    for (const name of allOps) {
      expect(gate(findOp(name), granted).allowed).toBe(true);
    }
  });

  test('read + users_admin token is ALLOWED for all users_admin ops', () => {
    const granted = ['read', 'users_admin'];
    for (const name of allOps) {
      expect(gate(findOp(name), granted).allowed).toBe(true);
    }
  });
});
