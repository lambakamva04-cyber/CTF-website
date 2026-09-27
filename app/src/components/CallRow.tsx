import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Phone, User } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CallDetail, CallOutcome, CallSummary, TranscriptLine } from '../../shared/types';
import { api } from '../lib/api';
import { formatDuration, formatRelativeDate, outcomeLabel } from '../lib/format';
import { TranscriptRow } from './LiveCallPanel';
import { Skeleton, SkeletonRegion, SkeletonText } from './Skeleton';

/** A backstop on paging, far past any real call: the server sends 500 lines a page. */
const MAX_TRANSCRIPT_PAGES = 10;

function CallIcon({ outcome }: { outcome: CallOutcome | null }) {
  const solid = outcome === 'booked' || outcome === 'resolved';

  let Icon = Phone;
  if (outcome === 'escalated') Icon = AlertTriangle;
  else if (outcome === 'resolved') Icon = User;
  else if (outcome === 'booked') Icon = CheckCircle2;

  return (
    <div
      className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 ${
        solid ? 'bg-black' : 'bg-gray-100'
      }`}
    >
      <Icon className={`h-4 w-4 ${solid ? 'text-white' : 'text-slate'}`} aria-hidden="true" />
    </div>
  );
}

interface Props {
  call: CallSummary;
  expanded: boolean;
  onToggle: () => void;
  timeZone: string;
}

export function CallRow({ call, expanded, onToggle, timeZone }: Props) {
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The list endpoint returns only what the collapsed row shows; the summary,
  // recording and transfer target are fetched the first time a row is opened.
  useEffect(() => {
    if (!expanded || detail) return;

    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      try {
        const body = await api.call(call.id, controller.signal);
        if (!cancelled) setDetail(body);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        if (!cancelled) setError('Could not load the full call details.');
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [expanded, detail, call.id]);

  // The written record of the call, beside the recording, for anyone who
  // cannot listen to it. Fetched the first time "Read the transcript" is
  // opened, not with the row: most rows are opened for the outcome alone.
  const [transcript, setTranscript] = useState<TranscriptLine[] | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [transcriptRequested, setTranscriptRequested] = useState(false);

  useEffect(() => {
    if (!transcriptRequested || transcript) return;

    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      try {
        const lines: TranscriptLine[] = [];
        let after = 0;
        for (let page = 0; page < MAX_TRANSCRIPT_PAGES; page++) {
          const body = await api.transcript(call.id, after, controller.signal);
          if (body.lines.length === 0) break;
          lines.push(...body.lines);
          after = body.cursor;
        }
        if (!cancelled) setTranscript(lines);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        if (!cancelled) setTranscriptError('Could not load the transcript.');
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [transcriptRequested, transcript, call.id]);

  const panelId = `call-panel-${call.id}`;
  const isSettled = call.outcome !== null;

  return (
    <div className="py-4">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="w-full flex items-center justify-between gap-4 text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <CallIcon outcome={call.outcome} />
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">
              {call.callerName ?? call.callerNumber ?? 'Unknown caller'}
            </p>
            <p className="text-xs text-slate">
              {formatRelativeDate(call.startedAt, timeZone)}
              {call.durationS !== null ? ` · ${formatDuration(call.durationS)}` : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={`text-xs font-medium ${
              call.outcome === 'booked' || call.outcome === 'resolved'
                ? 'text-black'
                : 'text-slate'
            }`}
          >
            {outcomeLabel(call.outcome)}
          </span>
          {expanded ? (
            <ChevronUp className="h-4 w-4 text-slate" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-4 w-4 text-slate" aria-hidden="true" />
          )}
        </div>
      </button>

      {expanded && (
        <div id={panelId} className="mt-4 pl-11 space-y-1.5">
          {call.callerNumber && (
            <p className="text-xs text-slate font-mono-data">{call.callerNumber}</p>
          )}
          {call.intent && <p className="text-sm text-gray-600">{call.intent}</p>}

          {call.outcome === 'booked' && (call.service ?? call.bookingWhen) && (
            <p className="text-sm font-medium">
              Booked: {[call.service, call.bookingWhen].filter(Boolean).join(' · ')}
            </p>
          )}
          {call.outcome === 'resolved' && (
            <p className="text-sm font-medium">Handled directly by staff</p>
          )}
          {!isSettled && (
            <p className="text-sm text-slate italic">
              Still being written up — the outcome appears when the call report arrives.
            </p>
          )}

          {/* The summary and the recording are a second request. Without a
              placeholder the panel silently grows under the reader a moment
              after they open it. */}
          {!detail && !error && (
            <SkeletonRegion label="Loading the rest of this call" className="pt-1 space-y-2">
              <SkeletonText lines={2} />
              <Skeleton className="h-8 w-full max-w-sm rounded-full" delay={2} />
            </SkeletonRegion>
          )}

          {detail?.summary && <p className="text-sm text-gray-600 pt-1">{detail.summary}</p>}
          {detail?.transferTo && (
            <p className="text-xs text-slate">Transferred to {detail.transferTo}</p>
          )}
          {detail?.recordingUrl && (
            <audio
              controls
              preload="none"
              src={detail.recordingUrl}
              aria-label={`Recording of the call with ${call.callerName ?? call.callerNumber ?? 'this caller'}`}
              className="w-full max-w-sm pt-2"
            >
              Your browser cannot play this recording.
            </audio>
          )}
          <details
            className="pt-2"
            onToggle={(event) => {
              if (event.currentTarget.open) setTranscriptRequested(true);
            }}
          >
            <summary className="text-sm font-medium cursor-pointer w-fit">Read the transcript</summary>
            <div className="pt-3 max-w-md">
              {transcript === null && !transcriptError && (
                <p role="status" className="text-xs text-slate">
                  Loading the transcript…
                </p>
              )}
              {transcript?.length === 0 && (
                <p className="text-xs text-slate">No transcript was recorded for this call.</p>
              )}
              {transcript && transcript.length > 0 && (
                <div className="space-y-3">
                  {transcript.map((line) => (
                    <TranscriptRow key={line.seq} line={line} />
                  ))}
                </div>
              )}
              {transcriptError && <p className="text-xs text-slate">{transcriptError}</p>}
            </div>
          </details>
          {error && <p className="text-xs text-slate">{error}</p>}
        </div>
      )}
    </div>
  );
}
