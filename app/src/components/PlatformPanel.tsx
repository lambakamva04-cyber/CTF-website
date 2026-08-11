import { Building2, Check, Pause, Play } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { OrgStatus, PlatformOverview } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { formatRelativeDate } from '../lib/format';
import { Banner, SegmentedControl, Spinner } from './ui';

type Period = 'this-month' | 'last-month' | 'all-time';

/**
 * The Cut Through Faster view across every client.
 *
 * Billing figures only — calls, bookings, minutes. There is no drill-down into
 * a client's calls here, and no caller name, number or transcript is fetched,
 * because the privacy policy tells clients exactly that.
 */
export function PlatformPanel({ timeZone }: { timeZone: string }) {
  const [period, setPeriod] = useState<Period>('this-month');
  const [data, setData] = useState<PlatformOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (selected: Period) => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.platformOverview(selected));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load the overview.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(period);
  }, [period, load]);

  const setStatus = async (orgId: string, status: OrgStatus) => {
    setBusyId(orgId);
    setError(null);
    try {
      await api.setOrgStatus(orgId, status);
      await load(period);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not update that client.');
    } finally {
      setBusyId(null);
    }
  };

  const pending = data?.organizations.filter((org) => org.status === 'pending') ?? [];

  return (
    <section className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-display text-lg font-semibold flex items-center gap-2">
          <Building2 className="h-4 w-4" aria-hidden="true" />
          All clients
        </h2>
        <SegmentedControl
          ariaLabel="Billing period"
          value={period}
          onChange={setPeriod}
          options={[
            { value: 'this-month', label: 'This month' },
            { value: 'last-month', label: 'Last month' },
            { value: 'all-time', label: 'All time' },
          ]}
        />
      </div>

      <p className="text-xs text-slate">
        Billing figures only. Caller names, numbers, transcripts and recordings are not shown here
        — the privacy policy promises clients as much.
      </p>

      {error && <Banner tone="error" onRetry={() => void load(period)}>{error}</Banner>}

      {pending.length > 0 && (
        <Banner tone="warning">
          {pending.length} {pending.length === 1 ? 'business is' : 'businesses are'} waiting to be
          activated.
        </Banner>
      )}

      {loading && !data ? (
        <Spinner label="Loading clients" />
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Clients', value: data?.totals.active ?? 0 },
              { label: 'Pending', value: data?.totals.pending ?? 0 },
              { label: 'Calls', value: data?.totals.calls ?? 0 },
              { label: 'Minutes', value: data?.totals.minutes ?? 0 },
            ].map((stat) => (
              <div key={stat.label} className="border border-line rounded-xl p-4 text-center bg-white">
                <p className="font-display text-xl font-semibold tabular-nums">{stat.value}</p>
                <p className="text-xs text-slate mt-1">{stat.label}</p>
              </div>
            ))}
          </div>

          <div className="border border-line rounded-xl overflow-x-auto bg-white">
            <table className="w-full text-sm min-w-[38rem]">
              <thead>
                <tr className="text-left text-xs text-slate border-b border-line">
                  <th className="px-4 py-3 font-medium">Business</th>
                  <th className="px-4 py-3 font-medium text-right">Calls</th>
                  <th className="px-4 py-3 font-medium text-right">Booked</th>
                  <th className="px-4 py-3 font-medium text-right">Rate</th>
                  <th className="px-4 py-3 font-medium text-right">Minutes</th>
                  <th className="px-4 py-3 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {(data?.organizations ?? []).map((org) => (
                  <tr key={org.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-3">
                      <p className="font-medium">{org.name}</p>
                      <p className="text-xs text-slate">
                        {org.status === 'active' ? (
                          <span className="text-green-700">Active</span>
                        ) : org.status === 'pending' ? (
                          <span className="text-amber-700">Pending</span>
                        ) : (
                          <span className="text-red-700">Suspended</span>
                        )}
                        {' · '}
                        {org.logins} {org.logins === 1 ? 'login' : 'logins'}
                        {org.lastCallAt
                          ? ` · last call ${formatRelativeDate(org.lastCallAt, timeZone)}`
                          : ' · no calls yet'}
                      </p>
                      {org.signupNote && (
                        <p className="text-xs text-slate italic mt-1">“{org.signupNote}”</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{org.calls}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{org.booked}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{org.bookingRate}%</td>
                    <td className="px-4 py-3 text-right tabular-nums">{org.minutes}</td>
                    <td className="px-4 py-3 text-right">
                      {org.status === 'active' ? (
                        <button
                          type="button"
                          onClick={() => void setStatus(org.id, 'suspended')}
                          disabled={busyId === org.id}
                          className="text-xs text-slate hover:text-ink underline underline-offset-2 disabled:opacity-40 inline-flex items-center gap-1"
                        >
                          <Pause className="h-3 w-3" aria-hidden="true" />
                          Suspend
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void setStatus(org.id, 'active')}
                          disabled={busyId === org.id}
                          className="text-xs font-medium underline underline-offset-2 disabled:opacity-40 inline-flex items-center gap-1"
                        >
                          {org.status === 'pending' ? (
                            <Check className="h-3 w-3" aria-hidden="true" />
                          ) : (
                            <Play className="h-3 w-3" aria-hidden="true" />
                          )}
                          {org.status === 'pending' ? 'Activate' : 'Restore'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {(data?.organizations.length ?? 0) === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-slate">
                      No client organizations yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
