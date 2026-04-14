/**
 * Claude CLI 바이너리 경로를 resolve합니다.
 *
 * electron-app 없이 독립적으로 claude 바이너리를 찾고 실행할 수 있도록
 * 여러 후보 경로를 탐색합니다.
 */
import { existsSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

/** nvm/fnm/volta 등 버전 매니저의 bin 디렉터리에서 claude를 찾습니다. */
function findInVersionManagers(): string | null {
  const home = process.env.HOME || '';
  if (!home) return null;

  // nvm: ~/.nvm/versions/node/v*/bin/claude
  const nvmBase = process.env.NVM_DIR || path.join(home, '.nvm');
  const nvmVersions = path.join(nvmBase, 'versions', 'node');
  try {
    const dirs = readdirSync(nvmVersions);
    for (const d of dirs.reverse()) {
      const p = path.join(nvmVersions, d, 'bin', 'claude');
      if (existsSync(p)) return p;
    }
  } catch {}

  // fnm: ~/.local/share/fnm/node-versions/v*/installation/bin/claude
  const fnmBase = path.join(home, '.local', 'share', 'fnm', 'node-versions');
  try {
    const dirs = readdirSync(fnmBase);
    for (const d of dirs.reverse()) {
      const p = path.join(fnmBase, d, 'installation', 'bin', 'claude');
      if (existsSync(p)) return p;
    }
  } catch {}

  // volta: ~/.volta/bin/claude
  const voltaP = path.join(home, '.volta', 'bin', 'claude');
  if (existsSync(voltaP)) return voltaP;

  return null;
}

function resolve(): string {
  // 1) 환경변수로 명시된 경로
  if (process.env.CLAUDE_CLI_PATH) return process.env.CLAUDE_CLI_PATH;

  // 2) which 로 탐색
  try {
    const p = execSync('which claude', { encoding: 'utf8', timeout: 3000 }).trim();
    if (p && existsSync(p)) return p;
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

  // 4) 버전 매니저 경로 탐색
  const vmPath = findInVersionManagers();
  if (vmPath) return vmPath;

  // 5) 최후 폴백
  return 'claude';
}

export const CLAUDE_CLI = resolve();

/**
 * CLAUDE_CLI 실행에 필요한 env.
 * resolve된 바이너리의 디렉터리를 PATH 앞에 추가합니다.
 */
export const CLAUDE_ENV: NodeJS.ProcessEnv = (() => {
  const binDir = path.dirname(CLAUDE_CLI);
  const currentPath = process.env.PATH || '';
  const newPath = currentPath.includes(binDir)
    ? currentPath
    : `${binDir}:${currentPath}`;
  return { ...process.env, PATH: newPath };
})();

/** spawn/execFile ENOENT 에러를 사용자 친화적 메시지로 변환 */
export function claudeSpawnError(e: any): string {
  if (e?.code === 'ENOENT' || (e?.message && e.message.includes('ENOENT'))) {
    if (existsSync(CLAUDE_CLI)) {
      const cwd = e?.options?.cwd || e?.spawnargs?.[0];
      return `작업 디렉터리를 찾을 수 없거나 CLI 실행 중 ENOENT 발생 (CLI: ${CLAUDE_CLI}, cwd: ${cwd || '알 수 없음'}).`;
    }
    return `Claude CLI를 찾을 수 없습니다 (경로: ${CLAUDE_CLI}). `
      + '해결 방법: npm i -g @anthropic-ai/claude-code 로 설치하거나, '
      + 'CLAUDE_CLI_PATH 환경변수에 claude 바이너리 경로를 지정하세요.';
  }
  return e?.message || String(e);
}
