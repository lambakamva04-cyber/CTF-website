import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

// Gives `next dev` the same Cloudflare context the deployed Worker runs in, so
// local development and production do not diverge on bindings or environment.
initOpenNextCloudflareForDev();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Prospect names and suburbs must never reach a search index. The page also
  // sets `robots: noindex` in its metadata; this is the header-level belt.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
    ];
  },
};

export default nextConfig;
