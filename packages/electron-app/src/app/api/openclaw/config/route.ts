// packages/electron-app/src/app/api/openclaw/config/route.ts

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import {
  getSetupStatus,
  writeConfig,
  buildDefaultConfig,
  checkClaudeCli,
  SUPPORTED_MODELS,
} from '@/lib/openclaw-config';

/**
 * GET /api/openclaw/config — 현재 설정 상태 조회
 */
export async function GET(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const status = getSetupStatus();
  return Response.json({
    ok: true,
    status,
    supportedModels: SUPPORTED_MODELS,
  });
}

/**
 * POST /api/openclaw/config — 설정 적용
 *
 * Body: { model?: string }
 *
 * 1. openclaw.json 생성
 * 2. 게이트웨이 재시작 (설정 반영)
 */
export async function POST(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  try {
    const { model } = await req.json();

    // 모델 유효성 검사
    const validModels = SUPPORTED_MODELS.map(m => m.id);
    if (model && !validModels.includes(model)) {
      return Response.json({
        ok: false,
        error: `지원하지 않는 모델: ${model}`,
      }, { status: 400 });
    }

    // Claude CLI 사용 가능 확인
    const cliStatus = checkClaudeCli();
    if (!cliStatus.available) {
      return Response.json({
        ok: false,
        error: 'Claude Code CLI가 설치되어 있지 않습니다. `claude` 명령어가 PATH에 있는지 확인하세요.',
      }, { status: 400 });
    }

    // 설정 파일 생성
    const config = buildDefaultConfig(model, cliStatus.path ?? undefined);
    writeConfig(config);

    // 게이트웨이 재시작
    const { stopGateway, startGateway } = await import('@/lib/gateway-manager');
    stopGateway();

    // 잠시 대기 후 재시작 (프로세스 정리 시간)
    await new Promise(r => setTimeout(r, 1000));
    const result = await startGateway(true);

    return Response.json({
      ok: true,
      config: {
        model: config.agents.defaults.model,
        gatewayMode: config.gateway.mode,
        gatewayPort: config.gateway.port,
      },
      gateway: {
        restarted: true,
        running: result.ok,
        reason: result.reason,
        detail: result.detail,
      },
    });
  } catch (err) {
    console.error('[POST /api/openclaw/config] 오류:', err);
    return Response.json({
      ok: false,
      error: err instanceof Error ? err.message : '설정 적용 실패',
    }, { status: 500 });
  }
}
