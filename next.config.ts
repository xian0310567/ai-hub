import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // output: 'standalone',  // tsx server.ts 방식이라 불필요
  allowedDevOrigins: [
    '*.ngrok-free.app',
    '*.ngrok.io',
    'localhost',
  ],
};

export default nextConfig;
