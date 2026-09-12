// Shown for an unknown or malformed demo slug, and for any other path. It says
// nothing about what does exist — a forwarded link that has been mistyped
// should reveal no more than a link that was never issued.
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center px-5 py-16 sm:px-8">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">
        Cut Through Faster
      </p>
      <h1 className="mt-6 text-3xl font-bold leading-tight">This link isn&rsquo;t live.</h1>
      <p className="mt-4 text-[17px] leading-relaxed text-ink-soft">
        Demo links are issued one per practice and they do expire. If you were sent one and it
        isn&rsquo;t opening, reply to the email and we&rsquo;ll send a fresh one.
      </p>
    </main>
  );
}
