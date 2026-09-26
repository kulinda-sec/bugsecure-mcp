import { describe, expect, it } from 'vitest';

import { BugSecureError, describeError } from './errors.js';
import type { Scope } from './scopes.js';

const scopes = (...list: Scope[]): ReadonlySet<Scope> => new Set(list);
const missing = (requiredScopes: Scope[], scopeMatch: 'all' | 'any' = 'all'): BugSecureError =>
  new BugSecureError('INSUFFICIENT_SCOPE', 'missing permission', { requiredScopes, scopeMatch });

describe('describeError, insufficient scope', () => {
  it('asks to reconnect and approve what is missing, keeping what is granted', () => {
    const text = describeError(missing(['reports:write']), 'hosted', scopes('programs:read'));
    expect(text).toContain(
      'reconnect BugSecure in their MCP client and approve: programs:read reports:write',
    );
  });

  it('says BugSecure did not grant a scope the user approved, instead of asking again', () => {
    const text = describeError(
      missing(['grade:write']),
      'hosted',
      scopes('programs:read', 'triage:read'),
      scopes('grade:write'),
    );
    expect(text).toContain('BugSecure did not grant grade:write to this connection although it was approved');
    expect(text).toContain('reconnecting and approving it again changes nothing');
    // The exchange narrows only to what the hosted client's registration allows: the operator's to fix,
    // never the organisation's opt-in (settled at consent), so no "AI grading" advice.
    expect(text).toContain('Only the operator of this hosted server can fix that');
    expect(text).not.toContain('"AI grading"');
    expect(text).toContain('Do not retry this call.');
    expect(text).not.toContain('and approve:');
  });

  it('says the same for a withheld researcher-only scope: eligibility is not the cause', () => {
    const text = describeError(missing(['profile:write']), 'hosted', scopes(), scopes('profile:write'));
    expect(text).toContain('Only the operator of this hosted server can fix that');
    expect(text).not.toContain('researcher accounts');
    expect(text).not.toContain('Administrators');
  });

  it('does not ask to approve a granted read scope when only the write scope was withheld', () => {
    const text = describeError(
      missing(['triage:write', 'profile:read']),
      'hosted',
      scopes('profile:read'),
      scopes('triage:write'),
    );
    expect(text).toContain('BugSecure did not grant triage:write');
    expect(text).not.toContain('and approve:');
    expect(text).not.toContain('Ask the user to disconnect');
  });

  it('still requests reauthorization when the API rejects scopes our cached token lists', () => {
    const text = describeError(missing(['reports:write']), 'local', scopes('reports:write'));
    expect(text).toContain('login --scopes "reports:write"');
  });

  it('asks only for the scopes that were not withheld, and names the withheld ones', () => {
    const text = describeError(
      missing(['reports:write', 'triage:write']),
      'hosted',
      scopes('programs:read'),
      scopes('triage:write'),
    );
    expect(text).toContain('and approve: programs:read reports:write.');
    expect(text).not.toContain('approve: programs:read reports:write triage:write');
    expect(text).toContain('BugSecure did not grant triage:write');
  });

  it('when any one scope would do, asks for one BugSecure did not withhold', () => {
    const text = describeError(
      missing(['triage:read', 'reports:read'], 'any'),
      'hosted',
      scopes(),
      scopes('triage:read'),
    );
    expect(text).toContain('Any one of triage:read, reports:read is enough.');
    expect(text).toContain('and approve: reports:read.');
    expect(text).not.toContain('did not grant');
  });
});
