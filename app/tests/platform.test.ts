import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_ACTIONS,
  ADMIN_ABSOLUTE_TTL_MS,
  ADMIN_IDLE_TTL_MS,
  STEP_UP_WINDOW_MS,
  accountStanding,
  activityLabel,
  canonicalEmail,
  isReservedCtfAddress,
  isSteppedUp,
  orgStanding,
  parseReason,
} from '../worker/lib/platform';
import { sessionLimits } from '../worker/lib/auth';

describe('CTF addresses are reserved', () => {
  it('covers the company inbox and the company domain', () => {
    expect(isReservedCtfAddress('cutthroughfaster@gmail.com')).toBe(true);
    expect(isReservedCtfAddress('hello@cutthroughfaster.com')).toBe(true);
    expect(isReservedCtfAddress('anyone@cutthroughfaster.com')).toBe(true);
    expect(isReservedCtfAddress('mail@app.cutthroughfaster.com')).toBe(true);
  });

  it('covers every spelling Gmail delivers to the same inbox', () => {
    // Gmail ignores dots and anything after "+", so all of these reach the
    // CTF inbox. A client registering one must not get a CTF-looking login.
    expect(isReservedCtfAddress('Cut.Through.Faster@gmail.com')).toBe(true);
    expect(isReservedCtfAddress('cutthroughfaster+admin@gmail.com')).toBe(true);
    expect(isReservedCtfAddress('cutthroughfaster@googlemail.com')).toBe(true);
    expect(isReservedCtfAddress('  CUTTHROUGHFASTER@GMAIL.COM ')).toBe(true);
  });

  it('does not catch look-alike domains or ordinary clients', () => {
    expect(isReservedCtfAddress('hello@cutthroughfaster.co.za')).toBe(false);
    expect(isReservedCtfAddress('hello@notcutthroughfaster.com')).toBe(false);
    expect(isReservedCtfAddress('reception@rosebankdental.co.za')).toBe(false);
    expect(isReservedCtfAddress('cutthroughfaster2@gmail.com')).toBe(false);
  });
});

describe('canonical email', () => {
  it('folds Gmail dots and plus tags', () => {
    expect(canonicalEmail('J.Smith+work@Gmail.com')).toBe('jsmith@gmail.com');
  });

  it('leaves other providers exactly as typed, apart from case', () => {
    // Elsewhere dots and plus tags can be separate mailboxes.
    expect(canonicalEmail('J.Smith+work@Practice.co.za')).toBe('j.smith+work@practice.co.za');
  });
});

describe('standing', () => {
  it('treats a block as final, whatever the status column says', () => {
    expect(orgStanding({ status: 'suspended', blocked_at: 123 })).toBe('blocked');
    expect(orgStanding({ status: 'active', blocked_at: null })).toBe('active');
    expect(orgStanding({ status: 'pending', blocked_at: null })).toBe('pending');
  });

  it('calls a healthy login in a suspended organization inactive', () => {
    expect(accountStanding({ disabled: 0, platform_hold: null }, 'suspended')).toBe('inactive');
    expect(accountStanding({ disabled: 0, platform_hold: null }, 'pending')).toBe('inactive');
    expect(accountStanding({ disabled: 0, platform_hold: null }, 'active')).toBe('active');
  });

  it('puts a block ahead of everything else', () => {
    expect(accountStanding({ disabled: 1, platform_hold: 'blocked' }, 'active')).toBe('blocked');
    expect(accountStanding({ disabled: 0, platform_hold: null }, 'blocked')).toBe('blocked');
    expect(accountStanding({ disabled: 1, platform_hold: 'disabled' }, 'active')).toBe('disabled');
    expect(accountStanding({ disabled: 1, platform_hold: null }, 'active')).toBe('disabled');
  });
});

describe('re-verification window', () => {
  it('is open only until the moment it expires', () => {
    const now = 1_000_000;
    expect(isSteppedUp(now + 1, now)).toBe(true);
    expect(isSteppedUp(now, now)).toBe(false);
    expect(isSteppedUp(now - 1, now)).toBe(false);
    expect(isSteppedUp(null, now)).toBe(false);
    expect(isSteppedUp(undefined, now)).toBe(false);
  });

  it('lasts minutes, not hours', () => {
    expect(STEP_UP_WINDOW_MS).toBeLessThanOrEqual(10 * 60 * 1000);
  });
});

describe('admin sessions', () => {
  it('are far shorter than client sessions', () => {
    const admin = sessionLimits('ctf_admin');
    const client = sessionLimits('none');
    expect(admin.idle).toBe(ADMIN_IDLE_TTL_MS);
    expect(admin.absolute).toBe(ADMIN_ABSOLUTE_TTL_MS);
    expect(admin.idle).toBeLessThan(client.idle);
    expect(admin.absolute).toBeLessThan(client.absolute);
    expect(admin.idle).toBeLessThanOrEqual(30 * 60 * 1000);
  });

  it('treats an unknown role as a client, never as an admin', () => {
    expect(sessionLimits(null)).toEqual(sessionLimits('none'));
    expect(sessionLimits('CTF_ADMIN')).toEqual(sessionLimits('none'));
  });
});

describe('enforcement reasons', () => {
  it('requires something meaningful and keeps it short', () => {
    expect(parseReason('Unpaid since July')).toBe('Unpaid since July');
    expect(parseReason('  spaced   out  ')).toBe('spaced out');
    expect(parseReason('no')).toBeNull();
    expect(parseReason('')).toBeNull();
    expect(parseReason(undefined)).toBeNull();
    expect(parseReason(42)).toBeNull();
    expect(parseReason('x'.repeat(301))).toBeNull();
  });
});

describe('activity feed', () => {
  it('never shows call activity, which carries caller context', () => {
    expect(ACTIVITY_ACTIONS.some((action) => action.startsWith('call.'))).toBe(false);
    expect(activityLabel('call.takeover')).toBeNull();
    expect(activityLabel('call.end')).toBeNull();
  });

  it('labels every admin enforcement action', () => {
    for (const action of [
      'platform.org_suspended',
      'platform.org_blocked',
      'platform.org_active',
      'platform.user_disabled',
      'platform.user_enabled',
      'platform.user_blocked',
    ]) {
      expect(activityLabel(action)).toBeTruthy();
    }
  });

  it('shows a login being added, which is what CTF is notified about', () => {
    expect(activityLabel('users.create')).toBe('Added a login');
  });
});
