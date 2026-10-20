# CTF Dashboard — Design Language

The admin analytics dashboard for **Cut Through Faster** (CTF), the South
African AI‑receptionist SaaS for dental (and other) practices. This spec and
its companion `ctf-theme.css` carry the real brand over from the marketing
site (`ctf-website/public/index.html`) and the demo app
(`demo/src/app/globals.css`) so the dashboard feels like the same product.

**Tone:** professional, warm, trustworthy, quiet. Ink on cream. Flat and
border‑first — depth comes from hairlines, not drop shadows. Typographic, not
decorative. **One** accent colour (green) and it means *live / go / good*;
everything else is greyscale. No gradients.

---

## 1. Load it

In `demo/src/app/globals.css`, right after `@import 'tailwindcss';`:

```css
@import './admin/_theme/ctf-theme.css';
```

That gives you both the `--ctf-*` CSS variables **and** the `ctf-*` Tailwind
utilities (`bg-ctf-surface`, `text-ctf-ink-soft`, `rounded-ctf-lg`, …), and
they respect dark mode automatically.

Fonts are already loaded app‑wide by `layout.tsx` (Inter, Space Grotesk,
JetBrains Mono via `next/font`). Nothing else to install.

**Dark mode** follows the OS out of the box. To add a manual toggle, set
`data-theme` on `<html>`:

```ts
document.documentElement.dataset.theme = 'dark';   // force dark
document.documentElement.dataset.theme = 'light';  // force light
delete document.documentElement.dataset.theme;      // back to "follow OS"
```

> **Which tokens to use:** the demo app's `globals.css` also defines
> `bg-paper` / `text-ink` / `border-line` / `text-signal`, but those are
> **light‑only**. For anything in the dashboard that must flip in dark mode,
> use the **`ctf-*`** tokens below (or `var(--ctf-*)`), not the globals ones.

---

## 2. Tokens

### Colour — surfaces & text

| Token | Light | Use |
|---|---|---|
| `--ctf-paper` | `#f7f6f3` | App background |
| `--ctf-paper-dim` | `#efeeea` | Recessed wells, zebra rows, empty bar tracks |
| `--ctf-surface` | `#ffffff` | Cards, tiles, table |
| `--ctf-surface-2` | `#faf9f6` | Table header, subtly raised rows |
| `--ctf-ink` | `#14161a` | Primary text, solid dark buttons |
| `--ctf-ink-soft` | `#4a4e55` | Body copy (7.7:1 on paper) |
| `--ctf-ink-faint` | `#63666d` | Labels, meta, captions (5.3:1) |
| `--ctf-on-ink` | `#f7f6f3` | Text on a dark/ink button |
| `--ctf-line` | `#dedcd6` | Hairline borders, dividers |
| `--ctf-line-strong` | `#c9c7bf` | Inputs, hover/interactive edges |

### Colour — the one accent

| Token | Light | Use |
|---|---|---|
| `--ctf-signal` | `#0b7a4b` | Live dot, active funnel fill, positive bar — **fills/icons** |
| `--ctf-signal-strong` | `#0a6b43` | Signal as **text** (6.1:1 on paper) |
| `--ctf-signal-wash` | `#e4f1ea` | Faint tint behind a live/active region |
| `--ctf-on-signal` | `#ffffff` | Text on a solid signal fill (5.4:1) |
| `--ctf-whatsapp` | `#25d366` | Only a WhatsApp affordance — never general UI |

Reserve green for *meaning*. A page of green is off‑brand; a single green dot
that means "answering now" is exactly it.

### Colour — status / funnel scale

Each family has `-fg` (text/icon), `-bg` (tint), `-border`. All ≥ 5.5:1 in
light, ≥ 7:1 in dark. Canonical mapping to the prospect funnel:

| Family | Status | Light fg / bg | Meaning |
|---|---|---|---|
| `neutral` | **opened** | `#4a4e55` / `#eceae4` | Saw the link, nothing yet |
| `amber` | **called** | `#845313` / `#f5ecd6` | A call happened / in progress |
| `info` | **replied** | `#2f5590` / `#e7eef7` | Wrote back, engaged |
| `success` | **interested** | `#0a6b43` / `#dff0e6` | Positive outcome (brand green) |
| `danger` | **opted‑out** | `#9c3a2b` / `#f6e5e0` | Unsubscribed / do‑not‑contact |

Tailwind: `text-ctf-success`, `bg-ctf-success-bg`, `border-ctf-success-border`
(same shape for `neutral` / `amber` / `info` / `danger`).

### Typography

Space Grotesk → display/headings · Inter → UI/body · JetBrains Mono → numbers,
eyebrows, IDs, timestamps.

| Token | Value | Use |
|---|---|---|
| `--ctf-font-display` | Space Grotesk | `h1`–`h3`, KPI numbers |
| `--ctf-font-sans` | Inter | Everything UI/body |
| `--ctf-font-mono` | JetBrains Mono | Eyebrows, metrics, table figures, dates |
| `--ctf-text-eyebrow` | 11px / `0.18em` / UPPER | The "Cut Through Faster" kicker |
| `--ctf-text-body` | 15px | Default UI text |
| `--ctf-text-md` | 17px | Lead paragraph |
| `--ctf-text-h3` | 20px | Section‑card titles |
| `--ctf-text-h1` | clamp 30→38px | Page title |
| `--ctf-text-kpi` | 32px | KPI tile number |

Heading style: `font-display font-bold tracking-[-0.025em] leading-[1.12]`.
Body: `text-ctf-ink-soft leading-relaxed`. Numbers: add `.ctf-nums` (mono +
tabular) so columns and counters don't jitter.

### Radius, spacing, elevation

| Token | Value | Use |
|---|---|---|
| `--ctf-radius-lg` | 12px | Cards, tiles, primary buttons (default) |
| `--ctf-radius-sm` | 8px | Inner panels, inputs, table wells |
| `--ctf-radius-pill` | 999px | Badges, bars, dots |
| `--ctf-card-pad` | 20px (`p-5`) | Card padding |
| `--ctf-shell-max` | 1120px | Content width (1280px with a side rail) |
| `--ctf-gutter` | 24px (20px phones) | Page gutter |
| `--ctf-shadow-card` | subtle | Reach for a **border** first; shadow only if a card must lift |
| `--ctf-shadow-pop` | `0 24px 48px …` | Menus, modals, sticky header on scroll |

---

## 3. Component patterns

Copy‑paste JSX. Every colour is a `var(--ctf-*)` so it works the moment the CSS
is loaded and flips correctly in dark mode. Where a `ctf-*` utility exists it's
noted — swap freely.

### 3.1 Page shell + header

```tsx
<div className="min-h-dvh bg-[var(--ctf-paper)] text-[var(--ctf-ink)] font-[var(--ctf-font-sans)]">
  <header className="sticky top-0 z-30 border-b border-[var(--ctf-line)] bg-[var(--ctf-paper)]/90 backdrop-blur">
    <div className="mx-auto flex h-[60px] max-w-[var(--ctf-shell-max)] items-center justify-between px-5 sm:px-6">
      <div className="flex items-center gap-3">
        <span className="ctf-pulse inline-block h-2 w-2 rounded-full bg-[var(--ctf-signal)]" />
        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--ctf-ink-faint)]">
          Cut Through Faster
        </span>
        <span className="text-[var(--ctf-line-strong)]">/</span>
        <h1 className="font-[var(--ctf-font-display)] text-[15px] font-semibold tracking-[-0.01em]">
          Dashboard
        </h1>
      </div>
      <nav className="flex items-center gap-1 text-[13px] text-[var(--ctf-ink-soft)]">
        {/* tab: active vs idle */}
        <a className="rounded-[var(--ctf-radius-xs)] bg-[var(--ctf-paper-dim)] px-3 py-1.5 font-medium text-[var(--ctf-ink)]">Prospects</a>
        <a className="rounded-[var(--ctf-radius-xs)] px-3 py-1.5 hover:bg-[var(--ctf-paper-dim)]">Calls</a>
      </nav>
    </div>
  </header>

  <main className="mx-auto max-w-[var(--ctf-shell-max)] space-y-9 px-5 py-8 sm:px-6">
    {/* page sections go here */}
  </main>
</div>
```

Page title block below the header:

```tsx
<div>
  <h2 className="font-[var(--ctf-font-display)] text-[clamp(1.875rem,1.4rem+1.6vw,2.375rem)] font-bold leading-[1.12] tracking-[-0.025em]">
    Outreach overview
  </h2>
  <p className="mt-2 text-[15px] leading-relaxed text-[var(--ctf-ink-soft)]">
    Every prospect Hope has reached this week, and where each one is.
  </p>
</div>
```

### 3.2 KPI / stat tile

Grid of tiles; green only on a *positive* delta.

```tsx
<div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
  {/* one tile */}
  <div className="rounded-[var(--ctf-radius-lg)] border border-[var(--ctf-line)] bg-[var(--ctf-surface)] p-5">
    <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--ctf-ink-faint)]">
      Calls answered
    </p>
    <p className="ctf-nums mt-3 text-[32px] font-bold leading-none tracking-[-0.01em] text-[var(--ctf-ink)] font-[var(--ctf-font-display)]">
      1,284
    </p>
    <p className="mt-2 flex items-center gap-1.5 text-[13px]">
      <span className="font-medium text-[var(--ctf-signal-strong)]">+12%</span>
      <span className="text-[var(--ctf-ink-faint)]">vs last week</span>
    </p>
  </div>
</div>
```

A negative delta uses `text-[var(--ctf-danger-fg)]`; a flat one stays
`text-[var(--ctf-ink-faint)]`. Keep the arrow in text (`↑ ↓`), not colour alone.

### 3.3 Data table — rows of prospects

Flat, hairline‑ruled, zebra on `paper-dim`, mono for numeric/date columns.

```tsx
<div className="overflow-hidden rounded-[var(--ctf-radius-lg)] border border-[var(--ctf-line)] bg-[var(--ctf-surface)]">
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
      <tr className="border-b border-[var(--ctf-line)] odd:bg-[var(--ctf-surface)] even:bg-[var(--ctf-paper-dim)]/50 hover:bg-[var(--ctf-signal-wash)]">
        <td className="px-4 py-3">
          <div className="font-medium text-[var(--ctf-ink)]">Bryanston Dental</div>
          <div className="text-[12px] text-[var(--ctf-ink-faint)]">Johannesburg</div>
        </td>
        <td className="px-4 py-3"><StatusBadge status="interested" /></td>
        <td className="ctf-nums px-4 py-3 text-right text-[var(--ctf-ink-soft)]">7</td>
        <td className="ctf-nums px-4 py-3 text-right text-[var(--ctf-ink-faint)]">2h ago</td>
      </tr>
    </tbody>
  </table>
</div>
```

Keep the last-seen / count columns `.ctf-nums` so they right‑align cleanly.

### 3.4 Status badges

One small component, driven by the funnel map. Pill, tinted, bordered.

```tsx
const STATUS = {
  opened:     { label: 'Opened',     fam: 'neutral' },
  called:     { label: 'Called',     fam: 'amber'   },
  replied:    { label: 'Replied',    fam: 'info'    },
  interested: { label: 'Interested', fam: 'success' },
  optedOut:   { label: 'Opted out',  fam: 'danger'  },
} as const;

function StatusBadge({ status }: { status: keyof typeof STATUS }) {
  const { label, fam } = STATUS[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] font-medium"
      style={{
        color:           `var(--ctf-${fam}-fg)`,
        backgroundColor: `var(--ctf-${fam}-bg)`,
        borderColor:     `var(--ctf-${fam}-border)`,
      }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: `var(--ctf-${fam}-fg)` }} />
      {label}
    </span>
  );
}
```

Prefer `style={{…}}` here because the family name is dynamic; the equivalent
static utilities are `text-ctf-success bg-ctf-success-bg border-ctf-success-border`.
The leading dot carries the state for anyone who can't rely on hue.

### 3.5 Funnel bar

Stacked horizontal bar, one row per stage. Green reads as "furthest / best".

```tsx
const STAGES = [
  { label: 'Opened',     value: 420, fam: 'neutral' },
  { label: 'Called',     value: 265, fam: 'amber'   },
  { label: 'Replied',    value: 138, fam: 'info'    },
  { label: 'Interested', value: 74,  fam: 'success' },
];
const max = STAGES[0].value;

<div className="space-y-2.5">
  {STAGES.map((s) => (
    <div key={s.label} className="flex items-center gap-3">
      <span className="w-20 shrink-0 text-[13px] text-[var(--ctf-ink-soft)]">{s.label}</span>
      <div className="h-6 flex-1 overflow-hidden rounded-[var(--ctf-radius-sm)] bg-[var(--ctf-paper-dim)]">
        <div
          className="flex h-full items-center justify-end rounded-[var(--ctf-radius-sm)] px-2"
          style={{ width: `${(s.value / max) * 100}%`, backgroundColor: `var(--ctf-${s.fam}-bg)` }}
        >
          <span className="ctf-nums text-[12px] font-semibold" style={{ color: `var(--ctf-${s.fam}-fg)` }}>
            {s.value}
          </span>
        </div>
      </div>
    </div>
  ))}
</div>
```

For a single "live now" progress bar (e.g. demo‑call countdown), reuse the
demo's exact treatment: track `bg-[var(--ctf-paper-dim)]`, fill
`bg-[var(--ctf-signal)]`, both `rounded-full`.

### 3.6 Section card

The workhorse container. Border, not shadow.

```tsx
<section className="rounded-[var(--ctf-radius-lg)] border border-[var(--ctf-line)] bg-[var(--ctf-surface)] p-5 sm:p-6">
  <div className="flex items-center justify-between">
    <h3 className="font-[var(--ctf-font-display)] text-[20px] font-semibold tracking-[-0.01em]">
      This week
    </h3>
    <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--ctf-ink-faint)]">
      Mon–Sun
    </span>
  </div>
  <p className="mt-3 text-[15px] leading-relaxed text-[var(--ctf-ink-soft)]">
    Body text, or drop a table / funnel / tile grid straight in.
  </p>
  {/* divider before a footer row */}
  <div className="mt-5 border-t border-[var(--ctf-line)] pt-4 text-[13px] text-[var(--ctf-ink-faint)]">
    Updated 2 minutes ago
  </div>
</section>
```

---

## 4. Rules of thumb

- **Green = live/go/good, nothing else.** Everything structural is greyscale.
- **Borders before shadows.** A card is a hairline on white. Shadow only when
  something floats (menu, modal, sticky header on scroll).
- **Mono for data.** Numbers, dates, IDs, eyebrows → JetBrains Mono +
  `.ctf-nums` so columns stay aligned.
- **Status = dot + word,** never colour alone (accessibility, and it reads at a
  glance in a dense table).
- **Radius 12 / 8 / pill.** Cards & buttons 12px, inner wells & inputs 8px,
  badges & bars fully round.
- **Respect motion & focus.** `globals.css` already muting animation under
  `prefers-reduced-motion`; use `.ctf-focus` (green ring) on custom controls.
- **Contrast is already AA+** in both themes — if you tint your own element,
  keep text on `-fg`, fills on `-bg`.
