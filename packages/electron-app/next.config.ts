import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // output: 'standalone',  // tsx server.ts 방식이라 불필요
  serverExternalPackages: ['better-sqlite3', 'cron-parser', 'keytar'],
  allowedDevOrigins: [
    '*.ngrok-free.app',
    '*.ngrok.io',
    'localhost',
  ],
  outputFileTracingExcludes: {
    '/_global-error': ['**/*'],
  },
  skipTrailingSlashRedirect: true,
  skipProxyUrlNormalize: true,
  turbopack: {},
};

export default nextConfig;
