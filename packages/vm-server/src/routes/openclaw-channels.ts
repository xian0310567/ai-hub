/**
 * OpenClaw 채널 관리 API
 *
 * 조직별 외부 채널(Telegram, Discord 등) 설정을 관리한다.
 * 채널 설정은 openclaw_channels 테이블에 저장되고,
 * sync 시 openclaw.json의 channels 섹션에 반영된다.
 */

import type { FastifyInstance } from 'fastify';
import { q1, qall, exec, newId } from '../db/pool.js';
import { requireAuth, requireRole } from '../db/auth.js';

// 지원되는 채널 타입
const SUPPORTED_CHANNELS = ['telegram', 'discord', 'slack', 'web'] as const;
type ChannelType = (typeof SUPPORTED_CHANNELS)[number];

function isValidChannel(type: string): type is ChannelType {
  return SUPPORTED_CHANNELS.includes(type as ChannelType);
}

export async function openclawChannelRoutes(app: FastifyInstance) {
  /**
   * GET /api/openclaw/channels
   * 현재 조직의 채널 설정 목록
   */
  app.get('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const rows = await qall(
      'SELECT * FROM openclaw_channels WHERE org_id = ? ORDER BY created_at', [user.orgId],
    );
    return rows;
  });

  /**
   * POST /api/openclaw/channels
   * 새 채널 추가
   */
  app.post('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin'], reply)) return;

    const { channel_type, config, enabled, target_agent_id } = req.body as {
      channel_type: string;
      config?: Record<string, unknown>;
      enabled?: boolean;
      target_agent_id?: string | null;
    };

    if (!channel_type || !isValidChannel(channel_type)) {
      return reply.code(400).send({
        error: `지원되는 채널: ${SUPPORTED_CHANNELS.join(', ')}`,
      });
    }

    // 이미 존재하는지 확인
    const existing = await q1(
      'SELECT id FROM openclaw_channels WHERE org_id = ? AND channel_type = ?',
      [user.orgId, channel_type],
    );
    if (existing) {
      return reply.code(409).send({ error: '이미 등록된 채널입니다. PATCH로 수정하세요.' });
    }

    // config round-trip 검증
    let configStr: string;
    try {
      configStr = JSON.stringify(config ?? {});
      JSON.parse(configStr); // round-trip 확인
    } catch {
      return reply.code(400).send({ error: 'config가 유효한 JSON이 아닙니다' });
    }

    // target_agent_id 유효성 검증
    if (target_agent_id) {
      const agent = await q1(
        'SELECT id FROM agents WHERE id = ? AND org_id = ?', [target_agent_id, user.orgId],
      );
      if (!agent) {
        return reply.code(400).send({ error: '지정된 target_agent_id가 조직 내에 존재하지 않습니다.' });
      }
    }

    const id = newId();
    await exec(
      `INSERT INTO openclaw_channels(id, org_id, channel_type, config, enabled, target_agent_id)
       VALUES(?, ?, ?, ?, ?, ?)`,
      [id, user.orgId, channel_type, configStr, enabled ?? true, target_agent_id ?? null],
    );

    return reply.code(201).send(
      await q1('SELECT * FROM openclaw_channels WHERE id = ?', [id]),
    );
  });

  /**
   * PATCH /api/openclaw/channels
   * 채널 설정 수정
   */
  app.patch('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin'], reply)) return;

    const { id, config, enabled, target_agent_id } = req.body as {
      id: string;
      config?: Record<string, unknown>;
      enabled?: boolean;
      target_agent_id?: string | null;
    };

    if (!id) return reply.code(400).send({ error: 'id required' });

    const existing = await q1(
      'SELECT id FROM openclaw_channels WHERE id = ? AND org_id = ?', [id, user.orgId],
    );
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    if (config !== undefined) {
      await exec('UPDATE openclaw_channels SET config = ? WHERE id = ?', [JSON.stringify(config), id]);
    }
    if (enabled !== undefined) {
      await exec('UPDATE openclaw_channels SET enabled = ? WHERE id = ?', [enabled, id]);
    }
    if (target_agent_id !== undefined) {
      if (target_agent_id !== null) {
        const agent = await q1(
          'SELECT id FROM agents WHERE id = ? AND org_id = ?', [target_agent_id, user.orgId],
        );
        if (!agent) {
          return reply.code(400).send({ error: '지정된 target_agent_id가 조직 내에 존재하지 않습니다.' });
        }
      }
      await exec('UPDATE openclaw_channels SET target_agent_id = ? WHERE id = ?', [target_agent_id, id]);
    }

    return q1('SELECT * FROM openclaw_channels WHERE id = ? AND org_id = ?', [id, user.orgId]);
  });

  /**
   * DELETE /api/openclaw/channels
   * 채널 삭제
   */
  app.delete('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin'], reply)) return;

    const { id } = req.body as { id: string };
    await exec('DELETE FROM openclaw_channels WHERE id = ? AND org_id = ?', [id, user.orgId]);

    // stored config 무효화 (다음 조회 시 재생성 유도)
    await exec('DELETE FROM openclaw_configs WHERE org_id = ?', [user.orgId]);

    return { ok: true };
  });
}
