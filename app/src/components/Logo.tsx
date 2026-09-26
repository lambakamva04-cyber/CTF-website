/**
 * The Cut Through Faster mark.
 *
 * The geometry below is the artwork CTF supplied, unmodified — a traced outline
 * whose coordinates live in a 5400-unit space, which is why the group carries
 * `translate(0,540) scale(0.1,-0.1)`: it scales the paths down by ten and flips
 * the y axis, because the tracer emits y-up coordinates and SVG is y-down.
 * Nothing here is redrawn or approximated, and it should not be: if the mark
 * needs to change, it changes in the source vector and gets pasted back over
 * both this file and public/logo.svg.
 *
 * Two differences from public/logo.svg, and only two. There is no background
 * tile, so the mark sits directly on whatever it is placed over; and the fill is
 * `currentColor` rather than a fixed grey, so one component serves the dark
 * header and the cream page. The standalone file keeps its own background
 * because a favicon has no page behind it to inherit.
 */
const MARK_PATH =
  'M315 5179 l-30 -8 3 -518 c1 -285 4 -524 7 -530 3 -10 186 -13 865 -13 l860 0 10 -26 c7 -17 8 -594 4 -1655 -3 -897 -2 -1643 1 -1659 6 -27 10 -30 48 -30 49 0 237 41 290 63 22 10 38 24 42 39 3 13 5 294 3 625 l-3 602 30 5 c17 3 552 6 1190 6 l1160 0 6 29 c3 16 7 95 8 175 1 132 0 146 -17 155 -12 6 -433 11 -1179 13 -965 2 -1163 5 -1176 17 -16 12 -17 94 -17 997 0 880 -2 984 -16 998 -13 14 -52 16 -262 17 -1191 5 -1446 9 -1458 21 -12 13 -25 291 -14 301 3 3 931 7 2062 10 1536 4 2061 2 2071 -7 22 -16 26 -67 19 -204 l-7 -123 -856 1 c-471 0 -863 -2 -871 -5 -14 -6 -16 -108 -17 -921 l-2 -914 26 -10 c15 -6 98 -10 185 -10 l159 0 8 33 c4 17 6 199 3 402 -3 204 -4 372 -3 374 1 2 393 5 870 7 814 4 868 5 875 22 3 9 7 83 7 163 1 107 -3 150 -12 164 -13 17 -45 18 -703 17 -710 0 -993 5 -1016 19 -9 6 -15 47 -19 141 -3 73 -3 136 0 140 3 4 395 8 869 9 l864 2 9 26 c15 37 7 1017 -7 1031 -14 14 -4821 23 -4869 9z M1660 3775 c-58 -12 -127 -30 -155 -39 -27 -9 -79 -26 -115 -38 -97 -31 -309 -139 -403 -204 -523 -364 -807 -898 -807 -1518 0 -383 114 -727 350 -1058 24 -35 102 -120 172 -190 215 -214 460 -368 728 -456 497 -164 1028 -97 1450 185 58 39 118 84 134 102 54 57 56 51 56 -162 0 -137 3 -196 12 -205 15 -15 354 -17 363 -2 8 13 13 1384 6 1563 -5 107 -9 140 -21 147 -18 11 -316 12 -344 1 -18 -7 -19 -20 -17 -263 2 -227 0 -265 -18 -341 -36 -150 -108 -276 -225 -392 -212 -210 -521 -336 -820 -335 -174 1 -343 28 -470 76 -79 30 -193 79 -216 94 -8 5 -32 19 -52 30 -76 41 -237 172 -309 252 -200 220 -311 439 -369 725 -42 211 -15 552 56 710 8 17 14 36 14 42 0 6 20 53 43 104 130 278 361 519 640 667 150 79 411 160 470 144 14 -3 28 0 34 8 16 20 28 345 13 363 -17 20 -74 18 -200 -10z';

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
      viewBox="0 0 540 540"
      role="img"
      aria-label={title}
      className={className}
    >
      <g transform="translate(0,540) scale(0.1,-0.1)">
        <path d={MARK_PATH} fill="currentColor" />
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
