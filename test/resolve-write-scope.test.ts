import { test, expect } from 'bun:test';
import { resolveWriteScope } from '../src/core/operations.ts';

const baseCtx = { remote: true } as any;

test('machine client: writeSources = [sourceId], unchanged semantics', () => {
  const ctx = {
    ...baseCtx,
    sourceId: 'dept-x',
    auth: { token: 't', clientId: 'c', scopes: ['write'], sourceId: 'dept-x', allowedSources: ['dept-x'] },
  };
  expect(resolveWriteScope(ctx, undefined)).toBe('dept-x');
  expect(resolveWriteScope(ctx, 'dept-x')).toBe('dept-x');
  expect(() => resolveWriteScope(ctx, 'other')).toThrow(/not granted write/i);
});

test('user token: union semantics', () => {
  const ctx = {
    ...baseCtx,
    sourceId: 'shared',
    auth: {
      token: 't',
      clientId: 'c',
      scopes: ['write'],
      userId: 'usr_1',
      username: 'alice-example',
      allowedSources: ['shared', 'customers'],
      writeSources: ['customers'],
    },
  };
  expect(resolveWriteScope(ctx, undefined)).toBe('customers'); // sole write source
  expect(() => resolveWriteScope(ctx, 'shared')).toThrow(/not granted write/i); // shared is read-only for alice
  expect(() => resolveWriteScope(ctx, 'internal')).toThrow(/not granted write/i);
});

test('multi-write user must specify; read-only user refused', () => {
  const twoWrites = {
    ...baseCtx,
    sourceId: 'a',
    auth: { token: 't', clientId: 'c', scopes: ['write'], userId: 'usr_2', allowedSources: ['a', 'b'], writeSources: ['a', 'b'] },
  };
  expect(() => resolveWriteScope(twoWrites, undefined)).toThrow(/specify/i);
  expect(resolveWriteScope(twoWrites, 'b')).toBe('b');

  const readOnly = {
    ...baseCtx,
    sourceId: 'a',
    auth: { token: 't', clientId: 'c', scopes: ['read'], userId: 'usr_3', allowedSources: ['a'], writeSources: [] },
  };
  expect(() => resolveWriteScope(readOnly, undefined)).toThrow(/read-only|no write/i);
});

test('local CLI bypass: remote === false', () => {
  const localCtx = { remote: false, sourceId: 'anything', auth: undefined } as any;
  expect(resolveWriteScope(localCtx, undefined)).toBe('anything');
  expect(resolveWriteScope(localCtx, 'other')).toBe('other');
});

test('pre-multi-user fallback: auth.writeSources absent uses auth.sourceId', () => {
  const ctx = {
    ...baseCtx,
    sourceId: 'default',
    auth: { token: 't', clientId: 'c', scopes: ['write'], sourceId: 'internal' },
  };
  expect(resolveWriteScope(ctx, undefined)).toBe('internal');
});

test('pre-multi-user fallback: no auth.sourceId falls back to ctx.sourceId', () => {
  const ctx = {
    ...baseCtx,
    sourceId: 'legacy',
    auth: { token: 't', clientId: 'c', scopes: ['write'] },
  };
  expect(resolveWriteScope(ctx, undefined)).toBe('legacy');
});
