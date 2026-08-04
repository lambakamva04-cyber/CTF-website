import { useEffect, useRef, useState } from 'react';
import type { TranscriptLine, TranscriptResponse } from '../../shared/types';
import { api } from '../lib/api';
import { usePoll } from './usePoll';

/**
 * Accumulates a call's transcript. Each poll asks only for lines after the
 * highest sequence number already held, so a long call does not re-download
 * the whole conversation every two seconds.
 */
export function useTranscript(callId: string | null, live: boolean) {
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const cursorRef = useRef(0);
  const trackedIdRef = useRef<string | null>(null);

  if (trackedIdRef.current !== callId) {
    trackedIdRef.current = callId;
    cursorRef.current = 0;
  }

  useEffect(() => {
    setLines([]);
  }, [callId]);

  const { error, stale } = usePoll<TranscriptResponse | null>(
    async (signal) => {
      if (!callId) return null;
      const response = await api.transcript(callId, cursorRef.current, signal);

      if (response.lines.length > 0) {
        cursorRef.current = response.cursor;
        setLines((previous) => {
          const seen = new Set(previous.map((line) => line.seq));
          const additions = response.lines.filter((line) => !seen.has(line.seq));
          return additions.length > 0 ? [...previous, ...additions] : previous;
        });
      }

      return response;
    },
    2000,
    { enabled: Boolean(callId) && live, deps: [callId] },
  );

  return { lines, error, stale };
}
