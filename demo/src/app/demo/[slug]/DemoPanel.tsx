'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type Vapi from '@vapi-ai/web';

import {
  describeDuration,
  describePrimedWith,
  formatCountdown,
  INDUSTRY_COPY,
  joinServices,
  spokenPracticeName,
  type DemoEventBody,
  type GateRefusal,
  type GateResponse,
  type PublicProspect,
} from '@/lib/demo';

type Phase =
  | 'ready'
  | 'connecting'
  | 'live'
  | 'ended'
  | 'mic_denied'
  | 'failed'
  | 'expired'
  | 'limited';

type CaptionSpeaker = 'hope' | 'caller';
type Caption = { id: number; speaker: CaptionSpeaker; text: string };

type Props = {
  prospect: PublicProspect;
  /** The call length: three minutes on a personal link, `demo_limits` on the public line. */
  maxSeconds: number;
  bookingUrl: string;
  vapiPublicKey: string;
  vapiAssistantId: string;
};

/** If Vapi has not connected us by now, something is wrong. */
const CONNECT_TIMEOUT_MS = 25_000;

export default function DemoPanel({
  prospect,
  maxSeconds,
  bookingUrl,
  vapiPublicKey,
  vapiAssistantId,
}: Props) {
  const [phase, setPhase] = useState<Phase>(prospect.expired ? 'expired' : 'ready');
  // The cap for the call in progress. The public line's gate can hand back a
  // different number than the page was rendered with, if the limit was changed
  // in between; the gate's answer wins, because it is what Vapi is told.
  const [cap, setCap] = useState(maxSeconds);
  const capRef = useRef(maxSeconds);
  const [remaining, setRemaining] = useState(maxSeconds);
  const [lastDuration, setLastDuration] = useState<number | null>(null);
  const [limitReason, setLimitReason] = useState<GateRefusal>('daily_cap');
  // Live captions of the conversation, and what is being said right now.
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [speaking, setSpeaking] = useState<{ speaker: CaptionSpeaker; text: string } | null>(null);
  const captionsBoxRef = useRef<HTMLDivElement>(null);
  // Read out by a screen reader. Kept to what a sighted person would notice
  // without being told: the connection starting and the time running short.
  const [announcement, setAnnouncement] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousPhaseRef = useRef<Phase>(phase);
  const warnedRef = useRef<Set<number>>(new Set());

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
      setRemaining(capRef.current);
      setCaptions([]);
      setSpeaking(null);
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
      const m = message as {
        type?: string;
        status?: string;
        endedReason?: string;
        role?: string;
        transcriptType?: string;
        transcript?: string;
      };
      if (m?.type === 'status-update' && m.status === 'ended' && m.endedReason) {
        reportedReasonRef.current = m.endedReason;
      }

      // Captions. Vapi sends each utterance as it is recognised: `partial`
      // while the words are still arriving, `final` once they settle.
      if (m?.type === 'transcript' && typeof m.transcript === 'string' && m.transcript.trim()) {
        if (cancelled) return;
        const speaker: CaptionSpeaker = m.role === 'assistant' ? 'hope' : 'caller';
        const text = m.transcript.trim();
        if (m.transcriptType === 'final') {
          setSpeaking((current) => (current?.speaker === speaker ? null : current));
          setCaptions((current) => {
            const last = current[current.length - 1];
            // One speaker's sentences arrive one by one; keep them as one turn.
            if (last?.speaker === speaker) {
              return [...current.slice(0, -1), { ...last, text: `${last.text} ${text}` }];
            }
            return [...current, { id: current.length, speaker, text }];
          });
        } else {
          setSpeaking({ speaker, text });
        }
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

  // ---- the time cap --------------------------------------------------------
  // Driven off wall-clock time rather than a tick count, so a backgrounded tab
  // that throttles its timers still stops on schedule. Vapi is also told the
  // same limit as `maxDurationSeconds`, so this timer is the courtesy and the
  // server-side cap is the guarantee.
  useEffect(() => {
    if (phase !== 'live') return;

    const limit = capRef.current;

    const stopNow = () => {
      intentRef.current = 'demo-time-limit';
      void vapiRef.current?.stop();
    };

    const tick = () => {
      const startedAt = startedAtRef.current ?? Date.now();
      const left = limit - (Date.now() - startedAt) / 1000;
      setRemaining(Math.max(0, left));
      if (left <= 0) stopNow();
    };

    const interval = window.setInterval(tick, 250);
    // Backstop: one timer that fires at the cap even if the interval is starved.
    const startedAt = startedAtRef.current ?? Date.now();
    const hardStop = window.setTimeout(
      stopNow,
      Math.max(0, limit * 1000 - (Date.now() - startedAt)),
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

  // ---- accessibility -------------------------------------------------------
  // Each phase replaces the panel before it, taking the button that had focus
  // with it. Put focus on the new panel's heading so a keyboard or screen
  // reader user starts there instead of back at the top of the page.
  useEffect(() => {
    const previous = previousPhaseRef.current;
    previousPhaseRef.current = phase;
    if (previous === phase) return;
    if (phase === 'connecting') {
      setAnnouncement('Connecting to Hope…');
      return;
    }
    setAnnouncement('');
    headingRef.current?.focus();
  }, [phase]);

  // Keep the newest caption in view. The box scrolls on its own; moving the
  // page would pull the reader away from the End call button.
  useEffect(() => {
    const box = captionsBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [captions, speaking]);

  // The countdown is not read out every second; these two marks are.
  useEffect(() => {
    if (phase !== 'live') {
      warnedRef.current.clear();
      return;
    }
    for (const mark of [60, 15]) {
      if (remaining <= mark && !warnedRef.current.has(mark)) {
        warnedRef.current.add(mark);
        setAnnouncement(mark === 60 ? 'One minute left.' : 'Fifteen seconds left.');
      }
    }
  }, [phase, remaining]);

  // ---- starting ------------------------------------------------------------
  const handleStart = useCallback(async () => {
    if (phase === 'connecting' || phase === 'live' || phase === 'expired' || phase === 'limited') {
      return;
    }

    setPhase('connecting');
    intentRef.current = null;
    reportedReasonRef.current = null;

    // The public line asks whether it may take another call. Sent now, beside
    // the microphone prompt rather than after it, so the answer is usually
    // back by the time permission is. The catch only keeps an early return
    // (a refused microphone) from leaving an unhandled rejection; the answer
    // itself is awaited below.
    const gate = prospect.public_line ? requestGate(slug) : null;
    gate?.catch(() => undefined);

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

    if (gate) {
      let verdict: GateResponse;
      try {
        verdict = await gate;
      } catch {
        // No answer is not a yes: an unreadable limit must not become an
        // unlimited line.
        setPhase('failed');
        return;
      }
      if (!verdict.allowed) {
        setLimitReason(verdict.reason);
        setPhase('limited');
        return;
      }
      capRef.current = verdict.max_seconds;
      setCap(verdict.max_seconds);
      setRemaining(verdict.max_seconds);
    }

    const timeout = window.setTimeout(() => {
      setPhase((current) => (current === 'connecting' ? 'failed' : current));
    }, CONNECT_TIMEOUT_MS);

    try {
      const vapi = await loadVapi();
      await vapi.start(vapiAssistantId, buildOverrides(prospect, capRef.current));
    } catch {
      setPhase((current) => (current === 'connecting' ? 'failed' : current));
    } finally {
      window.clearTimeout(timeout);
    }
  }, [loadVapi, phase, prospect, sendEvent, slug, vapiAssistantId]);

  const handleStop = useCallback(() => {
    intentRef.current = 'customer-ended-call';
    void vapiRef.current?.stop();
  }, []);

  // ---- rendering -----------------------------------------------------------
  const progress = Math.max(0, Math.min(1, remaining / cap));

  return (
    <section className="mt-7">
      <p role="status" className="sr-only">
        {announcement}
      </p>

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
            {prospect.public_line
              ? `Uses your microphone. Up to ${describeDuration(cap)}, with live captions, nothing to install.`
              : `Uses your phone’s microphone. ${capitalise(describeDuration(cap))}, one conversation, with live captions, nothing to install.`}
          </p>
          {/* Said before the tap, because the recording starts with it. */}
          <p className="mt-1 text-center text-[13px] text-ink-faint">
            Hope is an AI, and the conversation is recorded and transcribed.{' '}
            <a href="/privacy" className="font-medium underline underline-offset-2">
              How we handle it
            </a>
          </p>
        </>
      )}

      {phase === 'live' && (
        <div className="rounded-xl border border-ink bg-white p-5">
          <div className="flex items-center justify-between">
            <h2
              ref={headingRef}
              tabIndex={-1}
              className="flex items-center gap-2.5 font-sans text-[15px] font-semibold tracking-normal focus:outline-none"
            >
              <span
                className="ctf-pulse inline-block h-2.5 w-2.5 rounded-full bg-signal"
                aria-hidden="true"
              />
              Hope is on the line
            </h2>
            <p className="font-mono text-[15px] tabular-nums text-ink-soft">
              {formatCountdown(remaining)}
            </p>
          </div>

          <div
            className="mt-4 h-1 w-full overflow-hidden rounded-full bg-paper-dim"
            role="progressbar"
            aria-label="Time remaining in this demo"
            aria-valuemin={0}
            aria-valuemax={cap}
            aria-valuenow={Math.ceil(remaining)}
            aria-valuetext={describeRemaining(remaining)}
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

          {/* Captions, for anyone who cannot hear the call or would rather
              read it. Not announced as they arrive: a screen reader user is
              already hearing Hope, and a second voice reading her words over
              her would drown both out. The box is focusable, so it can be
              read at any point. */}
          <h3
            id="live-captions-heading"
            className="mt-5 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint"
          >
            Live captions
          </h3>
          <div
            ref={captionsBoxRef}
            role="log"
            aria-live="off"
            aria-labelledby="live-captions-heading"
            tabIndex={0}
            className="mt-2 max-h-48 space-y-2 overflow-y-auto rounded-lg bg-paper-dim p-3 text-[14px] leading-relaxed"
          >
            {captions.length === 0 && !speaking && (
              <p className="text-ink-faint">What you and Hope say appears here.</p>
            )}
            {captions.map((caption) => (
              <CaptionLine key={caption.id} speaker={caption.speaker} text={caption.text} />
            ))}
            {speaking && <CaptionLine speaker={speaking.speaker} text={speaking.text} pending />}
          </div>

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
          <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold focus:outline-none">
            That was Hope.
          </h2>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
            {lastDuration !== null ? `${formatCountdown(lastDuration)} on the line. ` : ''}
            {prospect.public_line
              ? 'That was a sample practice. Set up for yours, she works from your own hours, services and diary, and every call she takes reaches your team with a full transcript — the ones they couldn’t get to included.'
              : `She was primed with nothing but ${describePrimedWith(prospect.industry, prospect.hours !== null)}. Live, she also holds your diary, and every call she takes reaches your team with a full transcript — the ones they couldn’t get to included.`}
          </p>
          {captions.length > 0 && (
            <details className="mt-4 rounded-lg border border-line p-3">
              <summary className="cursor-pointer text-[15px] font-medium">
                Read the transcript of your call
              </summary>
              <div className="mt-3 space-y-2 text-[14px] leading-relaxed">
                {captions.map((caption) => (
                  <CaptionLine key={caption.id} speaker={caption.speaker} text={caption.text} />
                ))}
              </div>
            </details>
          )}
          <BookingLink href={bookingUrl} />
          <p className="mt-3 text-center text-[13px] text-ink-faint">
            Fifteen minutes, and we&rsquo;ll show you the calls you&rsquo;re missing this week.
          </p>
        </div>
      )}

      {phase === 'expired' && (
        <div className="rounded-xl border border-line bg-white p-5">
          <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold focus:outline-none">
            You&rsquo;ve already spoken to Hope.
          </h2>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
            This link runs one live conversation, and it has had its turn. The next step is a real
            one: fifteen minutes with us, with Hope connected to your actual diary and answering
            the calls your front desk can&rsquo;t get to.
          </p>
          <BookingLink href={bookingUrl} />
        </div>
      )}

      {phase === 'limited' && (
        <div className="rounded-xl border border-line bg-white p-5">
          <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold focus:outline-none">
            {limitReason === 'ip_cooldown'
              ? 'You’ve had your turns for now.'
              : 'Hope has taken today’s calls.'}
          </h2>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
            {limitReason === 'ip_cooldown'
              ? 'The public line takes a few calls per person each hour, so it stays free for the next person. Try again later, or book fifteen minutes with us and hear Hope answering for your own practice.'
              : 'The public line has a daily limit, and today’s has been reached. Try again tomorrow, or book fifteen minutes with us and hear Hope answering for your own practice.'}
          </p>
          <BookingLink href={bookingUrl} />
        </div>
      )}

      {phase === 'mic_denied' && (
        <div className="rounded-xl border border-line bg-white p-5">
          <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold focus:outline-none">
            Your browser is blocking the microphone.
          </h2>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
            Hope has to hear you to answer. The microphone is used only during the call, and
            switches off the moment it ends.
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
          <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold focus:outline-none">
            Hope couldn&rsquo;t connect.
          </h2>
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
 * One assistant serves every prospect of the same industry. Everything that
 * differs between practices or firms arrives here, at call time, as overrides —
 * never as another assistant per prospect, a second page or a second deployment.
 */
function buildOverrides(prospect: PublicProspect, maxSeconds: number) {
  const practiceName = spokenPracticeName(prospect.practice_name);
  return {
    // Substituted into the assistant's system prompt, which holds
    // {{practice_name}}, {{suburb}}, {{services}} and {{hours}}.
    // See vapi/assistant.md and vapi/assistant-legal.md for the prompts this
    // expects.
    variableValues: {
      practice_name: practiceName,
      suburb: prospect.suburb ?? '',
      services: prospect.services.length
        ? joinServices(prospect.services)
        : INDUSTRY_COPY[prospect.industry].fallbackServices,
      hours: prospect.hours ?? 'not listed',
    },
    // Interpolated here rather than templated, so the practice name is certain
    // to land in the first two seconds whatever the dashboard's first message
    // happens to say today.
    firstMessage: `Good day, thank you for calling ${practiceName}, you're speaking to Hope. How can I help you today?`,
    // Vapi ends the call here even if this page is closed or its timer
    // starved, so the countdown on screen is the courtesy version.
    maxDurationSeconds: maxSeconds,
  };
}

/** How long the gate may take before the attempt counts as failed. */
const GATE_TIMEOUT_MS = 15_000;

/** Asks the public line's gate for a call. Throws on anything but an answer. */
async function requestGate(slug: string): Promise<GateResponse> {
  const response = await fetch(`/api/demo/${encodeURIComponent(slug)}/gate`, {
    method: 'POST',
    signal: AbortSignal.timeout(GATE_TIMEOUT_MS),
  });
  // The edge's per-visitor limit: the same answer as the gate's own, so the
  // visitor is told to wait rather than that something broke.
  if (response.status === 429) return { allowed: false, reason: 'ip_cooldown' };
  if (!response.ok) throw new Error(`gate answered ${response.status}`);
  return (await response.json()) as GateResponse;
}

/** One turn of the conversation, as a caption. `pending` is still being spoken. */
function CaptionLine({
  speaker,
  text,
  pending = false,
}: {
  speaker: CaptionSpeaker;
  text: string;
  pending?: boolean;
}) {
  return (
    <p className={pending ? 'text-ink-soft' : 'text-ink'}>
      <span className="font-semibold">{speaker === 'hope' ? 'Hope' : 'You'}:</span> {text}
      {pending && <span className="sr-only"> (still speaking)</span>}
    </p>
  );
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
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
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function BookingTextLink({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium underline">
      book a 15-minute call instead
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** "2 minutes 30 seconds left", for the progress bar's spoken value. */
function describeRemaining(secondsRemaining: number): string {
  const whole = Math.max(0, Math.ceil(secondsRemaining));
  const minutes = Math.floor(whole / 60);
  const seconds = whole % 60;
  const parts: string[] = [];
  if (minutes) parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
  if (seconds || !minutes) parts.push(`${seconds} ${seconds === 1 ? 'second' : 'seconds'}`);
  return `${parts.join(' ')} left`;
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
