import type { Metadata } from 'next';

import {
  getDemoFunnel,
  getInterestedLeads,
  getOutreachStats,
  getProspectEngagement,
  type DemoFunnel,
  type InterestedLead,
  type OutreachStats,
  type ProspectEngagement,
} from '@/lib/analytics';

import {
  EmptyState,
  FunnelBar,
  SectionCard,
  StatTile,
  StatusBadge,
  relativeTime,
  type FunnelStage,
  type StatusKey,
} from './_components/ui';

// Live numbers on every load; never cached. The data is small and the audience
// is one founder, so freshness beats any caching saved here.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Dashboard — Cut Through Faster',
  robots: { index: false, follow: false },
};

/** Unwrap a settled promise, or null if it rejected (e.g. a table not yet created). */
function value<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null;
}

function engagementStatus(row: ProspectEngagement): StatusKey {
  if (row.calls > 0) return 'called';
  if (row.opened) return 'opened';
  return 'idle';
}

function fmtDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default async function AdminDashboard() {
  // Demo data (prospects + demo_events) is live now; outreach data depends on
  // migration 0014 being applied, so its queries may reject until then.
  const [funnelR, engagementR, outreachR, interestedR] = await Promise.allSettled([
    getDemoFunnel(),
    getProspectEngagement(),
    getOutreachStats(),
    getInterestedLeads(),
  ]);

  const funnel: DemoFunnel | null = value(funnelR);
  const engagement: ProspectEngagement[] = value(engagementR) ?? [];
  const outreach: OutreachStats | null = value(outreachR);
  const interested: InterestedLead[] | null = value(interestedR);
  const outreachPending = outreachR.status === 'rejected';

  const asOf = new Date().toLocaleString('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const demoStages: FunnelStage[] = funnel
    ? [
        { label: 'Seeded', value: funnel.prospects, fam: 'neutral' },
        { label: 'Opened', value: funnel.opened, fam: 'neutral' },
        { label: 'Called', value: funnel.callStarted, fam: 'amber' },
        { label: 'Completed', value: funnel.callEnded, fam: 'success' },
      ]
    : [];

  const outreachStages: FunnelStage[] = outreach
    ? [
        { label: 'Connects', value: outreach.connectsSent, fam: 'neutral' },
        { label: 'DMs', value: outreach.dmsSent, fam: 'neutral' },
        { label: 'Emails', value: outreach.emailsSent, fam: 'neutral' },
        { label: 'Responses', value: outreach.responses, fam: 'info' },
        { label: 'Interested', value: outreach.interested, fam: 'success' },
      ]
    : [];

  return (
    <div className="min-h-dvh bg-[var(--ctf-paper)] font-[var(--ctf-font-sans)] text-[var(--ctf-ink)]">
      <header className="sticky top-0 z-30 border-b border-[var(--ctf-line)] bg-[var(--ctf-paper)]/90 backdrop-blur">
        <div className="mx-auto flex h-[60px] max-w-[var(--ctf-shell-max)] items-center justify-between px-5 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="ctf-pulse inline-block h-2 w-2 rounded-full bg-[var(--ctf-signal)]" />
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--ctf-ink-faint)]">
              Cut Through Faster
            </span>
            <span className="text-[var(--ctf-line-strong)]">/</span>
            <h1 className="font-[var(--ctf-font-display)] text-[15px] font-semibold tracking-[-0.01em]">Dashboard</h1>
          </div>
          <span className="font-mono text-[11px] text-[var(--ctf-ink-faint)]">as of {asOf}</span>
        </div>
      </header>

      <main className="mx-auto max-w-[var(--ctf-shell-max)] space-y-9 px-5 py-8 sm:px-6">
        <div>
          <h2 className="font-[var(--ctf-font-display)] text-[clamp(1.875rem,1.4rem+1.6vw,2.375rem)] font-bold leading-[1.12] tracking-[-0.025em]">
            Outreach overview
          </h2>
          <p className="mt-2 text-[15px] leading-relaxed text-[var(--ctf-ink-soft)]">
            Every prospect in the campaign, who has opened or called their demo, and where each one sits in the
            outreach cadence.
          </p>
        </div>

        {/* KPI row */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile label="Prospects" value={funnel ? funnel.prospects : '—'} hint="in the campaign" />
          <StatTile
            label="Demo opens"
            value={funnel ? funnel.opened : '—'}
            hint={funnel ? `${funnel.callStarted} called the demo` : undefined}
          />
          <StatTile
            label="Calls completed"
            value={funnel ? funnel.callEnded : '—'}
            hint={funnel ? `avg ${fmtDuration(funnel.avgCallSeconds)}` : undefined}
          />
          <StatTile label="Emails sent" value={outreach ? outreach.emailsSent : '—'} hint="from your tracker" />
          <StatTile label="Follow-ups" value={outreach ? outreach.followupsSent : '—'} hint="sent in total" />
          <StatTile label="Responses" value={outreach ? outreach.responses : '—'} hint="replied to date" />
          <StatTile label="Interested" value={outreach ? outreach.interested : '—'} hint="marked interested" />
          <StatTile label="Opted out" value={outreach ? outreach.optedOut : '—'} hint="unsubscribed" />
        </div>

        {/* Funnels */}
        <div className="grid gap-5 lg:grid-cols-2">
          <SectionCard title="Demo engagement" meta="live">
            {funnel ? (
              <>
                <FunnelBar stages={demoStages} />
                <div className="mt-5 flex flex-wrap gap-x-6 gap-y-1 border-t border-[var(--ctf-line)] pt-4 font-mono text-[12px] text-[var(--ctf-ink-faint)]">
                  <span>total calls {funnel.totalCalls}</span>
                  <span>median {fmtDuration(funnel.medianCallSeconds)}</span>
                  <span>mic denied {funnel.micDenied}</span>
                  <span>link expired {funnel.linkExpired}</span>
                </div>
              </>
            ) : (
              <EmptyState>Couldn&apos;t load demo events right now.</EmptyState>
            )}
          </SectionCard>

          <SectionCard title="Outreach cadence" meta={outreach ? 'from tracker' : 'pending'}>
            {outreach ? (
              <FunnelBar stages={outreachStages} />
            ) : outreachPending ? (
              <EmptyState>
                Outreach tables aren&apos;t created yet. Apply migration{' '}
                <code className="font-mono">0014_outreach_tracking.sql</code> and import your cadence tracker to light
                this up.
              </EmptyState>
            ) : (
              <EmptyState>Couldn&apos;t load outreach data right now.</EmptyState>
            )}
          </SectionCard>
        </div>

        {/* Per-prospect engagement */}
        <SectionCard title="Prospects" meta={`${engagement.length} total`}>
          {engagement.length === 0 ? (
            <EmptyState>No prospects seeded yet.</EmptyState>
          ) : (
            <div className="overflow-x-auto rounded-[var(--ctf-radius-sm)] border border-[var(--ctf-line)]">
              <table className="w-full border-collapse text-left text-[14px]">
                <thead className="bg-[var(--ctf-surface-2)]">
                  <tr className="border-b border-[var(--ctf-line)] text-[var(--ctf-ink-faint)]">
                    <th className="px-4 py-3 font-mono text-[11px] font-medium uppercase tracking-[0.14em]">Practice</th>
                    <th className="px-4 py-3 font-mono text-[11px] font-medium uppercase tracking-[0.14em]">Status</th>
                    <th className="px-4 py-3 text-right font-mono text-[11px] font-medium uppercase tracking-[0.14em]">Calls</th>
                    <th className="px-4 py-3 text-right font-mono text-[11px] font-medium uppercase tracking-[0.14em]">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {engagement.map((row) => (
                    <tr
                      key={row.prospectId}
                      className="border-b border-[var(--ctf-line)] last:border-0 even:bg-[var(--ctf-paper-dim)]/40"
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium text-[var(--ctf-ink)]">{row.practiceName}</div>
                        {row.suburb ? (
                          <div className="text-[12px] text-[var(--ctf-ink-faint)]">{row.suburb}</div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={engagementStatus(row)} />
                      </td>
                      <td className="ctf-nums px-4 py-3 text-right text-[var(--ctf-ink-soft)]">{row.calls}</td>
                      <td className="ctf-nums px-4 py-3 text-right text-[var(--ctf-ink-faint)]">
                        {relativeTime(row.lastEventAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        {/* Interested leads */}
        <SectionCard title="Interested leads" meta={interested ? `${interested.length}` : 'pending'}>
          {!interested ? (
            <EmptyState>
              Appears once migration <code className="font-mono">0014_outreach_tracking.sql</code> is applied and you
              mark prospects interested in your tracker.
            </EmptyState>
          ) : interested.length === 0 ? (
            <EmptyState>No interested leads yet — mark them in your tracker and they&apos;ll surface here.</EmptyState>
          ) : (
            <div className="overflow-x-auto rounded-[var(--ctf-radius-sm)] border border-[var(--ctf-line)]">
              <table className="w-full border-collapse text-left text-[14px]">
                <thead className="bg-[var(--ctf-surface-2)]">
                  <tr className="border-b border-[var(--ctf-line)] text-[var(--ctf-ink-faint)]">
                    <th className="px-4 py-3 font-mono text-[11px] font-medium uppercase tracking-[0.14em]">Contact</th>
                    <th className="px-4 py-3 font-mono text-[11px] font-medium uppercase tracking-[0.14em]">Practice</th>
                    <th className="px-4 py-3 font-mono text-[11px] font-medium uppercase tracking-[0.14em]">Reach</th>
                    <th className="px-4 py-3 text-right font-mono text-[11px] font-medium uppercase tracking-[0.14em]">Since</th>
                  </tr>
                </thead>
                <tbody>
                  {interested.map((lead, i) => (
                    <tr
                      key={`${lead.slug}-${i}`}
                      className="border-b border-[var(--ctf-line)] last:border-0 even:bg-[var(--ctf-paper-dim)]/40"
                    >
                      <td className="px-4 py-3 font-medium text-[var(--ctf-ink)]">{lead.contactName ?? '—'}</td>
                      <td className="px-4 py-3">
                        <div className="text-[var(--ctf-ink)]">{lead.practiceName}</div>
                        {lead.suburb ? (
                          <div className="text-[12px] text-[var(--ctf-ink-faint)]">{lead.suburb}</div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-[13px]">
                        <div className="flex flex-col gap-0.5">
                          {lead.contactEmail ? (
                            <a
                              className="text-[var(--ctf-signal-strong)] underline-offset-2 hover:underline"
                              href={`mailto:${lead.contactEmail}`}
                            >
                              {lead.contactEmail}
                            </a>
                          ) : null}
                          {lead.linkedinUrl ? (
                            <a
                              className="text-[var(--ctf-ink-soft)] underline-offset-2 hover:underline"
                              href={lead.linkedinUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              LinkedIn
                            </a>
                          ) : null}
                          <a
                            className="text-[var(--ctf-ink-soft)] underline-offset-2 hover:underline"
                            href={lead.demoUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Demo
                          </a>
                        </div>
                      </td>
                      <td className="ctf-nums px-4 py-3 text-right text-[var(--ctf-ink-faint)]">
                        {relativeTime(lead.interestedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        <p className="pb-4 text-center font-mono text-[11px] text-[var(--ctf-ink-faint)]">
          Demo opens &amp; calls are live. Emails, follow-ups, responses &amp; interest come from your cadence tracker
          import. Opt-outs come from the unsubscribe link.
        </p>
      </main>
    </div>
  );
}
