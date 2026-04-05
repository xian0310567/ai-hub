export function fmtAge(ms: number | null): string {
  if (!ms && ms !== 0) return '--';
  if (ms < 60000)     return Math.round(ms / 1000) + 's ago';
  if (ms < 3600000)   return Math.round(ms / 60000) + 'm ago';
  if (ms < 86400000)  return Math.round(ms / 3600000) + 'h ago';
  return Math.round(ms / 86400000) + 'd ago';
}

export function fmtNum(n: number | undefined): string {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

export function fmtKey(key: string): string {
  if (!key) return '—';
  if (key.includes(':cron:'))     return '🕐 Cron';
  if (key.includes(':telegram:')) return '📱 Telegram';
  return '💬 ' + key.split(':').slice(2, 4).join('/');
}
