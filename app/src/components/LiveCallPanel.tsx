import { Headphones, Phone, PhoneOff, PhoneForwarded } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CallDetail, SessionOrg, SessionUser, TranscriptLine } from '../../shared/types';
import { formatDuration } from '../lib/format';
import { ConfirmDialog } from './ConfirmDialog';
import { Banner } from './ui';

interface Props {
  call: CallDetail | null;
  transcript: TranscriptLine[];
  user: SessionUser;
  org: SessionOrg;
  /** serverNow - clientNow, so the timer matches the backend's clock. */
  clockSkewMs: number;
  lastEnded: { name: string; outcome: string | null } | null;
  connectionError: string | null;
  onTakeover: (number: string) => Promise<void>;
  onEndCall: () => Promise<void>;
}

function TranscriptRow({ line }: { line: TranscriptLine }) {
  if (line.speaker === 'system') {
    return (
      <p className="transcript-line text-xs text-center text-gray-400 italic py-1">— {line.text} —</p>
    );
  }

  const isBusinessSide = line.speaker === 'ai' || line.speaker === 'human';
  const speakerLabel = line.speaker === 'ai' ? 'AI' : line.speaker === 'human' ? 'You' : 'Caller';

  return (
    <div className={`transcript-line flex flex-col ${isBusinessSide ? 'items-end' : 'items-start'}`}>
      <span className="text-xs uppercase tracking-wide text-gray-400 mb-0.5 font-medium">
        {speakerLabel}
      </span>
      <p
        className={`text-sm max-w-xs leading-relaxed ${
          line.speaker === 'ai' ? 'text-gray-500' : 'text-black font-medium'
        }`}
      >
        {line.text}
      </p>
    </div>
  );
}

export function LiveCallPanel({
  call,
  transcript,
  user,
  org,
  clockSkewMs,
  lastEnded,
  connectionError,
  onTakeover,
  onEndCall,
}: Props) {
  const [elapsed, setElapsed] = useState(0);
  const [takeoverOpen, setTakeoverOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [numberDraft, setNumberDraft] = useState('');

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const defaultNumber = user.phone ?? org.takeoverNumber ?? '';
  const transferring = call?.status === 'transferring';

  useEffect(() => {
    setNumberDraft(defaultNumber);
  }, [defaultNumber, takeoverOpen]);

  // Duration is derived from the call's start time rather than counted up from
  // mount, so a refresh mid-call shows the real elapsed time.
  useEffect(() => {
    if (!call) {
      setElapsed(0);
      return;
    }
    const update = () => {
      setElapsed(Math.max(0, Math.floor((Date.now() + clockSkewMs - call.startedAt) / 1000)));
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [call, clockSkewMs]);

  // Follow the conversation only when the reader is already at the bottom —
  // scrolling back to re-read an earlier line should not get yanked away.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < 80) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [transcript.length]);

  const runAction = async (action: () => Promise<void>, close: () => void) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      close();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'That did not work. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!call) {
    return (
      <section className="border border-gray-200 rounded-2xl p-6 sm:p-8">
        <div className="text-center py-10 space-y-3">
          <div className="h-10 w-10 rounded-full bg-gray-100 flex items-center justify-center mx-auto">
            <Phone className="h-4 w-4 text-gray-400" aria-hidden="true" />
          </div>
          <p className="text-sm font-medium text-gray-500">No active calls</p>
          {lastEnded && (
            <p className="text-xs text-gray-400">
              Last call with {lastEnded.name}
              {lastEnded.outcome ? ` · ${lastEnded.outcome}` : ''}
            </p>
          )}
          {!org.receptionistLinked && (
            <p className="text-xs text-amber-700 max-w-xs mx-auto pt-2">
              Your receptionist is not linked yet, so calls will not appear here. Contact Cut
              Through Faster to finish setup.
            </p>
          )}
          {connectionError && (
            <p className="text-xs text-gray-400 pt-2">{connectionError}</p>
          )}
        </div>
      </section>
    );
  }

  return (
    <section
      className={`border rounded-2xl p-6 sm:p-8 transition-colors duration-500 ${
        transferring ? 'border-black' : 'border-gray-200'
      }`}
      aria-label="Live call"
    >
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-10 w-10 rounded-full bg-black flex items-center justify-center shrink-0">
              <Phone className="h-4 w-4 text-white" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="font-semibold truncate">
                {call.callerName ?? call.callerNumber ?? 'Incoming call'}
              </p>
              {call.callerNumber && (
                <p className="text-sm text-gray-500 font-mono-data">{call.callerNumber}</p>
              )}
            </div>
          </div>
          <div className="text-right shrink-0">
            <p className="font-mono-data text-lg font-semibold tabular-nums">
              {formatDuration(elapsed)}
            </p>
            <p className="text-xs text-gray-400">
              {transferring
                ? 'Transferring to you'
                : call.status === 'ringing'
                  ? 'Ringing'
                  : 'AI on the call'}
            </p>
          </div>
        </div>

        {call.intent && (
          <div className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 border border-gray-200 rounded-full px-2.5 py-1">
            {call.intent}
          </div>
        )}

        {transferring && call.transferTo && (
          <Banner tone="info">
            Ringing <span className="font-mono-data">{call.transferTo}</span> now — answer your
            phone to join the caller.
          </Banner>
        )}

        <div
          ref={scrollRef}
          className="bg-gray-50 rounded-xl p-4 max-h-64 overflow-y-auto space-y-3"
          aria-live="polite"
          aria-label="Live transcript"
        >
          {transcript.length === 0 && (
            <p className="text-sm text-gray-400 italic">
              {call.status === 'ringing' ? 'Connecting…' : 'Waiting for the first words…'}
            </p>
          )}
          {transcript.map((line) => (
            <TranscriptRow key={line.seq} line={line} />
          ))}
          <div ref={bottomRef} />
        </div>

        {actionError && <Banner tone="error">{actionError}</Banner>}

        <div className="space-y-3">
          {!transferring && (
            <button
              type="button"
              onClick={() => {
                setActionError(null);
                setTakeoverOpen(true);
              }}
              disabled={!call.controllable}
              className="w-full bg-black text-white rounded-xl py-3 font-medium text-sm hover:bg-gray-800 transition flex items-center justify-center gap-2 disabled:opacity-40"
            >
              <Headphones className="h-4 w-4" aria-hidden="true" />
              Take Over Call
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setActionError(null);
              setEndOpen(true);
            }}
            className="w-full border border-gray-200 rounded-xl py-2.5 text-sm font-medium text-gray-600 hover:border-black hover:text-black transition flex items-center justify-center gap-2"
          >
            <PhoneOff className="h-4 w-4" aria-hidden="true" />
            End Call
          </button>
          {!call.controllable && !transferring && (
            <p className="text-xs text-gray-400 text-center">
              This call can no longer be controlled — it may be wrapping up.
            </p>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={takeoverOpen}
        title="Take over this call?"
        description={
          <>
            <p>
              The AI will tell the caller you are joining, then ring the number below. Answer your
              phone to speak to the caller.
            </p>
            <p className="flex items-center gap-1.5 text-gray-400">
              <PhoneForwarded className="h-3.5 w-3.5" aria-hidden="true" />
              The caller stays on the line while it rings.
            </p>
          </>
        }
        confirmLabel="Ring my phone"
        busy={busy}
        onCancel={() => setTakeoverOpen(false)}
        onConfirm={() => void runAction(() => onTakeover(numberDraft.trim()), () => setTakeoverOpen(false))}
      >
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-gray-500">Number to ring</span>
          <input
            type="tel"
            value={numberDraft}
            onChange={(event) => setNumberDraft(event.target.value)}
            placeholder="082 555 0134"
            autoComplete="tel"
            className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm font-mono-data focus:outline-none focus:border-black"
          />
        </label>
        {!defaultNumber && (
          <p className="text-xs text-amber-700">
            You have no number saved. Enter one to take over this call.
          </p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={endOpen}
        title="End this call?"
        description={
          <p>
            The caller will be hung up on immediately. This cannot be undone
            {call.callerName ? ` — ${call.callerName} is still on the line.` : '.'}
          </p>
        }
        confirmLabel="End call"
        destructive
        busy={busy}
        onCancel={() => setEndOpen(false)}
        onConfirm={() => void runAction(onEndCall, () => setEndOpen(false))}
      />
    </section>
  );
}
