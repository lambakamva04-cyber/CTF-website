import { describe, expect, it } from 'vitest';
import { HSTS, httpsUpgrade, withTransportSecurity } from '../worker/lib/http';

/** A request as it arrives from Cloudflare's edge, which stamps `cf-ray`. */
function edgeRequest(url: string): Request {
  return new Request(url, { headers: { 'cf-ray': '8f2b1c0d0e1f2a3b-JNB' } });
}

describe('upgrading a plain-http request', () => {
  it('sends the browser to the same URL over https', () => {
    const url = new URL('http://app.cutthroughfaster.com/terms?a=1');
    const response = httpsUpgrade(edgeRequest(url.href), url);
    expect(response?.status).toBe(308);
    expect(response?.headers.get('location')).toBe('https://app.cutthroughfaster.com/terms?a=1');
  });

  it('preserves the method, so a POST does not silently become a GET', () => {
    // 308, not 301. A 301 would turn a form post into a GET and drop the body,
    // which fails somewhere far away from the cause.
    const url = new URL('http://app.cutthroughfaster.com/api/auth/login');
    expect(httpsUpgrade(edgeRequest(url.href), url)?.status).toBe(308);
  });

  it('leaves an https request alone', () => {
    const url = new URL('https://app.cutthroughfaster.com/');
    expect(httpsUpgrade(edgeRequest(url.href), url)).toBeNull();
  });

  it('leaves the local dev server alone', () => {
    // `wrangler dev` serves http on loopback and always will.
    for (const href of ['http://localhost:8787/', 'http://127.0.0.1:8787/']) {
      expect(httpsUpgrade(new Request(href), new URL(href))).toBeNull();
    }
  });

  it('does not fire on a request that did not come through the edge', () => {
    // `wrangler dev` rewrites the URL to the hostname in [[routes]], so locally
    // the Worker sees app.cutthroughfaster.com over http — and rewrites the
    // Location back to the local address. Redirecting here would loop forever
    // and `npm run dev` would be unusable.
    const url = new URL('http://app.cutthroughfaster.com/api/health');
    const local = new Request(url.href, { headers: { 'mf-original-hostname': url.hostname } });
    expect(httpsUpgrade(local, url)).toBeNull();
  });
});

describe('HSTS', () => {
  it('is set on https responses', () => {
    const tagged = withTransportSecurity(
      new URL('https://app.cutthroughfaster.com/'),
      new Response('ok'),
    );
    expect(tagged.headers.get('strict-transport-security')).toBe(HSTS);
  });

  it('claims a year and covers subdomains, but does not ask to be preloaded', () => {
    // Preloading ships the domain inside browser binaries; getting off that
    // list takes months. Not something to acquire as a side effect.
    expect(HSTS).toContain('max-age=31536000');
    expect(HSTS).toContain('includeSubDomains');
    expect(HSTS).not.toContain('preload');
  });

  it('is not set on the dev server, which has no certificate', () => {
    const tagged = withTransportSecurity(new URL('http://localhost:8787/'), new Response('ok'));
    expect(tagged.headers.get('strict-transport-security')).toBeNull();
  });

  it('keeps the status and body of the response it decorates', async () => {
    const tagged = withTransportSecurity(
      new URL('https://app.cutthroughfaster.com/'),
      new Response('{"ok":true}', { status: 201, headers: { 'content-type': 'application/json' } }),
    );
    expect(tagged.status).toBe(201);
    expect(tagged.headers.get('content-type')).toBe('application/json');
    expect(await tagged.text()).toBe('{"ok":true}');
  });
});
