import type { NextConfig } from 'next';

/**
 * Nuxfolio serves no remote images (see docs/DECISIONS.md, ADR-009), so image
 * optimisation stays closed and no external host is allow-listed.
 */
const nextConfig: NextConfig = {
  /**
   * Ships a self-contained server: `.next/standalone` carries `server.js` plus
   * only the dependencies it actually traced, so the deployment target needs
   * neither a package manager nor `node_modules`.
   *
   * That matters for the target it goes to — 3.7 GB of RAM, no swap, and other
   * people's services already on it. Running `next build` there could OOM and
   * take those down with it, so the build happens elsewhere and only the output
   * travels. See docs/DECISIONS.md, ADR-018.
   */
  output: 'standalone',
  /**
   * In CI the build id is the commit, so building the same commit twice yields a
   * byte-identical bundle — and the self-update timer, which compares checksums,
   * correctly does nothing. Without this, Next.js generates a random id per build
   * and a re-run of CI would restart the live site to deploy an unchanged app.
   * Locally the env var is absent and the default random id is fine.
   */
  generateBuildId: async () => process.env.GITHUB_SHA ?? null,
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    remotePatterns: [],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
