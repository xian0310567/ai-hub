import type { FastifyInstance } from 'fastify';
import { q1, qall, exec, newId } from '../db/pool.js';
import { requireAuth, requireRole } from '../db/auth.js';

export async function divisionRoutes(app: FastifyInstance) {
  app.get('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    return qall('SELECT * FROM divisions WHERE org_id = ? ORDER BY order_index, created_at', [user.orgId]);
  });

  // 조직 트리 전체 반환 (대시보드 / 조직관리 용)
  app.get('/tree', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const orgId = user.orgId;

    const [divs, workspaces, teams, parts, agents] = await Promise.all([
      qall('SELECT * FROM divisions WHERE org_id = ? ORDER BY order_index, created_at', [orgId]),
      qall('SELECT * FROM workspaces WHERE org_id = ? ORDER BY order_index, created_at', [orgId]),
      qall('SELECT * FROM teams WHERE org_id = ? ORDER BY order_index, created_at', [orgId]),
      qall('SELECT * FROM parts WHERE org_id = ? ORDER BY order_index, created_at', [orgId]),
      qall('SELECT * FROM agents WHERE org_id = ? ORDER BY created_at', [orgId]),
    ]);

    const agentMap = agents as any[];
    const findLead = (arr: any[]) => arr.find((a: any) => a.is_lead) ?? null;
    const findWorkers = (arr: any[]) => arr.filter((a: any) => !a.is_lead);

    // parts → { team_id → part[] }
    const partsByTeam = new Map<string, any[]>();
    for (const p of parts as any[]) {
      const list = partsByTeam.get(p.team_id) || [];
      const partAgents = agentMap.filter(a => a.part_id === p.id);
      list.push({ ...p, lead: findLead(partAgents), workers: findWorkers(partAgents) });
      partsByTeam.set(p.team_id, list);
    }

    // teams → { workspace_id → team[] }
    const teamsByWs = new Map<string, any[]>();
    for (const t of teams as any[]) {
      const list = teamsByWs.get(t.workspace_id) || [];
      const teamAgents = agentMap.filter(a => a.team_id === t.id && !a.part_id);
      list.push({
        ...t, lead: findLead(teamAgents), workers: findWorkers(teamAgents),
        parts: partsByTeam.get(t.id) || [],
      });
      teamsByWs.set(t.workspace_id, list);
    }

    // workspaces (departments) → { division_id → dept[] }
    const deptsByDiv = new Map<string, any[]>();
    const standalone: any[] = [];
    for (const ws of workspaces as any[]) {
      const wsAgents = agentMap.filter(a => a.workspace_id === ws.id && !a.team_id && !a.part_id);
      const dept = {
        id: ws.id, name: ws.name, path: ws.path,
        harness_prompt: ws.harness_prompt,
        lead: findLead(wsAgents), teams: teamsByWs.get(ws.id) || [],
      };
      if (ws.division_id) {
        const list = deptsByDiv.get(ws.division_id) || [];
        list.push(dept);
        deptsByDiv.set(ws.division_id, list);
      } else {
        standalone.push(dept);
      }
    }

    // divisions
    const divAgentsByDiv = new Map<string, any[]>();
    for (const a of agentMap) {
      if (a.org_level === 'division' && !a.workspace_id && !a.team_id && !a.part_id) {
        // division-level agent — find which division by checking divisions
        // Agents don't have division_id directly; we match via workspace or infer
      }
    }

    const divisions = (divs as any[]).map(d => ({
      ...d,
      lead: null, // divisions don't have direct agent leads in current schema
      departments: deptsByDiv.get(d.id) || [],
    }));

    return { ok: true, divisions, standalone };
  });

  app.post('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin'], reply)) return;
    const { name, color, ws_path } = req.body as { name: string; color?: string; ws_path?: string };
    if (!name) return reply.code(400).send({ error: 'name required' });

    const id = newId();
    await exec('INSERT INTO divisions(id,org_id,name,color,ws_path) VALUES(?,?,?,?,?)',
      [id, user.orgId, name, color ?? '#6b7280', ws_path ?? '']);
    return reply.code(201).send(await q1('SELECT * FROM divisions WHERE id = ?', [id]));
  });

  app.get('/:id', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const div = await q1('SELECT * FROM divisions WHERE id = ? AND org_id = ?', [id, user.orgId]);
    if (!div) return reply.code(404).send({ error: 'Not found' });
    return div;
  });

  app.patch('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin'], reply)) return;
    const { id, name, color, ws_path, harness_prompt } = req.body as {
      id: string; name?: string; color?: string; ws_path?: string; harness_prompt?: string;
    };
    if (!id) return reply.code(400).send({ error: 'id required' });
    const existing = await q1('SELECT id FROM divisions WHERE id = ? AND org_id = ?', [id, user.orgId]);
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    if (name !== undefined) await exec('UPDATE divisions SET name = ? WHERE id = ?', [name, id]);
    if (color !== undefined) await exec('UPDATE divisions SET color = ? WHERE id = ?', [color, id]);
    if (ws_path !== undefined) await exec('UPDATE divisions SET ws_path = ? WHERE id = ?', [ws_path, id]);
    if (harness_prompt !== undefined) await exec('UPDATE divisions SET harness_prompt = ? WHERE id = ?', [harness_prompt, id]);

    return q1('SELECT * FROM divisions WHERE id = ?', [id]);
  });

  app.delete('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin'], reply)) return;
    const { id } = req.body as { id: string };
    const child = await q1('SELECT id FROM workspaces WHERE division_id = ? LIMIT 1', [id]);
    if (child) {
      reply.code(409);
      return { ok: false, error: '하위 실(워크스페이스)이 존재합니다. 먼저 하위 조직을 삭제해주세요.' };
    }
    await exec('DELETE FROM divisions WHERE id = ? AND org_id = ?', [id, user.orgId]);
    return { ok: true };
  });

  app.post('/reorder', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin'], reply)) return;
    const { ids } = req.body as { ids: string[] };
    await Promise.all(ids.map((id, i) =>
      exec('UPDATE divisions SET order_index = ? WHERE id = ? AND org_id = ?', [i, id, user.orgId])
    ));
    return { ok: true };
  });
}
