#!/usr/bin/env node

/**
 * standalone-openclaw CLI
 *
 * OpenClaw + Claude CLI를 독립적으로 사용하기 위한 CLI 엔트리포인트.
 * openclaw CLI를 직접 호출하되, claude-cli 백엔드 설정을 자동화합니다.
 *
 * 사용법:
 *   standalone-openclaw setup              — Claude CLI 백엔드 자동 설정
 *   standalone-openclaw status             — 현재 설정 상태 확인
 *   standalone-openclaw gateway            — Gateway 시작
 *   standalone-openclaw agent -m "hello"   — 에이전트에게 메시지 전송
 *   standalone-openclaw openclaw [...]     — openclaw CLI 직접 전달
 */

import { setup, diagnose, SUPPORTED_MODELS } from './setup.js';
import { resolveClaudeCli } from './claude-cli-resolver.js';
import { startGateway, isGatewayAlive } from './gateway.js';
import { runAgent } from './agent.js';

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  switch (command) {
    case 'setup':
      return handleSetup();
    case 'status':
      return handleStatus();
    case 'gateway':
      return handleGateway();
    case 'agent':
      return handleAgent();
    case 'openclaw':
      return handleOpenclawPassthrough();
    case '--help':
    case '-h':
    case undefined:
      return printHelp();
    default:
      console.error(`알 수 없는 명령: ${command}`);
      printHelp();
      process.exit(1);
  }
}

function handleSetup() {
  const force = args.includes('--force');
  const modelArg = args.indexOf('--model');
  const model = modelArg >= 0 ? args[modelArg + 1] : undefined;
  const pathArg = args.indexOf('--claude-path');
  const claudePath = pathArg >= 0 ? args[pathArg + 1] : undefined;

  console.log('🔧 OpenClaw + Claude CLI 설정을 시작합니다...\n');

  const result = setup({ force, model, claudePath });

  if (!result.ok) {
    console.error(`❌ 설정 실패: ${result.error}`);
    process.exit(1);
  }

  console.log(`✅ 설정 완료!`);
  console.log(`   설정 파일: ${result.configPath}`);
  console.log(`   Claude CLI: ${result.claudeCli.path}`);
  if (result.claudeCli.version) {
    console.log(`   버전: ${result.claudeCli.version}`);
  }
  console.log(`   기본 모델: ${result.model}`);
}

function handleStatus() {
  const status = diagnose();
  const claude = resolveClaudeCli();

  console.log('📋 standalone-openclaw 상태\n');
  console.log(`설정 파일: ${status.configPath}`);
  console.log(`설정 존재: ${status.configExists ? '✅' : '❌'}`);
  console.log(`Claude CLI: ${claude.resolved ? `✅ ${claude.path}` : '❌ 미설치'}`);
  if (claude.version) console.log(`CLI 버전: ${claude.version}`);
  console.log(`현재 모델: ${status.currentModel ?? '미설정'}`);
  console.log(`Claude CLI 백엔드: ${status.isClaudeCliBackend ? '✅' : '❌'}`);
  console.log(`준비 상태: ${status.ready ? '✅ 사용 가능' : '❌ setup 필요'}`);

  console.log('\n지원 모델:');
  for (const m of SUPPORTED_MODELS) {
    const mark = m.id === status.currentModel ? ' ← 현재' : '';
    const def = 'default' in m && m.default ? ' (기본)' : '';
    console.log(`  - ${m.label} (${m.id})${def}${mark}`);
  }
}

async function handleGateway() {
  const status = diagnose();
  if (!status.ready) {
    console.log('설정이 필요합니다. 자동 설정을 실행합니다...');
    const result = setup();
    if (!result.ok) {
      console.error(`설정 실패: ${result.error}`);
      process.exit(1);
    }
  }

  const portArg = args.indexOf('--port');
  const port = portArg >= 0 ? parseInt(args[portArg + 1], 10) : undefined;

  if (await isGatewayAlive(port)) {
    console.log(`Gateway가 이미 실행 중입니다 (port: ${port ?? 18789})`);
    return;
  }

  console.log(`🚀 OpenClaw Gateway를 시작합니다 (port: ${port ?? 18789})...`);

  const gw = await startGateway({ port });

  console.log(`✅ Gateway 시작됨 (port: ${gw.port})`);
  console.log('   종료하려면 Ctrl+C를 누르세요.');

  // Ctrl+C로 종료 대기
  process.on('SIGINT', async () => {
    console.log('\nGateway를 종료합니다...');
    await gw.close({ reason: 'user_shutdown' });
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await gw.close({ reason: 'sigterm' });
    process.exit(0);
  });

  // 무한 대기
  await new Promise(() => {});
}

async function handleAgent() {
  const msgIdx = args.indexOf('-m');
  const msgIdx2 = args.indexOf('--message');
  const mi = msgIdx >= 0 ? msgIdx : msgIdx2;

  if (mi < 0 || !args[mi + 1]) {
    console.error('사용법: standalone-openclaw agent -m "메시지" [--model MODEL] [--cwd PATH]');
    process.exit(1);
  }

  const message = args[mi + 1];
  const modelIdx = args.indexOf('--model');
  const model = modelIdx >= 0 ? args[modelIdx + 1] : undefined;
  const cwdIdx = args.indexOf('--cwd');
  const cwd = cwdIdx >= 0 ? args[cwdIdx + 1] : undefined;
  const thinkIdx = args.indexOf('--thinking');
  const thinking = thinkIdx >= 0 ? args[thinkIdx + 1] : undefined;
  const forceCli = args.includes('--cli');

  const result = await runAgent({
    message,
    model,
    cwd,
    thinking,
    forceCliMode: forceCli,
  });

  if (!result.ok) {
    console.error(`❌ 실행 실패 (${result.mode}): ${result.error}`);
    process.exit(1);
  }

  console.log(result.output);
}

async function handleOpenclawPassthrough() {
  // openclaw CLI에 직접 전달
  const { execFileSync } = await import('child_process');
  const openclawArgs = args.slice(1); // 'openclaw' 다음 인자들

  // 설정이 없으면 자동 설정
  const status = diagnose();
  if (!status.ready) {
    setup();
  }

  try {
    // openclaw 바이너리를 찾아서 직접 실행
    const result = execFileSync('npx', ['openclaw', ...openclawArgs], {
      encoding: 'utf8',
      stdio: 'inherit',
      timeout: 600_000,
    });
  } catch (e) {
    const err = e as { status?: number };
    process.exit(err.status ?? 1);
  }
}

function printHelp() {
  console.log(`
standalone-openclaw — OpenClaw + Claude CLI 독립 패키지

사용법:
  standalone-openclaw <command> [options]

명령어:
  setup                     Claude CLI 백엔드로 openclaw 자동 설정
    --force                 기존 설정 덮어쓰기
    --model <model>         기본 모델 지정
    --claude-path <path>    Claude CLI 경로 지정

  status                    현재 설정 상태 확인

  gateway                   OpenClaw Gateway 시작
    --port <port>           포트 지정 (기본 18789)

  agent                     에이전트에게 메시지 전송
    -m, --message <msg>     메시지 (필수)
    --model <model>         모델 지정
    --cwd <path>            작업 디렉터리
    --thinking <level>      thinking 수준 (off|minimal|low|medium|high)
    --cli                   Gateway 없이 CLI 직접 호출

  openclaw [...]            openclaw CLI에 직접 전달

예시:
  standalone-openclaw setup
  standalone-openclaw gateway
  standalone-openclaw agent -m "안녕하세요"
  standalone-openclaw openclaw config get agents.defaults.model
`);
}

main().catch((err) => {
  console.error('오류:', err.message || err);
  process.exit(1);
});
