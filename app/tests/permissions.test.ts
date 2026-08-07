import { describe, expect, it } from 'vitest';
import { can, permissionsFor, requirePermission, ROLE_PERMISSIONS } from '../worker/lib/permissions';

describe('role permissions', () => {
  it('lets an owner manage logins and control calls', () => {
    expect(can('owner', 'users:manage')).toBe(true);
    expect(can('owner', 'org:manage')).toBe(true);
    expect(can('owner', 'calls:control')).toBe(true);
    expect(can('owner', 'calls:read')).toBe(true);
  });

  it('lets staff operate calls but not manage logins', () => {
    expect(can('staff', 'calls:read')).toBe(true);
    expect(can('staff', 'calls:control')).toBe(true);
    expect(can('staff', 'users:manage')).toBe(false);
    expect(can('staff', 'org:manage')).toBe(false);
  });

  it('throws a 403 rather than a 404 when a permission is missing', () => {
    expect(() => requirePermission('staff', 'users:manage')).toThrowError(
      /Only an owner can manage logins/,
    );

    try {
      requirePermission('staff', 'users:manage');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { status: number }).status).toBe(403);
    }
  });

  it('does not throw when the permission is held', () => {
    expect(() => requirePermission('owner', 'users:manage')).not.toThrow();
    expect(() => requirePermission('staff', 'calls:control')).not.toThrow();
  });

  it('never grants a role a permission outside its declared set', () => {
    for (const [role, granted] of Object.entries(ROLE_PERMISSIONS)) {
      for (const permission of permissionsFor(role as 'owner' | 'staff')) {
        expect(granted).toContain(permission);
      }
    }
  });

  it('returns a copy, so a caller cannot widen a role at runtime', () => {
    const permissions = permissionsFor('staff');
    permissions.push('users:manage');
    expect(can('staff', 'users:manage')).toBe(false);
  });
});
