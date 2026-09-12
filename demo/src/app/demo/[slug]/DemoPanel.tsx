'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type Vapi from '@vapi-ai/web';

import {
  DEMO_MAX_SECONDS,
  formatCountdown,
  joinServices,
  type DemoEventBody,
  type PublicProspect,
} from '@/lib/demo';

type Phase = 'ready' | 'connecting' | 'live' | 'ended' | 'mic_denied' | 'failed' | 'expired';

type Props = {
  prospect: PublicProspect;
  bookingUrl: string;
  vapiPublicKey: string;
  vapiAssistantId: string;
};

/** If Vapi has not connected us by now, something is wrong. */
const CONNECT_TIMEOUT_MS = 25_000;

export default function DemoPanel({ prospect, bookingUrl, vapiPublicKey, vapiAssistantId }: Props) {
  const [phase, setPhase] = useState<Phase>(prospect.expired ? 'expired' : 'ready');
  const [remaining, setRemaining] = useState(DEMO_MAX_SECONDS);
  const [lastDuration, setLastDuration] = useState<number | null>(null);

  const vapiRef = useRef<Vapi | null>(null);
  const loaderRef = useRef<Promise<Vapi> | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const callActiveRef = useRef(false);
  const endLoggedRef = useRef(false);
  // Why we stopped, when we are the ones stopping.
  const intentRef = useRef<string | null>(null);
  // Whatever Vapi told us on its way out, from the status-update message.
  const reportedReasonRef = useRef<string | null>(null);

  const slug = prospect.slug;

  const sendEvent = useCallback(
    async (body: DemoEventBody) => {
      try {
        await fetch(`/api/demo/${encodeURIComponent(slug)}/event`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          // The call_ended write often races the tab closing.
          keepalive: true,
        });
      } catch {
        // Telemetry must never break the demo. A lost event costs us a row in
        // the funnel; a thrown error costs us the prospect.
      }
    },
    [slug],
  );

  // ---- page_view / link_expired -------------------------------------------
  const viewLoggedRef = useRef(false);
  useEffect(() => {
    if (viewLoggedRef.current) return; // React strict mode mounts twice in dev.
    viewLoggedRef.current = true;

    void sendEvent({ event_type: 'page_view' });
    if (prospect.expired) void sendEvent({ event_type: 'link_expired' });
  }, [prospect.expired, sendEvent]);

  // ---- SDK loading ---------------------------------------------------------
  // Loaded on mount rather than on click, for two reasons: the first paint
  // stays light because the import is split out of the initial bundle, and by
  // the time anyone taps the button the instance already exists — so
  // `vapi.start()` runs inside the click without waiting on a network fetch,
  // which is what iOS Safari requires before it will grant the microphone.
  const loadVapi = useCallback((): Promise<Vapi> => {
    if (!loaderRef.current) {
      loaderRef.current = import('@vapi-ai/web').then((mod) => {
        const instance = new mod.default(vapiPublicKey);
        vapiRef.current = instance;
        return instance;
      });
    }
    return loaderRef.current;
  }, [vapiPublicKey]);

  const finishCall = useCallback(() => {
    callActiveRef.current = false;
    if (endLoggedRef.current) return;
    endLoggedRef.current = true;

    const startedAt = startedAtRef.current;
    const duration = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
    setLastDuration(duration);

    void sendEvent({
      event_type: 'call_ended',
      duration_seconds: duration,
      ended_reason: intentRef.current ?? reportedReasonRef.current ?? 'customer-ended-call',
    });
  }, [sendEvent]);

  useEffect(() => {
    if (prospect.expired) return;

    let cancelled = false;

    const onCallStart = () => {
      if (cancelled) return;
      startedAtRef.current = Date.now();
      callActiveRef.current = true;
      endLoggedRef.current = false;
      setRemaining(DEMO_MAX_SECONDS);
      setPhase('live');
      void sendEvent({ event_type: 'call_started' });
    };

    const onCallEnd = () => {
      if (cancelled) return;
      finishCall();
      setPhase('ended');
    };

    // The web SDK's `call-end` carries no payload, so the only place Vapi's own
    // ended reason surfaces is the status-update message.
    const onMessage = (message: unknown) => {
      const m = message as { type?: string; status?: string; endedReason?: string };
      if (m?.type === 'status-update' && m.status === 'ended' && m.endedReason) {
        reportedReasonRef.current = m.endedReason;
      }
    };

    const onError = () => {
      if (cancelled) return;
      if (callActiveRef.current) {
        intentRef.current = intentRef.current ?? 'connection-error';
        finishCall();
      }
      setPhase('failed');
    };

    loadVapi()
      .then((vapi) => {
        if (cancelled) return;
        vapi.on('call-start', onCallStart);
        vapi.on('call-end', onCallEnd);
        vapi.on('message', onMessage);
        vapi.on('error', onError);
      })
      .catch(() => {
        // The click handler retries the import and surfaces the failure there.
      });

    return () => {
      cancelled = true;
      const vapi = vapiRef.current;
      if (!vapi) return;
      vapi.removeListener('call-start', onCallStart);
      vapi.removeListener('call-end', onCallEnd);
      vapi.removeListener('message', onMessage);
      vapi.removeListener('error', onError);
      if (callActiveRef.current) void vapi.stop();
    };
  }, [finishCall, loadVapi, prospect.expired, sendEvent]);

  // ---- the three-minute cap ------------------------------------------------
  // Driven off wall-clock time rather than a tick count, so a backgrounded tab
  // that throttles its timers still stops on schedule. Vapi is also told the
  // same limit as `maxDurationSeconds`, so this timer is the courtesy and the
  // server-side cap is the guarantee.
  useEffect(() => {
    if (phase !== 'live') return;

    const stopNow = () => {
      intentRef.current = 'demo-time-limit';
      void vapiRef.current?.stop();
    };

    const tick = () => {
      const startedAt = startedAtRef.current ?? Date.now();
      const left = DEMO_MAX_SECONDS - (Date.now() - startedAt) / 1000;
      setRemaining(Math.max(0, left));
      if (left <= 0) stopNow();
    };

    const interval = window.setInterval(tick, 250);
    // Backstop: one timer that fires at the cap even if the interval is starved.
    const startedAt = startedAtRef.current ?? Date.now();
    const hardStop = window.setTimeout(
      stopNow,
      Math.max(0, DEMO_MAX_SECONDS * 1000 - (Date.now() - startedAt)),
    );

    return () => {
      window.clearInterval(interval);
      window.clearTimeout(hardStop);
    };
  }, [phase]);

  // A closed tab mid-call would otherwise leave a call_started with no
  // call_ended, and the funnel would read as though the call never finished.
  useEffect(() => {
    if (phase !== 'live') return;
    const onPageHide = () => {
      if (!callActiveRef.current) return;
      intentRef.current = intentRef.current ?? 'page-closed';
      finishCall();
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [finishCall, phase]);

  // ---- starting ------------------------------------------------------------
  const handleStart = useCallback(async () => {
    if (phase === 'connecting' || phase === 'live' || phase === 'expired') return;

    setPhase('connecting');
    intentRef.current = null;
    reportedReasonRef.current = null;

    // The microphone is requested here, directly, rather than left to the SDK.
    // It must happen inside the click for iOS Safari to grant it at all, and
    // asking ourselves turns a refusal into a precise NotAllowedError we can
    // write plain-language instructions for.
    if (!navigator.mediaDevices?.getUserMedia) {
      setPhase('failed');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Permission is what we were after; Vapi opens its own stream.
      stream.getTracks().forEach((track) => track.stop());
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setPhase('mic_denied');
        void sendEvent({ event_type: 'mic_denied' });
      } else {
        setPhase('failed');
      }
      return;
    }

    const timeout = window.setTimeout(() => {
      setPhase((current) => (current === 'connecting' ? 'failed' : current));
    }, CONNECT_TIMEOUT_MS);

    try {
      const vapi = await loadVapi();
      await vapi.start(vapiAssistantId, buildOverrides(prospect));
    } catch {
      setPhase((current) => (current === 'connecting' ? 'failed' : current));
    } finally {
      window.clearTimeout(timeout);
    }
  }, [loadVapi, phase, prospect, sendEvent, vapiAssistantId]);

  const handleStop = useCallback(() => {
    intentRef.current = 'customer-ended-call';
    void vapiRef.current?.stop();
  }, []);

  // ---- rendering -----------------------------------------------------------
  const progress = Math.max(0, Math.min(1, remaining / DEMO_MAX_SECONDS));

  return (
    <section className="mt-7" aria-live="polite">
      {(phase === 'ready' || phase === 'connecting') && (
        <>
          <button
            type="button"
            onClick={handleStart}
            disabled={phase === 'connecting'}
            className="flex w-full items-center justify-center gap-3 rounded-xl bg-ink px-6 py-5 text-[17px] font-semibold text-paper transition-opacity hover:opacity-90 disabled:opacity-70"
          >
            {phase === 'connecting' ? (
              <>
                <Spinner />
                Connecting to Hope&hellip;
              </>
            ) : (
              <>
                <MicIcon />
                Talk to Hope
              </>
            )}
          </button>
          <p className="mt-3 text-center text-[13px] text-ink-faint">
            Uses your phone&rsquo;s microphone. Three minutes, one conversation, nothing to install.
          </p>
        </>
      )}

      {phase === 'live' && (
        <div className="rounded-xl border border-ink bg-white p-5">
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-2.5 text-[15px] font-semibold">
              <span className="ctf-pulse inline-block h-2.5 w-2.5 rounded-full bg-signal" />
              Hope is on the line
            </p>
            <p className="font-mono text-[15px] tabular-nums text-ink-soft">
              {formatCountdown(remaining)}
            </p>
          </div>

          <div
            className="mt-4 h-1 w-full overflow-hidden rounded-full bg-paper-dim"
            role="progressbar"
            aria-label="Time remaining in this demo"
            aria-valuemin={0}
            aria-valuemax={DEMO_MAX_SECONDS}
            aria-valuenow={Math.ceil(remaining)}
          >
            <div
              className="h-full rounded-full bg-signal transition-[width] duration-200 ease-linear"
              style={{ width: `${progress * 100}%` }}
            />
          </div>

          <p className="mt-4 text-[14px] leading-relaxed text-ink-soft">
            Try: &ldquo;Do you have anything Thursday morning?&rdquo; or &ldquo;What time do you
            close on Saturday?&rdquo;
          </p>

          <button
            type="button"
            onClick={handleStop}
            className="mt-5 w-full rounded-lg border border-line-strong px-5 py-3 text-[15px] font-medium transition-colors hover:bg-paper-dim"
          >
            End call
          </button>
        </div>
      )}

      {phase === 'ended' && (
        <div className="rounded-xl border border-line bg-white p-5">
          <h2 className="text-xl font-semibold">That was Hope.</h2>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
            {lastDuration !== null ? `${formatCountdown(lastDuration)} on the line. ` : ''}
            She was primed with nothing but your practice name, your services and your hours. Live,
            she also holds your diary, and every call she takes reaches your team with a full
            transcript — the ones they couldn&rsquo;t get to included.
          </p>
          <BookingLink href={bookingUrl} />
          <p className="mt-3 text-center text-[13px] text-ink-faint">
            Fifteen minutes, and we&rsquo;ll show you the calls you&rsquo;re missing this week.
          </p>
        </div>
      )}

      {phase === 'expired' && (
        <div className="rounded-xl border border-line bg-white p-5">
          <h2 className="text-xl font-semibold">You&rsquo;ve already spoken to Hope.</h2>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
            This link runs one live conversation, and it has had its turn. The next step is a real
            one: fifteen minutes with us, with Hope connected to your actual diary and answering
            the calls your front desk can&rsquo;t get to.
          </p>
          <BookingLink href={bookingUrl} />
        </div>
      )}

      {phase === 'mic_denied' && (
        <div className="rounded-xl border border-line bg-white p-5">
          <h2 className="text-xl font-semibold">Your browser is blocking the microphone.</h2>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
            Hope has to hear you to answer. Nothing is recorded to your device, and the microphone
            switches off the moment the call ends.
          </p>
          <ul className="mt-4 space-y-2 text-[14px] leading-relaxed text-ink-soft">
            <li>
              <strong className="font-semibold text-ink">iPhone or iPad:</strong> tap{' '}
              <span className="font-mono">aA</span> on the left of the address bar &rarr; Website
              Settings &rarr; Microphone &rarr; Allow, then reload this page.
            </li>
            <li>
              <strong className="font-semibold text-ink">Android:</strong> tap the lock icon beside
              the address &rarr; Permissions &rarr; Microphone &rarr; Allow, then reload.
            </li>
            <li>
              <strong className="font-semibold text-ink">Laptop:</strong> click the lock or camera
              icon in the address bar and allow the microphone, then reload.
            </li>
          </ul>
          <button
            type="button"
            onClick={handleStart}
            className="mt-5 w-full rounded-xl bg-ink px-6 py-4 text-[16px] font-semibold text-paper transition-opacity hover:opacity-90"
          >
            Try again
          </button>
          <p className="mt-3 text-center text-[13px] text-ink-faint">
            Rather not? <BookingTextLink href={bookingUrl} />
          </p>
        </div>
      )}

      {phase === 'failed' && (
        <div className="rounded-xl border border-line bg-white p-5">
          <h2 className="text-xl font-semibold">Hope couldn&rsquo;t connect.</h2>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
            That one is on us, not on you — a weak connection or a dropped line on our side. Your
            demo has not been used up.
          </p>
          <button
            type="button"
            onClick={handleStart}
            className="mt-5 w-full rounded-xl bg-ink px-6 py-4 text-[16px] font-semibold text-paper transition-opacity hover:opacity-90"
          >
            Try again
          </button>
          <p className="mt-3 text-center text-[13px] text-ink-faint">
            Still nothing? <BookingTextLink href={bookingUrl} />
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * One assistant serves every prospect. Everything that differs between
 * practices arrives here, at call time, as overrides — never as a second
 * assistant, a second page or a second deployment.
 */
function buildOverrides(prospect: PublicProspect) {
  return {
    // Substituted into the assistant's system prompt, which holds
    // {{practice_name}}, {{suburb}}, {{services}} and {{hours}}.
    // See vapi/assistant.md for the prompt this expects.
    variableValues: {
      practice_name: prospect.practice_name,
      suburb: prospect.suburb ?? '',
      services: prospect.services.length ? joinServices(prospect.services) : 'general dentistry',
      hours: prospect.hours ?? 'not listed',
    },
    // Interpolated here rather than templated, so the practice name is certain
    // to land in the first two seconds whatever the dashboard's first message
    // happens to say today.
    firstMessage: `Good day, thank you for calling ${prospect.practice_name}, you're speaking to Hope. How can I help you today?`,
    // The billing guarantee. The countdown on screen is the courtesy version;
    // this one holds even if the browser is tampered with.
    maxDurationSeconds: DEMO_MAX_SECONDS,
  };
}

function BookingLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-5 flex w-full items-center justify-center rounded-xl bg-ink px-6 py-4 text-[16px] font-semibold text-paper transition-opacity hover:opacity-90"
    >
      Book a 15-minute call
    </a>
  );
}

function BookingTextLink({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium underline">
      book a 15-minute call instead
    </a>
  );
}

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M5 11a7 7 0 0 0 14 0M12 18v3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Spinner() {
  return (
    <span
      className="ctf-spin inline-block h-4 w-4 rounded-full border-2 border-paper/35 border-t-paper"
      aria-hidden="true"
    />
  );
}
