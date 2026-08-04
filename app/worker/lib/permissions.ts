import type { UserRole } from '../../shared/types';
import { forbidden } from './http';

/**
 * What a signed-in user is allowed to do inside their own organization.
 * Tenancy is orthogonal: every query is already scoped by `org_id`, so these
 * permissions only ever widen or narrow access *within* one client's data.
 */
export type Permission =
  /** See the call list, transcripts, recordings and metrics. */
  | 'calls:read'
  /** Take a live call over onto a phone, or hang it up. */
  | 'calls:control'
  /** Add, edit and disable logins for this organization. */
  | 'users:manage'
  /** Change organization settings. */
  | 'org:manage';

export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  owner: ['calls:read', 'calls:control', 'users:manage', 'org:manage'],
  staff: ['calls:read', 'calls:control'],
};

export function can(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function permissionsFor(role: UserRole): Permission[] {
  return [...(ROLE_PERMISSIONS[role] ?? [])];
}

const DENIAL_MESSAGE: Record<Permission, string> = {
  'calls:read': 'You do not have access to call history.',
  'calls:control': 'You do not have permission to take over or end calls.',
  'users:manage': 'Only an owner can manage logins for this business.',
  'org:manage': 'Only an owner can change these settings.',
};

/**
 * Throws 403 unless the role carries the permission. Deliberately separate from
 * the 404 that a wrong-tenant id produces: "you may not do this" and "this does
 * not exist for you" are different answers and should not be conflated.
 */
export function requirePermission(role: UserRole, permission: Permission): void {
  if (!can(role, permission)) throw forbidden(DENIAL_MESSAGE[permission]);
}
