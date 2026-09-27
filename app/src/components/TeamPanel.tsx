import { Check, Copy, Plus, ShieldCheck, UserCog } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { SessionUser, TeamMember, UserRole } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { formatRelativeDate } from '../lib/format';
import { ConfirmDialog } from './ConfirmDialog';
import { TableSkeleton } from './Skeleton';
import { Banner } from './ui';

/**
 * Shown once after a login is created or reset. The password is never
 * retrievable afterwards, so it is displayed until dismissed rather than as a
 * toast that can be missed.
 */
function TemporaryPassword({
  email,
  password,
  onDismiss,
}: {
  email: string;
  password: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const headingRef = useRef<HTMLParagraphElement>(null);

  // Shown once and never again, so it takes focus when it appears rather than
  // waiting to be found.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="border border-black rounded-xl p-4 space-y-3">
      <p ref={headingRef} tabIndex={-1} className="text-sm font-medium focus:outline-none">
        Temporary password for {email}
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 font-mono-data text-sm bg-gray-50 rounded-lg px-3 py-2 break-all">
          {password}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          className="border border-gray-200 rounded-lg p-2 hover:border-black transition shrink-0"
          aria-label="Copy password"
        >
          {copied ? (
            <Check className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Copy className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
        <span role="status" className="sr-only">
          {copied ? 'Password copied' : ''}
        </span>
      </div>
      <p className="text-xs text-slate">
        Send this over a channel you trust. It will not be shown again, and they must replace it
        the first time they sign in.
      </p>
      <button
        type="button"
        onClick={onDismiss}
        className="text-xs font-medium underline underline-offset-2"
      >
        Done
      </button>
    </div>
  );
}

interface Props {
  currentUser: SessionUser;
  timeZone: string;
}

export function TeamPanel({ currentUser, timeZone }: Props) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    email: '',
    name: '',
    role: 'staff' as UserRole,
    phone: '',
    signInMethod: 'google' as 'google' | 'password',
  });
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);
  const [confirmDisable, setConfirmDisable] = useState<TeamMember | null>(null);
  const [confirmReset, setConfirmReset] = useState<TeamMember | null>(null);
  const [editingPhone, setEditingPhone] = useState<string | null>(null);
  const [phoneDraft, setPhoneDraft] = useState('');
  const [status, setStatus] = useState('');
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const formId = useId();

  // `quiet` refreshes after a change without swapping the list for a skeleton.
  // Unmounting the rows would destroy the button that opened a dialog, and
  // with it the place keyboard focus is meant to return to.
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const response = await api.team();
      setMembers(response.members);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load your team.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The phone editor replaces its button, so put focus back on the new one.
  const focusPhoneButton = (memberId: string) => {
    requestAnimationFrame(() => document.getElementById(`phone-${memberId}`)?.focus());
  };

  const create = async () => {
    setBusyId('new');
    setError(null);
    try {
      const result = await api.createTeamMember({
        email: draft.email.trim(),
        name: draft.name.trim(),
        role: draft.role,
        signInMethod: draft.signInMethod,
        ...(draft.phone.trim() ? { phone: draft.phone.trim() } : {}),
      });
      // A Google-only login has no password to show, so the panel is skipped.
      if (result.temporaryPassword) {
        setIssued({ email: result.member.email, password: result.temporaryPassword });
      } else {
        // No password panel to take focus, and the form that held it is gone.
        requestAnimationFrame(() => addButtonRef.current?.focus());
      }
      setStatus(`Login added for ${result.member.name}.`);
      setDraft({ email: '', name: '', role: 'staff', phone: '', signInMethod: 'google' });
      setAdding(false);
      await load(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create that login.');
    } finally {
      setBusyId(null);
    }
  };

  const savePhone = async (member: TeamMember) => {
    setBusyId(member.id);
    setError(null);
    try {
      await api.updateTeamMember(member.id, { phone: phoneDraft.trim() || null });
      setEditingPhone(null);
      focusPhoneButton(member.id);
      await load(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save that number.');
    } finally {
      setBusyId(null);
    }
  };

  const update = async (member: TeamMember, changes: { role?: UserRole; disabled?: boolean }) => {
    setBusyId(member.id);
    setError(null);
    try {
      await api.updateTeamMember(member.id, changes);
      await load(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not update that login.');
    } finally {
      setBusyId(null);
      setConfirmDisable(null);
    }
  };

  const resetPassword = async (member: TeamMember) => {
    setBusyId(member.id);
    setError(null);
    try {
      const result = await api.resetTeamMemberPassword(member.id);
      // Closed in the same render that shows the password, so the dialog's
      // return of focus does not land after the password panel has taken it.
      setConfirmReset(null);
      // A reset always issues a password — it is what converts a Google-only
      // login into one that can also sign in with an email address.
      if (result.temporaryPassword) {
        setIssued({ email: result.member.email, password: result.temporaryPassword });
      }
      await load(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reset that password.');
    } finally {
      setBusyId(null);
      setConfirmReset(null);
    }
  };

  return (
    <section className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-display text-lg font-semibold">Team</h2>
        <button
          ref={addButtonRef}
          type="button"
          onClick={() => setAdding((value) => !value)}
          aria-expanded={adding}
          aria-controls={formId}
          className="text-xs px-3 py-1.5 rounded-full border border-gray-200 text-slate hover:border-black hover:text-black transition font-medium flex items-center gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add login
        </button>
      </div>

      {error && <Banner tone="error" onRetry={() => void load()}>{error}</Banner>}
      <p role="status" className="sr-only">
        {status}
      </p>

      {issued && (
        <TemporaryPassword
          email={issued.email}
          password={issued.password}
          onDismiss={() => setIssued(null)}
        />
      )}

      {adding && (
        <form
          id={formId}
          aria-label="Add a login"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
          className="border border-gray-200 rounded-xl p-4 space-y-3"
        >
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate">Name</span>
              <input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                required
                className="w-full border border-field rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-black"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate">Email</span>
              <input
                type="email"
                value={draft.email}
                onChange={(event) => setDraft({ ...draft, email: event.target.value })}
                required
                className="w-full border border-field rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-black"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate">Mobile for call takeover</span>
              <input
                type="tel"
                value={draft.phone}
                onChange={(event) => setDraft({ ...draft, phone: event.target.value })}
                placeholder="082 555 0134"
                className="w-full border border-field rounded-xl px-3 py-2 text-sm font-mono-data focus:outline-none focus:border-black"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate">Role</span>
              <select
                value={draft.role}
                onChange={(event) => setDraft({ ...draft, role: event.target.value as UserRole })}
                className="w-full border border-field rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-black bg-white"
              >
                <option value="staff">Staff — answer and end calls</option>
                <option value="owner">Owner — also manages logins</option>
              </select>
            </label>

            <label className="block space-y-1.5 sm:col-span-2">
              <span className="text-xs font-medium text-slate">How they sign in</span>
              <select
                value={draft.signInMethod}
                onChange={(event) =>
                  setDraft({ ...draft, signInMethod: event.target.value as 'google' | 'password' })
                }
                className="w-full border border-field rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-black bg-white"
              >
                <option value="google">Google — no password needed</option>
                <option value="password">Email and password</option>
              </select>
            </label>
          </div>

          <p className="text-xs text-slate">
            {draft.signInMethod === 'google'
              ? 'They sign in with the Google account on that email address. Nothing to send them, and no password to leak.'
              : 'A temporary password is generated and shown to you once. They must replace it the first time they sign in.'}
          </p>
          <button
            type="submit"
            disabled={busyId === 'new' || !draft.email || !draft.name}
            className="w-full bg-black text-white rounded-xl py-2.5 text-sm font-medium hover:bg-gray-800 transition disabled:opacity-40"
          >
            {busyId === 'new' ? 'Creating…' : 'Create login'}
          </button>
        </form>
      )}

      {loading ? (
        <TableSkeleton
          label="Loading your team"
          rows={3}
          className="border-t border-b border-gray-100"
        />
      ) : (
        <div className="divide-y divide-gray-100 border-t border-b border-gray-100">
          {members.map((member) => (
            <div key={member.id} className="py-4 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">
                  {member.name}
                  {member.isSelf && <span className="text-slate font-normal"> · you</span>}
                </p>
                <p className="text-xs text-slate truncate">{member.email}</p>
                <p className="text-xs text-slate mt-1 flex items-center gap-1.5 flex-wrap">
                  {member.role === 'owner' ? (
                    <span className="inline-flex items-center gap-1">
                      <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                      Owner
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <UserCog className="h-3 w-3" aria-hidden="true" />
                      Staff
                    </span>
                  )}
                  {member.googleLinked && <span>· Google linked</span>}
                  {member.disabled && <span className="text-red-600">· Disabled</span>}
                  {member.lastLoginAt && (
                    <span>· Last in {formatRelativeDate(member.lastLoginAt, timeZone)}</span>
                  )}
                  {!member.lastLoginAt && <span>· Never signed in</span>}
                </p>

                {/* Takeover rings this number. Without one, taking over a live
                    call is refused — so it is surfaced on the row rather than
                    hidden behind an edit screen. */}
                {editingPhone === member.id ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void savePhone(member);
                    }}
                    className="flex items-center gap-2 mt-2"
                  >
                    <input
                      type="tel"
                      value={phoneDraft}
                      onChange={(event) => setPhoneDraft(event.target.value)}
                      placeholder="082 555 0134"
                      autoFocus
                      aria-label={`Takeover number for ${member.name}`}
                      className="border border-field rounded-lg px-3 py-1.5 text-xs font-mono-data focus:outline-none focus:border-black w-40"
                    />
                    <button
                      type="submit"
                      disabled={busyId === member.id}
                      className="text-xs font-medium underline underline-offset-2 disabled:opacity-40"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingPhone(null);
                        focusPhoneButton(member.id);
                      }}
                      className="text-xs text-slate underline underline-offset-2"
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <button
                    id={`phone-${member.id}`}
                    type="button"
                    onClick={() => {
                      setEditingPhone(member.id);
                      setPhoneDraft(member.phone ?? '');
                    }}
                    className="text-xs mt-1.5 underline underline-offset-2 text-slate hover:text-black transition"
                  >
                    {member.phone ? (
                      <>
                        <span className="font-mono-data">{member.phone}</span>
                        <span className="sr-only">, change {member.name}&rsquo;s takeover number</span>
                      </>
                    ) : (
                      <>
                        Add a mobile for call takeover
                        <span className="sr-only"> for {member.name}</span>
                      </>
                    )}
                  </button>
                )}
              </div>

              <div className="flex flex-col items-end gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setConfirmReset(member)}
                  disabled={busyId === member.id}
                  className="text-xs text-slate hover:text-black underline underline-offset-2 disabled:opacity-40"
                >
                  Reset password
                  <span className="sr-only"> for {member.name}</span>
                </button>
                {!member.isSelf && (
                  <button
                    type="button"
                    onClick={() =>
                      member.disabled
                        ? void update(member, { disabled: false })
                        : setConfirmDisable(member)
                    }
                    disabled={busyId === member.id}
                    className="text-xs text-slate hover:text-black underline underline-offset-2 disabled:opacity-40"
                  >
                    {member.disabled ? 'Re-enable' : 'Disable'}
                    <span className="sr-only"> {member.name}</span>
                  </button>
                )}
              </div>
            </div>
          ))}
          {members.length === 0 && (
            <p className="text-sm text-slate py-6 text-center">No logins yet.</p>
          )}
        </div>
      )}

      <p className="text-xs text-slate">
        Signed in as {currentUser.name}. Owners can add and disable logins; staff can view calls,
        take them over and end them.
      </p>

      <ConfirmDialog
        open={confirmDisable !== null}
        title="Disable this login?"
        description={
          <p>
            {confirmDisable?.name} will be signed out immediately and will not be able to sign in
            again until you re-enable them.
          </p>
        }
        confirmLabel="Disable login"
        destructive
        busy={busyId === confirmDisable?.id}
        onCancel={() => setConfirmDisable(null)}
        onConfirm={() => confirmDisable && void update(confirmDisable, { disabled: true })}
      />

      <ConfirmDialog
        open={confirmReset !== null}
        title="Reset this password?"
        description={
          <p>
            {confirmReset?.name} will be signed out everywhere and will need the new temporary
            password to get back in. You will see it once, on the next screen.
          </p>
        }
        confirmLabel="Reset password"
        busy={busyId === confirmReset?.id}
        onCancel={() => setConfirmReset(null)}
        onConfirm={() => confirmReset && void resetPassword(confirmReset)}
      />
    </section>
  );
}
