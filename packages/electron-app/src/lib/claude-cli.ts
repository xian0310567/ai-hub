/**
 * claude CLI 바이너리 경로를 resolve합니다.
 * execFileSync / spawn 에서 'claude' 대신 이 값을 사용하세요.
 *
 * Next.js 서버 프로세스의 PATH에 claude가 없을 수 있어
 * 여러 후보 경로를 탐색합니다.
 */
import { existsSync } from 'fs';
import { execSync } from 'child_process';

function resolve(): string {
  // 1) 환경변수로 명시된 경로
  if (process.env.CLAUDE_CLI_PATH) return process.env.CLAUDE_CLI_PATH;

  // 2) which 로 탐색 (현재 프로세스 PATH 기준)
  try {
    const p = execSync('which claude', { encoding: 'utf8', timeout: 3000 }).trim();
    if (p) return p;
  } catch {}

  // 3) 알려진 일반 경로 후보
  const candidates = [
    '/opt/node22/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    `${process.env.HOME}/.npm-global/bin/claude`,
    `${process.env.HOME}/.local/bin/claude`,
    `${process.env.HOME}/.bun/bin/claude`,
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  // 4) 최후 폴백 — PATH에 있기를 기대
  return 'claude';
}

export const CLAUDE_CLI = resolve();
