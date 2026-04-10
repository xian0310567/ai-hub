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

    const { channel_type, config, enabled } = req.body as {
      channel_type: string;
      config?: Record<string, unknown>;
      enabled?: boolean;
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

    const id = newId();
    await exec(
      `INSERT INTO openclaw_channels(id, org_id, channel_type, config, enabled)
       VALUES(?, ?, ?, ?, ?)`,
      [id, user.orgId, channel_type, JSON.stringify(config ?? {}), enabled ?? true],
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

    const { id, config, enabled } = req.body as {
      id: string;
      config?: Record<string, unknown>;
      enabled?: boolean;
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

    return q1('SELECT * FROM openclaw_channels WHERE id = ?', [id]);
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
    return { ok: true };
  });
}
