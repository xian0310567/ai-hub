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
  webpack: (config, { isServer }) => {
    if (isServer) {
      // keytar: 미설치 optional 네이티브 모듈 — 번들링에서 완전 제외
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : config.externals ? [config.externals] : []),
        'keytar',
      ];
    }
    return config;
  },
};

export default nextConfig;
