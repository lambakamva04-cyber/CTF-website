import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Phone, User } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CallDetail, CallOutcome, CallSummary } from '../../shared/types';
import { api } from '../lib/api';
import { formatDuration, formatRelativeDate, outcomeLabel } from '../lib/format';

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
      <Icon className={`h-4 w-4 ${solid ? 'text-white' : 'text-gray-400'}`} aria-hidden="true" />
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
            <p className="text-xs text-gray-400">
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
                : 'text-gray-400'
            }`}
          >
            {outcomeLabel(call.outcome)}
          </span>
          {expanded ? (
            <ChevronUp className="h-4 w-4 text-gray-300" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-4 w-4 text-gray-300" aria-hidden="true" />
          )}
        </div>
      </button>

      {expanded && (
        <div id={panelId} className="mt-4 pl-11 space-y-1.5">
          {call.callerNumber && (
            <p className="text-xs text-gray-400 font-mono-data">{call.callerNumber}</p>
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
            <p className="text-sm text-gray-400 italic">
              Still being written up — the outcome appears when the call report arrives.
            </p>
          )}

          {detail?.summary && <p className="text-sm text-gray-600 pt-1">{detail.summary}</p>}
          {detail?.transferTo && (
            <p className="text-xs text-gray-400">Transferred to {detail.transferTo}</p>
          )}
          {detail?.recordingUrl && (
            <audio
              controls
              preload="none"
              src={detail.recordingUrl}
              className="w-full max-w-sm pt-2"
            >
              Your browser cannot play this recording.
            </audio>
          )}
          {error && <p className="text-xs text-gray-400">{error}</p>}
        </div>
      )}
    </div>
  );
}
