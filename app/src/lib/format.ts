import type { CallOutcome } from '../../shared/types';

export function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function outcomeLabel(outcome: CallOutcome | null): string {
  switch (outcome) {
    case 'booked':
      return 'Booked';
    case 'resolved':
      return 'By you';
    case 'escalated':
      return 'Escalated';
    case 'inquiry':
      return 'Inquiry';
    case 'missed':
      return 'Missed';
    default:
      return 'In progress';
  }
}

function dayKey(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-ZA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(epochMs));
}

/** "Today, 2:30pm" / "Yesterday, 9:05am" / "Tue, 4:12pm" / "3 Mar". */
export function formatRelativeDate(epochMs: number, timeZone: string): string {
  const now = Date.now();
  const time = new Intl.DateTimeFormat('en-ZA', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(new Date(epochMs))
    .replace(/\s/g, '')
    .toLowerCase();

  const today = dayKey(now, timeZone);
  const target = dayKey(epochMs, timeZone);

  if (target === today) return `Today, ${time}`;
  if (target === dayKey(now - 86_400_000, timeZone)) return `Yesterday, ${time}`;

  if (now - epochMs < 7 * 86_400_000) {
    const weekday = new Intl.DateTimeFormat('en-ZA', { timeZone, weekday: 'short' }).format(
      new Date(epochMs),
    );
    return `${weekday}, ${time}`;
  }

  return new Intl.DateTimeFormat('en-ZA', { timeZone, day: 'numeric', month: 'short' }).format(
    new Date(epochMs),
  );
}

export function formatAbsolute(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-ZA', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(epochMs));
}
