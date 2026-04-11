/**
 * OpenClaw 워크스페이스 관리 API
 *
 * DB에 저장된 에이전트 데이터로부터 OpenClaw 설정을 동적 생성하고
 * 런타임 파일을 materialization한다.
 */

import type { FastifyInstance } from 'fastify';
import { q1 } from '../db/pool.js';
import { requireAuth, requireRole } from '../db/auth.js';
import {
  generateOpenClawConfig,
  materializeOpenClawWorkspace,
  getStoredOpenClawConfig,
  getOpenClawConfigDiff,
  selectiveMaterializeOpenClawWorkspace,
} from '../services/openclaw-sync.js';

export async function openclawRoutes(app: FastifyInstance) {
  /**
   * GET /api/openclaw/config
   * 현재 조직의 OpenClaw 설정 조회 (DB에서 생성, 파일 미기록)
   */
  app.get('/config', async (req, reply) => {
    const user = await requireAuth(req, reply);

    try {
      const config = await generateOpenClawConfig(user.orgId);
      return { ok: true, config };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  /**
   * GET /api/openclaw/stored
   * DB에 저장된 OpenClaw 설정 조회 (마지막 materialize 결과)
   */
  app.get('/stored', async (req, reply) => {
    const user = await requireAuth(req, reply);

    const stored = await getStoredOpenClawConfig(user.orgId);
    if (!stored) {
      return reply.code(404).send({ ok: false, error: 'OpenClaw 설정이 아직 생성되지 않았습니다.' });
    }

    return { ok: true, ...stored };
  });

  /**
   * POST /api/openclaw/sync
   * DB 에이전트 데이터 → OpenClaw 설정 생성 + 런타임 파일 기록
   * 하네스 변경 후 호출하여 OpenClaw 워크스페이스를 동기화한다.
   */
  app.post('/sync', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin', 'team_admin'], reply)) return;

    try {
      const result = await materializeOpenClawWorkspace(user.orgId);
      return {
        ok: true,
        runtimeDir: result.runtimeDir,
        agentCount: result.agentCount,
        config: result.config,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  /**
   * GET /api/openclaw/diff
   * 저장된 설정과 현재 DB 상태의 차이 비교
   */
  app.get('/diff', async (req, reply) => {
    const user = await requireAuth(req, reply);

    try {
      const diff = await getOpenClawConfigDiff(user.orgId);
      return { ok: true, diff };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  /**
   * POST /api/openclaw/selective-sync
   * 변경된 부분만 선택적으로 업데이트
   */
  app.post('/selective-sync', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin', 'team_admin'], reply)) return;

    try {
      const result = await selectiveMaterializeOpenClawWorkspace(user.orgId);
      return {
        ok: true,
        runtimeDir: result.runtimeDir,
        agentCount: result.agentCount,
        diff: result.diff,
        config: result.config,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  /**
   * GET /api/openclaw/status
   * OpenClaw 워크스페이스 상태 조회
   */
  app.get('/status', async (req, reply) => {
    const user = await requireAuth(req, reply);

    const stored = await getStoredOpenClawConfig(user.orgId);
    const agentCount = await q1<{ count: string }>(
      'SELECT COUNT(*) as count FROM agents WHERE org_id = ?', [user.orgId],
    );

    return {
      ok: true,
      hasSyncedConfig: stored !== null,
      configVersion: stored?.version ?? 0,
      runtimeDir: stored?.runtimeDir ?? null,
      totalAgents: parseInt(agentCount?.count ?? '0', 10),
    };
  });
}
