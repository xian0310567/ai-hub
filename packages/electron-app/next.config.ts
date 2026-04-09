import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // output: 'standalone',  // tsx server.ts 방식이라 불필요
  serverExternalPackages: ['better-sqlite3', 'cron-parser'],
  allowedDevOrigins: [
    '*.ngrok-free.app',
    '*.ngrok.io',
    'localhost',
  ],
  outputFileTracingExcludes: {
    '/_global-error': ['**/*'],
  },
  skipTrailingSlashRedirect: true,
  skipMiddlewareUrlNormalize: true,
};

export default nextConfig;
