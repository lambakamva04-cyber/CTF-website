import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * A QR code, rendered as an inline SVG string.
 *
 * Two constraints shape this. The CSP is `img-src 'self' data:` and
 * `connect-src 'self'`, so the usual trick of pointing an <img> at a chart
 * service is blocked — and handing somebody else's server a TOTP secret would
 * be a poor idea whatever the policy allowed. So the code is generated in the
 * browser and never leaves it.
 *
 * The encoder is a library rather than something written here. That was not the
 * first choice: a from-scratch byte-mode encoder is a few hundred lines and
 * avoids a dependency. It was written, and then it was rendered and read back
 * with an independent decoder, and it did not decode. Correctness in an
 * enrolment path is worth more than the dependency, and "looks like a QR code"
 * is not a test anyone can pass by eye.
 */
export function QrCode({ value, size = 200 }: { value: string; size?: number }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    QRCode.toString(value, {
      type: 'svg',
      margin: 2,
      // Medium recovery: a phone camera reading a screen has none of the
      // damage a printed code has to survive, and higher levels only make the
      // modules smaller and harder to read.
      errorCorrectionLevel: 'M',
      color: { dark: '#14161AFF', light: '#FFFFFFFF' },
    })
      .then((markup) => {
        if (!cancelled) setSvg(markup);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [value]);

  if (failed) return null;
  if (!svg) return <div style={{ width: size, height: size }} className="skeleton rounded-lg" />;

  return (
    <div
      style={{ width: size, height: size }}
      className="rounded-lg overflow-hidden bg-white [&>svg]:w-full [&>svg]:h-full"
      role="img"
      aria-label="QR code for your authenticator app"
      // The markup comes from the encoder, built from a string this app
      // constructed — no user input reaches it, and the library emits only
      // <svg>, <rect> and <path>.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
