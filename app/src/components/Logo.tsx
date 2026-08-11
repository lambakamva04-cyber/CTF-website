/**
 * The Cut Through Faster monogram: an interlocking C, T and F drawn in the
 * "inline" style of the original — every stroke is a bar with a dark edge and a
 * light interior, rather than a solid shape.
 *
 * This is a redraw traced from the letterpress artwork, not the original
 * vector. If a master SVG exists, replacing the contents of `LogoMark` with its
 * paths is the only change needed — every other file references this component
 * rather than the geometry.
 *
 * `currentColor` drives the outline so one component serves the dark header and
 * the cream page without a second copy.
 */
export function LogoMark({
  size = 32,
  className = '',
  title = 'Cut Through Faster',
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label={title}
      className={className}
      fill="none"
    >
      {/* The stroke scales with the mark. A non-scaling stroke would hold a
          fixed device width, leaving the outline spindly when large and a blob
          when small. */}
      <g stroke="currentColor" strokeWidth="4.5" strokeLinejoin="miter" strokeLinecap="butt">
        {/* C — a wide open ring occupying the left half, drawn as an annulus so
            it reads as an outlined bar rather than a single line. Its tips
            reach past the T stem, which is what makes the mark interlock. */}
        <path
          d="M60.6 37.4
             A32 32 0 1 0 60.6 82.6
             L51.4 73.4
             A19 19 0 1 1 51.4 46.6
             Z"
        />

        {/* T and F share the top bar, spanning the full width. */}
        <rect x="8" y="10" width="84" height="15" />

        {/* T stem, central, running the full height through the C. */}
        <rect x="43" y="10" width="14" height="82" />

        {/* F spine, clearly separated from the T stem. */}
        <rect x="62" y="10" width="13" height="78" />

        {/* F middle arm. */}
        <rect x="62" y="50" width="30" height="13" />
      </g>
    </svg>
  );
}

/** The mark beside the name, for headers. */
export function LogoLockup({
  className = '',
  markSize = 28,
}: {
  className?: string;
  markSize?: number;
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark size={markSize} />
      <span className="font-display font-semibold tracking-tight">Cut Through Faster</span>
    </span>
  );
}
