import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
  /**
   * Where focus lands when the dialog opens. 'children' leaves it to an
   * autoFocus field inside, for dialogs that ask for a reason or a code.
   */
  initialFocus?: 'confirm' | 'children';
}

/**
 * Taking over or hanging up affects a real person mid-conversation and cannot
 * be undone, so both actions are confirmed rather than fired on a single tap.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  busy = false,
  destructive = false,
  onConfirm,
  onCancel,
  children,
  initialFocus = 'confirm',
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  // Generated, so two dialogs on one page never share an id.
  const titleId = useId();
  const descriptionId = useId();

  // Read through refs so the effect below runs once per opening. Callers pass
  // `onCancel` inline, and the dashboard re-renders every few seconds while
  // it polls; with these as dependencies the effect re-ran on each render and
  // threw focus back to the confirm button, or out of the dialog altogether.
  const onCancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  const initialFocusRef = useRef(initialFocus);
  useEffect(() => {
    onCancelRef.current = onCancel;
    busyRef.current = busy;
    initialFocusRef.current = initialFocus;
  });

  // Where focus goes back to on close: the control that opened the dialog.
  // Read during render, on the render that opens it, because a field inside
  // with autoFocus takes focus during commit — before any effect could see the
  // opener.
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
  }
  wasOpen.current = open;

  useEffect(() => {
    if (!open) return;

    if (initialFocusRef.current === 'confirm') confirmRef.current?.focus();

    // The page behind the dialog is taken out of reach entirely — not
    // clickable, not focusable, not read out — rather than relying on
    // aria-modal alone, which some screen readers still ignore.
    const app = document.getElementById('root');
    app?.setAttribute('inert', '');

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault();
        onCancelRef.current();
        return;
      }

      if (event.key !== 'Tab' || !panelRef.current) return;

      // Keep focus inside the dialog while it is open.
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // Inert first: an inert element cannot take focus back.
      app?.removeAttribute('inert');
      previouslyFocused.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  // Rendered into <body> so no parent can shrink or clip the fixed backdrop:
  // `space-y-*` puts a margin on every child but the last, and a margin on a
  // fixed element with inset-0 pulls its edge in.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="w-full max-w-sm bg-white rounded-2xl p-6 space-y-4 shadow-xl"
      >
        <h2 id={titleId} className="font-display text-lg font-semibold">
          {title}
        </h2>
        <div id={descriptionId} className="text-sm text-slate space-y-3">
          {description}
        </div>
        {children}
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="flex-1 border border-gray-200 rounded-xl py-2.5 text-sm font-medium text-gray-600 hover:border-black hover:text-black transition disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`flex-1 rounded-xl py-2.5 text-sm font-medium text-white transition disabled:opacity-60 ${
              destructive ? 'bg-red-600 hover:bg-red-700' : 'bg-black hover:bg-gray-800'
            }`}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
