import { LogOut } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type {
  CallSummary,
  MeResponse,
  MetricsResponse,
  Period,
} from '../../shared/types';
import { CallRow } from '../components/CallRow';
import { LiveCallPanel } from '../components/LiveCallPanel';
import { Banner, SegmentedControl, Spinner, StatCard, StatusPill } from '../components/ui';
import { usePoll } from '../hooks/usePoll';
import { useTranscript } from '../hooks/useTranscript';
import { api, ApiError } from '../lib/api';
import { outcomeLabel } from '../lib/format';

const TrendChart = lazy(() => import('../components/TrendChart'));

type Filter = 'all' | 'booked' | 'escalated';

interface Props {
  session: MeResponse;
  onSignOut: () => void;
  onSessionExpired: () => void;
}

export function Dashboard({ session, onSignOut, onSessionExpired }: Props) {
  const { user, org } = session;

  const [period, setPeriod] = useState<Period>('today');
  const [filter, setFilter] = useState<Filter>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [lastEnded, setLastEnded] = useState<{ name: string; outcome: string | null } | null>(null);

  const live = usePoll(api.liveCall, 3000);
  const liveCall = live.data?.call ?? null;
  const clockSkewMs = live.data ? live.data.now - Date.now() : 0;

  const transcript = useTranscript(liveCall?.id ?? null, liveCall !== null);

  const metrics = usePoll<MetricsResponse>(
    (signal) => api.metrics(period, signal),
    60_000,
    { deps: [period] },
  );

  const [calls, setCalls] = useState<CallSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [callsLoading, setCallsLoading] = useState(true);
  const [callsError, setCallsError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadCalls = useCallback(
    async (activeFilter: Filter, nextCursor: string | null) => {
      const append = nextCursor !== null;
      if (append) setLoadingMore(true);
      else setCallsLoading(true);
      setCallsError(null);

      try {
        const response = await api.calls(activeFilter, nextCursor);
        setCalls((previous) => (append ? [...previous, ...response.calls] : response.calls));
        setCursor(response.nextCursor);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          onSessionExpired();
          return;
        }
        setCallsError(
          error instanceof ApiError ? error.message : 'Could not load your recent calls.',
        );
      } finally {
        setCallsLoading(false);
        setLoadingMore(false);
      }
    },
    [onSessionExpired],
  );

  useEffect(() => {
    void loadCalls(filter, null);
  }, [filter, loadCalls]);

  // A session that expires mid-poll should land the client on the sign-in
  // screen rather than showing a wall of failing panels.
  useEffect(() => {
    const authFailure = [live.error, metrics.error, transcript.error].some(
      (error) => error?.status === 401,
    );
    if (authFailure) onSessionExpired();
  }, [live.error, metrics.error, transcript.error, onSessionExpired]);

  // When a call drops off the live endpoint it has ended: refresh the history
  // and metrics so the new row and updated booking rate appear immediately.
  const previousCallRef = useRef<typeof liveCall>(null);
  useEffect(() => {
    const previous = previousCallRef.current;
    previousCallRef.current = liveCall;

    if (previous && !liveCall) {
      setLastEnded({
        name: previous.callerName ?? previous.callerNumber ?? 'Caller',
        outcome: previous.outcome ? outcomeLabel(previous.outcome).toLowerCase() : null,
      });
      void loadCalls(filter, null);
      metrics.refresh();
    }
  }, [liveCall, filter, loadCalls, metrics]);

  const handleTakeover = async (number: string) => {
    if (!liveCall) throw new Error('That call has already ended.');
    const result = await api.takeover(liveCall.id, number || undefined);
    live.setData((previous) =>
      previous ? { ...previous, call: result.call } : previous,
    );
  };

  const handleEndCall = async () => {
    if (!liveCall) throw new Error('That call has already ended.');
    await api.endCall(liveCall.id);
    live.setData((previous) => (previous ? { ...previous, call: null } : previous));
    live.refresh();
  };

  const handleSignOut = async () => {
    try {
      await api.logout();
    } finally {
      onSignOut();
    }
  };

  const connectionError =
    live.stale && live.error && live.error.status !== 401
      ? 'Reconnecting to the live feed…'
      : null;

  return (
    <div className="min-h-screen bg-white text-black">
      <div className="font-body max-w-2xl mx-auto px-6 py-10 sm:py-14 space-y-10">
        <header className="space-y-2">
          <p className="text-xs tracking-widest uppercase text-gray-400 font-medium">
            Powered by Cut Through Faster
          </p>
          <div className="flex items-center justify-between gap-4">
            <h1 className="font-display text-2xl sm:text-3xl font-semibold tracking-tight truncate">
              {org.name}
            </h1>
            <StatusPill active={org.receptionistLinked} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-gray-500 truncate">Signed in as {user.name}</p>
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

        {connectionError && <Banner tone="warning" onRetry={live.refresh}>{connectionError}</Banner>}

        {live.loading && !live.data ? (
          <section className="border border-gray-200 rounded-2xl p-6 sm:p-8">
            <Spinner label="Checking for live calls" />
          </section>
        ) : (
          <LiveCallPanel
            call={liveCall}
            transcript={transcript.lines}
            user={user}
            org={org}
            clockSkewMs={clockSkewMs}
            lastEnded={lastEnded}
            connectionError={connectionError}
            onTakeover={handleTakeover}
            onEndCall={handleEndCall}
          />
        )}

        <section className="space-y-5">
          <h2 className="font-display text-lg font-semibold">Performance</h2>
          <SegmentedControl
            ariaLabel="Reporting period"
            value={period}
            onChange={setPeriod}
            options={[
              { value: 'today', label: 'Today' },
              { value: 'week', label: 'This Week' },
              { value: 'month', label: 'This Month' },
            ]}
          />

          {metrics.error && !metrics.data ? (
            <Banner tone="error" onRetry={metrics.refresh}>
              {metrics.error.message}
            </Banner>
          ) : metrics.loading && !metrics.data ? (
            <Spinner label="Loading performance" />
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3">
                <StatCard label="Calls Taken" value={metrics.data?.total ?? 0} />
                <StatCard label="Booked" value={metrics.data?.booked ?? 0} />
                <StatCard label="Booking Rate" value={`${metrics.data?.rate ?? 0}%`} />
              </div>

              {period !== 'today' && (metrics.data?.trend.length ?? 0) > 0 && (
                <div className="border border-gray-200 rounded-2xl p-5 sm:p-6">
                  <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-4">
                    {period === 'week' ? 'Last 7 Days' : 'Last 5 Weeks'}
                  </p>
                  <Suspense fallback={<div className="h-[140px]" aria-hidden="true" />}>
                    <TrendChart data={metrics.data?.trend ?? []} />
                  </Suspense>
                </div>
              )}
            </>
          )}
        </section>

        <section className="space-y-5">
          <h2 className="font-display text-lg font-semibold">Recent Activity</h2>
          <div className="flex gap-2">
            {(
              [
                { value: 'all', label: 'All' },
                { value: 'booked', label: 'Bookings' },
                { value: 'escalated', label: 'Escalated' },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={filter === option.value}
                onClick={() => {
                  setFilter(option.value);
                  setExpandedId(null);
                }}
                className={`text-xs px-3 py-1.5 rounded-full border transition font-medium ${
                  filter === option.value
                    ? 'border-black bg-black text-white'
                    : 'border-gray-200 text-gray-500 hover:border-black hover:text-black'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          {callsError && (
            <Banner tone="error" onRetry={() => void loadCalls(filter, null)}>
              {callsError}
            </Banner>
          )}

          {callsLoading ? (
            <Spinner label="Loading calls" />
          ) : (
            <div className="divide-y divide-gray-100 border-t border-b border-gray-100">
              {calls.map((call) => (
                <CallRow
                  key={call.id}
                  call={call}
                  timeZone={org.timezone}
                  expanded={expandedId === call.id}
                  onToggle={() => setExpandedId(expandedId === call.id ? null : call.id)}
                />
              ))}
              {calls.length === 0 && !callsError && (
                <p className="text-sm text-gray-400 py-6 text-center">
                  {filter === 'all'
                    ? 'No calls yet. They will appear here the moment your receptionist answers one.'
                    : 'No calls in this view yet.'}
                </p>
              )}
            </div>
          )}

          {cursor && (
            <button
              type="button"
              onClick={() => void loadCalls(filter, cursor)}
              disabled={loadingMore}
              className="w-full border border-gray-200 rounded-xl py-2.5 text-sm font-medium text-gray-600 hover:border-black hover:text-black transition disabled:opacity-50"
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </section>

        <footer className="text-center pt-4">
          <p className="text-xs text-gray-300">Cut Through Faster · AI Receptionist</p>
        </footer>
      </div>
    </div>
  );
}
