import { Bell, LogOut, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  AccountAction,
  AccountStanding,
  AdminAccount,
  AdminActivityItem,
  AdminClient,
  AdminPeriod,
  MeResponse,
  OrgAction,
  OrgStanding,
  TwoFactorStatus,
} from '../../shared/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { LogoMark } from '../components/Logo';
import { SecurityPanel } from '../components/SecurityPanel';
import { StatGridSkeleton, TableSkeleton } from '../components/Skeleton';
import { Banner, SegmentedControl, StatCard } from '../components/ui';
import { usePoll } from '../hooks/usePoll';
import { api, ApiError } from '../lib/api';
import { formatAbsolute, formatRelativeDate, formatZar } from '../lib/format';

/** CTF runs on Johannesburg time, whatever timezone a client is in. */
const CTF_TIME_ZONE = 'Africa/Johannesburg';

interface Props {
  session: MeResponse;
  onSignOut: () => void;
  onSessionExpired: () => void;
}

/**
 * The CTF admin console. The only screen a CTF admin sees: accounts and counts
 * across every client, and the controls to suspend, disable and block. There is
 * no client dashboard here and no sample data — an empty platform shows empty.
 */
export function AdminConsole({ session, onSignOut, onSessionExpired }: Props) {
  const [twoFactor, setTwoFactor] = useState<TwoFactorStatus | null>(null);
  const [twoFactorError, setTwoFactorError] = useState<string | null>(null);

  const loadTwoFactor = useCallback(async () => {
    try {
      setTwoFactor(await api.twoFactorStatus());
      setTwoFactorError(null);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onSessionExpired();
      setTwoFactorError(caught instanceof ApiError ? caught.message : 'Could not load settings.');
    }
  }, [onSessionExpired]);

  useEffect(() => {
    void loadTwoFactor();
  }, [loadTwoFactor]);

  const handleSignOut = async () => {
    try {
      await api.logout();
    } finally {
      onSignOut();
    }
  };

  const ready = twoFactor?.method === 'totp';

  return (
    <div className="min-h-screen bg-white text-black">
      <div className="font-body max-w-4xl mx-auto px-6 py-10 sm:py-14 space-y-10">
        <header className="space-y-3">
          <div className="flex items-center gap-2 text-slate">
            <LogoMark size={20} />
            <p className="text-xs tracking-widest uppercase font-medium">Cut Through Faster</p>
          </div>
          <div className="flex items-center justify-between gap-4">
            <h1 className="font-display text-2xl sm:text-3xl font-semibold tracking-tight">
              Admin console
            </h1>
            {ready && <NoticeBell />}
          </div>
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-gray-500 truncate">Signed in as {session.user.email}</p>
            <button
              type="button"
              onClick={() => void handleSignOut()}
              className="text-xs text-gray-400 hover:text-black transition flex items-center gap-1.5 shrink-0"
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
              Sign out
            </button>
          </div>
        </header>

        {twoFactorError && (
          <Banner tone="error" onRetry={() => void loadTwoFactor()}>
            {twoFactorError}
          </Banner>
        )}

        {!twoFactor && !twoFactorError ? (
          <StatGridSkeleton />
        ) : !ready ? (
          <section className="space-y-5">
            <div className="flex items-start gap-3 border border-line rounded-2xl p-5">
              <ShieldCheck className="h-5 w-5 shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-sm text-slate leading-relaxed">
                The console opens once this account has an authenticator app. After that, every
                sign-in asks for a code, and every suspension, disable or block asks for a fresh
                one.
              </p>
            </div>
            <SecurityPanel adminMode />
            <button
              type="button"
              onClick={() => void loadTwoFactor()}
              className="bg-black text-white rounded-xl px-5 py-2.5 text-sm font-medium hover:bg-gray-800 transition"
            >
              I have set it up — open the console
            </button>
          </section>
        ) : (
          <Console onSessionExpired={onSessionExpired} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** What an action dialog is about to do. */
type PendingAction =
  | { kind: 'org'; id: string; name: string; action: OrgAction }
  | { kind: 'account'; id: string; name: string; action: AccountAction };

function Console({ onSessionExpired }: { onSessionExpired: () => void }) {
  const [period, setPeriod] = useState<AdminPeriod>('this-month');
  const overview = usePoll((signal) => api.adminOverview(period, signal), 60_000, {
    deps: [period],
  });
  const accounts = usePoll((signal) => api.adminAccounts(signal), 60_000);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [activityKey, setActivityKey] = useState(0);

  useEffect(() => {
    if ([overview.error, accounts.error].some((error) => error?.status === 401)) {
      onSessionExpired();
    }
  }, [overview.error, accounts.error, onSessionExpired]);

  const afterAction = useCallback(() => {
    overview.refresh();
    accounts.refresh();
    setActivityKey((key) => key + 1);
  }, [overview, accounts]);

  return (
    <>
      <section className="space-y-5">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <h2 className="font-display text-lg font-semibold">Clients</h2>
          <SegmentedControl
            ariaLabel="Billing month"
            value={period}
            onChange={setPeriod}
            options={[
              { value: 'this-month', label: 'This month' },
              { value: 'last-month', label: 'Last month' },
            ]}
          />
        </div>

        {overview.error && !overview.data ? (
          <Banner tone="error" onRetry={overview.refresh}>
            {overview.error.message}
          </Banner>
        ) : !overview.data ? (
          <>
            <StatGridSkeleton />
            <TableSkeleton label="Loading clients" rows={3} />
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <StatCard
                label="Active clients"
                value={`${overview.data.totals.active} / ${overview.data.totals.clients}`}
              />
              <StatCard label="Calls taken" value={overview.data.totals.calls} />
              <StatCard label="Appointments booked" value={overview.data.totals.booked} />
              <StatCard label="Minutes used" value={overview.data.totals.minutesUsed} />
              <StatCard label="Extra minutes" value={overview.data.totals.extraMinutes} />
              <StatCard label="Overage" value={formatZar(overview.data.totals.extraCostZar)} />
            </div>

            {overview.data.clients.length === 0 ? (
              <p className="text-sm text-slate border border-line rounded-2xl p-5">
                No clients yet. A business that signs up appears here, waiting for approval.
              </p>
            ) : (
              <ul className="space-y-3">
                {overview.data.clients.map((client) => (
                  <ClientCard
                    key={client.id}
                    client={client}
                    onAction={(action) =>
                      setPending({ kind: 'org', id: client.id, name: client.name, action })
                    }
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <AccountsSection
        data={accounts.data}
        error={accounts.error}
        onRetry={accounts.refresh}
        onAction={(account, action) =>
          setPending({ kind: 'account', id: account.id, name: account.name, action })
        }
      />

      <ActivitySection key={activityKey} />

      <ActionDialog pending={pending} onClose={() => setPending(null)} onDone={afterAction} />
    </>
  );
}

// ---------------------------------------------------------------------------

const ORG_STANDING_LABEL: Record<OrgStanding, string> = {
  active: 'Active',
  pending: 'Waiting for approval',
  suspended: 'Suspended',
  blocked: 'Blocked',
};

function StandingPill({ standing }: { standing: OrgStanding | AccountStanding }) {
  const tone =
    standing === 'active'
      ? 'border-gray-200 text-gray-600'
      : standing === 'blocked'
        ? 'border-red-200 bg-red-50 text-red-700'
        : standing === 'suspended' || standing === 'disabled'
          ? 'border-amber-200 bg-amber-50 text-amber-800'
          : 'border-gray-200 bg-cream text-slate';
  const label =
    standing in ORG_STANDING_LABEL
      ? ORG_STANDING_LABEL[standing as OrgStanding]
      : standing.charAt(0).toUpperCase() + standing.slice(1);
  return (
    <span className={`text-xs font-medium px-2.5 py-1 rounded-full border shrink-0 ${tone}`}>
      {label}
    </span>
  );
}

function ClientCard({
  client,
  onAction,
}: {
  client: AdminClient;
  onAction: (action: OrgAction) => void;
}) {
  const { billing } = client;
  return (
    <li className="border border-gray-200 rounded-2xl p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-medium truncate">{client.name}</p>
          <p className="text-xs text-gray-400">
            {client.activeLogins} of {client.logins} logins active
            {client.lastSignInAt
              ? ` · last sign-in ${formatRelativeDate(client.lastSignInAt, CTF_TIME_ZONE)}`
              : ' · never signed in'}
          </p>
        </div>
        <StandingPill standing={client.standing} />
      </div>

      <dl className="grid grid-cols-3 sm:grid-cols-6 gap-3 text-center">
        <Figure label="Calls" value={client.calls} />
        <Figure label="Booked" value={client.booked} />
        <Figure label="Booking rate" value={`${client.bookingRate}%`} />
        <Figure label="Minutes" value={`${billing.minutesUsed} / ${billing.planMinutes}`} />
        <Figure label="Extra min" value={billing.extraMinutes} />
        <Figure label="Overage" value={formatZar(billing.extraCostZar)} />
      </dl>

      {client.statusReason && client.standing !== 'active' && (
        <p className="text-xs text-slate">Reason: {client.statusReason}</p>
      )}

      {client.standing !== 'blocked' && (
        <div className="flex flex-wrap gap-2 pt-1">
          {client.standing !== 'active' && (
            <ActionButton onClick={() => onAction('activate')}>
              {client.standing === 'pending' ? 'Approve' : 'Reactivate'}
            </ActionButton>
          )}
          {client.standing !== 'suspended' && (
            <ActionButton onClick={() => onAction('suspend')}>Suspend</ActionButton>
          )}
          <ActionButton danger onClick={() => onAction('block')}>
            Block
          </ActionButton>
        </div>
      )}
    </li>
  );
}

function Figure({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dd className="font-display text-base font-semibold tabular-nums">{value}</dd>
      <dt className="text-[11px] text-gray-400 mt-0.5">{label}</dt>
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  danger = false,
}: {
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs font-medium px-3 py-1.5 rounded-lg border transition ${
        danger
          ? 'border-red-200 text-red-700 hover:bg-red-50'
          : 'border-gray-200 text-gray-700 hover:border-black hover:text-black'
      }`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------

type AccountFilter = 'all' | 'active' | 'inactive';

function AccountsSection({
  data,
  error,
  onRetry,
  onAction,
}: {
  data: { accounts: AdminAccount[]; totals: { total: number; active: number; inactive: number } } | null;
  error: ApiError | null;
  onRetry: () => void;
  onAction: (account: AdminAccount, action: AccountAction) => void;
}) {
  const [filter, setFilter] = useState<AccountFilter>('all');
  const visible = useMemo(
    () =>
      (data?.accounts ?? []).filter((account) =>
        filter === 'all'
          ? true
          : filter === 'active'
            ? account.standing === 'active'
            : account.standing !== 'active',
      ),
    [data, filter],
  );

  return (
    <section className="space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h2 className="font-display text-lg font-semibold">Accounts</h2>
        <SegmentedControl
          ariaLabel="Filter accounts"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `All${data ? ` (${data.totals.total})` : ''}` },
            { value: 'active', label: `Active${data ? ` (${data.totals.active})` : ''}` },
            { value: 'inactive', label: `Inactive${data ? ` (${data.totals.inactive})` : ''}` },
          ]}
        />
      </div>

      {error && !data ? (
        <Banner tone="error" onRetry={onRetry}>
          {error.message}
        </Banner>
      ) : !data ? (
        <TableSkeleton label="Loading accounts" rows={4} />
      ) : visible.length === 0 ? (
        <p className="text-sm text-slate border border-line rounded-2xl p-5">
          {data.totals.total === 0 ? 'No client logins yet.' : 'No accounts match this filter.'}
        </p>
      ) : (
        <ul className="border border-gray-200 rounded-2xl divide-y divide-gray-100">
          {visible.map((account) => (
            <li key={account.id} className="p-4 flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">
                  {account.name}{' '}
                  <span className="text-gray-400 font-normal">· {account.orgName}</span>
                </p>
                <p className="text-xs text-gray-400 truncate">
                  {account.email} · {account.role}
                  {account.lastSignInAt
                    ? ` · signed in ${formatRelativeDate(account.lastSignInAt, CTF_TIME_ZONE)}`
                    : ' · never signed in'}
                </p>
                {account.holdReason && (
                  <p className="text-xs text-slate mt-1">Reason: {account.holdReason}</p>
                )}
              </div>
              <StandingPill standing={account.standing} />
              {account.standing !== 'blocked' && (
                <div className="flex gap-2">
                  {account.standing === 'disabled' && account.holdReason ? (
                    <ActionButton onClick={() => onAction(account, 'enable')}>Re-enable</ActionButton>
                  ) : account.standing !== 'disabled' ? (
                    <ActionButton onClick={() => onAction(account, 'disable')}>Disable</ActionButton>
                  ) : null}
                  <ActionButton danger onClick={() => onAction(account, 'block')}>
                    Block
                  </ActionButton>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

function ActivitySection() {
  const [items, setItems] = useState<AdminActivityItem[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (before: number | null) => {
    try {
      const page = await api.adminActivity(before);
      setItems((current) => (before && current ? [...current, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load activity.');
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <section className="space-y-5">
      <h2 className="font-display text-lg font-semibold">Platform activity</h2>
      {error && !items ? (
        <Banner tone="error" onRetry={() => void load(null)}>
          {error}
        </Banner>
      ) : !items ? (
        <TableSkeleton label="Loading activity" rows={5} />
      ) : items.length === 0 ? (
        <p className="text-sm text-slate border border-line rounded-2xl p-5">No activity yet.</p>
      ) : (
        <>
          <ul className="border border-gray-200 rounded-2xl divide-y divide-gray-100">
            {items.map((item) => (
              <li key={item.id} className="px-4 py-3 flex items-baseline justify-between gap-4">
                <p className="text-sm min-w-0">
                  <span className="font-medium">{item.byCtf ? 'CTF' : (item.actorName ?? 'Someone')}</span>{' '}
                  <span className="text-gray-600">{item.label.charAt(0).toLowerCase() + item.label.slice(1)}</span>
                  {item.orgName && <span className="text-gray-400"> · {item.orgName}</span>}
                </p>
                <time
                  className="text-xs text-gray-400 shrink-0"
                  title={formatAbsolute(item.at, CTF_TIME_ZONE)}
                >
                  {formatRelativeDate(item.at, CTF_TIME_ZONE)}
                </time>
              </li>
            ))}
          </ul>
          {cursor && (
            <button
              type="button"
              disabled={loadingMore}
              onClick={async () => {
                setLoadingMore(true);
                await load(cursor);
                setLoadingMore(false);
              }}
              className="w-full border border-gray-200 rounded-xl py-2.5 text-sm text-gray-600 hover:border-black hover:text-black transition disabled:opacity-50"
            >
              {loadingMore ? 'Loading…' : 'Show older activity'}
            </button>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

function NoticeBell() {
  const notices = usePoll((signal) => api.adminNotices(signal), 60_000);
  const [open, setOpen] = useState(false);
  const unread = notices.data?.unread ?? 0;

  const markRead = async () => {
    await api.markAdminNoticesRead();
    notices.refresh();
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={unread ? `${unread} unread notifications` : 'Notifications'}
        aria-expanded={open}
        className="relative p-2 rounded-full border border-gray-200 hover:border-black transition"
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-black text-white text-[10px] font-semibold flex items-center justify-center">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 max-w-[calc(100vw-3rem)] bg-white border border-gray-200 rounded-2xl shadow-xl z-40">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <p className="text-sm font-medium">Notifications</p>
            {unread > 0 && (
              <button
                type="button"
                onClick={() => void markRead()}
                className="text-xs underline underline-offset-2"
              >
                Mark all read
              </button>
            )}
          </div>
          {!notices.data ? (
            <p className="px-4 py-4 text-sm text-slate">Loading…</p>
          ) : notices.data.items.length === 0 ? (
            <p className="px-4 py-4 text-sm text-slate">Nothing yet.</p>
          ) : (
            <ul className="max-h-80 overflow-y-auto divide-y divide-gray-100">
              {notices.data.items.map((notice) => (
                <li key={notice.id} className="px-4 py-3">
                  <p className={`text-sm ${notice.read ? 'text-gray-500' : 'font-medium'}`}>
                    {notice.summary}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {formatRelativeDate(notice.at, CTF_TIME_ZONE)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

const ACTION_COPY: Record<
  string,
  { title: (name: string) => string; body: string; confirm: string; danger: boolean; reason: boolean }
> = {
  'org:activate': {
    title: (name) => `Activate ${name}?`,
    body: 'Every login in this organization can use the dashboard again straight away.',
    confirm: 'Activate',
    danger: false,
    reason: false,
  },
  'org:suspend': {
    title: (name) => `Suspend ${name}?`,
    body: 'Everyone in this organization is signed out now and kept out until you reactivate it. Their data is kept. Use this for an unpaid subscription.',
    confirm: 'Suspend',
    danger: true,
    reason: true,
  },
  'org:block': {
    title: (name) => `Block ${name} permanently?`,
    body: 'Every login is closed, every address it used is barred from signing up again, and the console cannot undo this. Use it for serious or repeated breaches of CTF’s rules.',
    confirm: 'Block permanently',
    danger: true,
    reason: true,
  },
  'account:disable': {
    title: (name) => `Disable ${name}?`,
    body: 'This login is signed out now and kept out until you re-enable it. Their own organization cannot re-enable it.',
    confirm: 'Disable',
    danger: true,
    reason: true,
  },
  'account:enable': {
    title: (name) => `Re-enable ${name}?`,
    body: 'This login can sign in again straight away.',
    confirm: 'Re-enable',
    danger: false,
    reason: false,
  },
  'account:block': {
    title: (name) => `Block ${name} permanently?`,
    body: 'This login is closed and its address is barred from the platform. The console cannot undo this.',
    confirm: 'Block permanently',
    danger: true,
    reason: true,
  },
};

/**
 * Confirms an enforcement action, collects its reason, and — when the server
 * says the session's re-verification window has lapsed — asks for a fresh
 * authenticator code and then carries the same action out.
 */
function ActionDialog({
  pending,
  onClose,
  onDone,
}: {
  pending: PendingAction | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReason('');
    setCode('');
    setNeedsCode(false);
    setError(null);
  }, [pending]);

  if (!pending) return null;
  const copy = ACTION_COPY[`${pending.kind}:${pending.action}`];
  if (!copy) return null;

  const run = () =>
    pending.kind === 'org'
      ? api.adminOrgAction(pending.id, pending.action, reason)
      : api.adminAccountAction(pending.id, pending.action, reason);

  const confirm = async () => {
    if (copy.reason && reason.trim().length < 3) {
      setError('Give a reason. It is recorded, and the client may ask for it.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (needsCode) await api.adminStepUp(code.trim());
      await run();
      onDone();
      onClose();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'step_up_required') {
        setNeedsCode(true);
        setError(null);
      } else {
        setError(caught instanceof ApiError ? caught.message : 'That did not work. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open
      title={copy.title(pending.name)}
      description={<p>{copy.body}</p>}
      confirmLabel={needsCode ? 'Confirm with code' : copy.confirm}
      destructive={copy.danger}
      busy={busy}
      onConfirm={() => void confirm()}
      onCancel={onClose}
      initialFocus={copy.reason || needsCode ? 'children' : 'confirm'}
    >
      <div className="space-y-3">
        {copy.reason && (
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-gray-600">Reason (recorded)</span>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={300}
              rows={2}
              autoFocus={!needsCode}
              disabled={needsCode}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-black disabled:bg-cream"
            />
          </label>
        )}
        {needsCode && (
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-gray-600">
              Code from your authenticator app
            </span>
            <input
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono-data tracking-widest focus:outline-none focus:border-black"
            />
            <span className="block text-xs text-gray-400">
              Confirms it is you. Good for five minutes of further actions.
            </span>
          </label>
        )}
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    </ConfirmDialog>
  );
}
