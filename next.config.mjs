/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // WHY pdfjs-dist is external: bundling it rewrites its dynamic-import machinery, and the
  // legacy build then throws on every real PDF at runtime. It is a pure-JS dependency loaded
  // lazily by C11, so leaving it to Node's own resolver costs nothing and keeps it working.
  serverExternalPackages: ['better-sqlite3', 'pdfjs-dist'],
  env: { LA_IS_RELEASE: process.env.NODE_ENV === 'production' ? '1' : '0' },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};
export default nextConfig;
