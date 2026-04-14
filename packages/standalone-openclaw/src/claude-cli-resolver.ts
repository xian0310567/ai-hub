/**
 * Claude CLI 바이너리 경로 탐지기
 *
 * 시스템에서 claude 바이너리를 찾아 경로를 반환합니다.
 * nvm, fnm, volta 등 Node.js 버전 매니저 경로도 탐색합니다.
 */

import { existsSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

function findInVersionManagers(): string | null {
  const home = process.env.HOME || '';
  if (!home) return null;

  // nvm
  const nvmBase = process.env.NVM_DIR || path.join(home, '.nvm');
  const nvmVersions = path.join(nvmBase, 'versions', 'node');
  try {
    for (const d of readdirSync(nvmVersions).reverse()) {
      const p = path.join(nvmVersions, d, 'bin', 'claude');
      if (existsSync(p)) return p;
    }
  } catch {}

  // fnm
  const fnmBase = path.join(home, '.local', 'share', 'fnm', 'node-versions');
  try {
    for (const d of readdirSync(fnmBase).reverse()) {
      const p = path.join(fnmBase, d, 'installation', 'bin', 'claude');
      if (existsSync(p)) return p;
    }
  } catch {}

  // volta
  const voltaP = path.join(home, '.volta', 'bin', 'claude');
  if (existsSync(voltaP)) return voltaP;

  return null;
}

export interface ClaudeCliInfo {
  path: string;
  version: string | null;
  resolved: boolean;
}

/**
 * 시스템에서 claude 바이너리를 찾습니다.
 * 환경변수 > which > 알려진 경로 > 버전 매니저 순으로 탐색합니다.
 */
export function resolveClaudeCli(): ClaudeCliInfo {
  // 1) CLAUDE_CLI_PATH 환경변수
  if (process.env.CLAUDE_CLI_PATH) {
    return {
      path: process.env.CLAUDE_CLI_PATH,
      version: getVersion(process.env.CLAUDE_CLI_PATH),
      resolved: true,
    };
  }

  // 2) which claude
  try {
    const p = execSync('which claude', { encoding: 'utf8', timeout: 3000 }).trim();
    if (p && existsSync(p)) {
      return { path: p, version: getVersion(p), resolved: true };
    }
  } catch {}

  // 3) 알려진 경로
  const candidates = [
    '/opt/node22/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    `${process.env.HOME}/.npm-global/bin/claude`,
    `${process.env.HOME}/.local/bin/claude`,
    `${process.env.HOME}/.bun/bin/claude`,
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      return { path: c, version: getVersion(c), resolved: true };
    }
  }

  // 4) 버전 매니저
  const vmPath = findInVersionManagers();
  if (vmPath) {
    return { path: vmPath, version: getVersion(vmPath), resolved: true };
  }

  return { path: 'claude', version: null, resolved: false };
}

function getVersion(bin: string): string | null {
  try {
    return execSync(`${bin} --version`, { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}
