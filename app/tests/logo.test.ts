import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Paths built through `fileURLToPath` rather than by handing a `URL` to
// `readFileSync`: this project compiles tests with the DOM lib loaded, where
// `URL` is the browser's and not assignable to Node's.
const HERE = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(join(HERE, '../public/logo.svg'), 'utf8');
const component = readFileSync(join(HERE, '../src/components/Logo.tsx'), 'utf8');

/**
 * Every path payload in a file, whitespace-normalised.
 *
 * Matches the data itself rather than the attribute around it: the icon file
 * writes it as `d="M315 ..."` and the component as `const MARK_PATH = 'M315
 * ...'`, so anchoring on `d=` would silently find nothing in the component and
 * the comparison below would pass by comparing two empty lists.
 */
function paths(source: string): string[] {
  return [...source.matchAll(/['"](M[\d\s.,-][^'"]{100,})['"]/g)].map((m) =>
    (m[1] as string).replace(/\s+/g, ' ').trim(),
  );
}

describe('the CTF mark', () => {
  it('is the same geometry in the icon file and the component', () => {
    // The artwork lives in two files because a favicon needs its own file and
    // the app needs a component. That is a duplication, and duplicated geometry
    // drifts: someone updates the logo, updates one of them, and the tab icon
    // quietly stops matching the header for months. This is the check that the
    // two are literally the same path.
    const fromComponent = paths(component);
    expect(fromComponent).toHaveLength(1);
    expect(paths(svg)).toEqual(fromComponent);
  });

  it('keeps the same coordinate transform in both', () => {
    // The path data is in a 5400-unit, y-up space. Without the matching
    // transform the mark renders ten times too big and upside down.
    const transform = 'translate(0,540) scale(0.1,-0.1)';
    expect(svg).toContain(transform);
    expect(component).toContain(transform);
    expect(svg).toContain('viewBox="0 0 540 540"');
    expect(component).toContain('viewBox="0 0 540 540"');
  });

  it('gives the standalone icon a background but the in-app mark none', () => {
    // A favicon has no page behind it, so it carries its own ground. The
    // component is placed on the dark header and the cream page, so it must not.
    expect(svg).toMatch(/<rect[^>]*fill="#2b2b2b"/);
    expect(component).not.toMatch(/<rect/);
  });

  it('lets the in-app mark take its colour from context', () => {
    expect(component).toContain('fill="currentColor"');
  });

  it('is the artwork CTF supplied', () => {
    // The mark that used to sit here was invented, not supplied — hand-drawn
    // arcs and rects that merely looked like a monogram. Pinning the opening
    // coordinates of the real outline means a future edit cannot quietly put a
    // lookalike back: an approximation will not start on these numbers.
    expect(paths(svg)[0]).toMatch(/^M315 5179 l-30 -8 3 -518/);
    expect(paths(svg)[0]).not.toMatch(/A32 32|A19 19/); // the invented arcs
  });
});
