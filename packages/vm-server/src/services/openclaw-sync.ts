/**
 * OpenClaw 워크스페이스 동기화 서비스
 *
 * DB에 저장된 에이전트/팀/워크스페이스 데이터로부터
 * OpenClaw 호환 설정(openclaw.json)과 런타임 파일(SOUL.md, agents/*.md)을
 * 동적으로 생성한다.
 *
 * DB = Source of Truth, 파일 = 런타임 캐시
 */

import fs from 'fs';
import path from 'path';
import { qall, q1, exec, newId } from '../db/pool.js';

// ── 타입 ──────────────────────────────────────────────────────────────

interface DbAgent {
  id: string;
  org_id: string;
  workspace_id: string | null;
  team_id: string | null;
  part_id: string | null;
  parent_agent_id: string | null;
  org_level: string;
  is_lead: boolean;
  name: string;
  emoji: string;
  color: string;
  soul: string;
  command_name: string | null;
  harness_pattern: string;
  model: string;
}

interface DbTeam {
  id: string;
  name: string;
  workspace_id: string;
  description: string;
}

interface DbWorkspace {
  id: string;
  name: string;
  path: string;
  division_id: string | null;
}

interface DbOrganization {
  id: string;
  name: string;
  slug: string;
}

/** OpenClaw agents.list 항목 */
interface OpenClawAgentEntry {
  id: string;
  default?: boolean;
  name: string;
  workspace?: string;
  model?: { primary: string };
  thinkingDefault?: string;
  subagents?: { allowAgents: string[] };
  runtime?: { type: string };
}

/** OpenClaw bindings 항목 */
interface OpenClawBinding {
  agentId: string;
  match: { channel: string };
}

/** 생성된 OpenClaw 설정 */
export interface GeneratedOpenClawConfig {
  agents: {
    defaults: {
      workspace: string;
      model: { primary: string };
    };
    list: OpenClawAgentEntry[];
  };
  bindings: OpenClawBinding[];
  session?: { mode: string; ttl: string };
}

// ── 유틸 ──────────────────────────────────────────────────────────────

function toAgentId(commandName: string | null, name: string): string {
  if (commandName) return commandName;
  return name
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function toModelRef(model: string): string {
  // claude-sonnet-4-6 → claude-cli/claude-sonnet-4-6
  if (model.startsWith('claude-cli/')) return model;
  return `claude-cli/${model}`;
}

// ── 설정 생성 ─────────────────────────────────────────────────────────

/**
 * DB의 에이전트 데이터로부터 OpenClaw 호환 설정 JSON을 생성한다.
 */
export async function generateOpenClawConfig(orgId: string): Promise<GeneratedOpenClawConfig> {
  const org = await q1<DbOrganization>(
    'SELECT * FROM organizations WHERE id = ?', [orgId],
  );
  if (!org) throw new Error(`Organization not found: ${orgId}`);

  const agents = await qall<DbAgent>(
    'SELECT * FROM agents WHERE org_id = ? ORDER BY created_at', [orgId],
  );

  const teams = await qall<DbTeam>(
    'SELECT * FROM teams WHERE org_id = ? ORDER BY order_index', [orgId],
  );

  const runtimeBase = resolveRuntimeDir(orgId);

  // 팀별 에이전트 그루핑
  const teamMap = new Map<string, DbTeam>();
  for (const t of teams) teamMap.set(t.id, t);

  // 오케스트레이터 (is_lead + org_level=division/department) 또는 별도 생성
  const leaders = agents.filter(a => a.org_level === 'division' || a.org_level === 'department');
  const teamAgents = agents.filter(a => a.team_id && a.org_level !== 'division' && a.org_level !== 'department');

  // OpenClaw 에이전트 리스트 생성
  const agentList: OpenClawAgentEntry[] = [];
  const allTeamIds: string[] = [];

  // 1) 오케스트레이터 (CEO) — 조직 리더가 있으면 사용, 없으면 자동 생성
  const orchestratorId = 'orchestrator';
  const primaryLeader = leaders[0];

  agentList.push({
    id: orchestratorId,
    default: true,
    name: primaryLeader?.name ?? `${org.name} CEO`,
    workspace: path.join(runtimeBase, orchestratorId),
    model: { primary: toModelRef(primaryLeader?.model ?? 'claude-sonnet-4-6') },
    thinkingDefault: 'medium',
    subagents: { allowAgents: ['*'] },
  });

  // 2) 팀별 리드 에이전트 등록
  const teamsWithAgents = new Set<string>();
  for (const agent of teamAgents) {
    if (agent.team_id) teamsWithAgents.add(agent.team_id);
  }

  for (const teamId of teamsWithAgents) {
    const team = teamMap.get(teamId);
    if (!team) continue;

    const teamAgentId = toAgentId(null, team.name);
    allTeamIds.push(teamAgentId);

    const teamLead = teamAgents.find(a => a.team_id === teamId && a.is_lead);
    const members = teamAgents.filter(a => a.team_id === teamId);

    agentList.push({
      id: teamAgentId,
      name: team.name,
      workspace: path.join(runtimeBase, teamAgentId),
      model: { primary: toModelRef(teamLead?.model ?? 'claude-sonnet-4-6') },
      subagents: {
        allowAgents: members
          .filter(a => !a.is_lead)
          .map(a => toAgentId(a.command_name, a.name)),
      },
    });

    // 팀 하위 에이전트들
    for (const member of members) {
      if (member.is_lead) continue; // 리드는 이미 팀 대표로 등록됨
      const memberId = toAgentId(member.command_name, member.name);

      agentList.push({
        id: memberId,
        name: member.name,
        workspace: path.join(runtimeBase, teamAgentId), // 팀 워크스페이스 공유
        model: { primary: toModelRef(member.model) },
        runtime: { type: 'embedded' },
      });
    }
  }

  // 리더가 없는 단독 에이전트 (팀 미소속)
  const standaloneAgents = agents.filter(
    a => !a.team_id && a.org_level === 'worker',
  );
  for (const agent of standaloneAgents) {
    const agentId = toAgentId(agent.command_name, agent.name);
    allTeamIds.push(agentId);

    agentList.push({
      id: agentId,
      name: agent.name,
      workspace: path.join(runtimeBase, agentId),
      model: { primary: toModelRef(agent.model) },
    });
  }

  // 오케스트레이터의 subagents를 팀 리스트로 업데이트
  agentList[0].subagents = { allowAgents: allTeamIds.length > 0 ? allTeamIds : ['*'] };

  return {
    agents: {
      defaults: {
        workspace: runtimeBase,
        model: { primary: 'claude-cli/claude-sonnet-4-6' },
      },
      list: agentList,
    },
    bindings: [
      { agentId: orchestratorId, match: { channel: 'web' } },
    ],
    session: {
      mode: 'per-agent',
      ttl: '24h',
    },
  };
}

// ── 런타임 파일 생성 ──────────────────────────────────────────────────

function resolveRuntimeDir(orgId: string): string {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), '.data');
  return path.join(dataDir, 'openclaw-runtime', orgId);
}

/**
 * DB에서 OpenClaw 설정을 생성하고, 런타임 디렉토리에 파일을 기록한다.
 * - openclaw.json
 * - 에이전트별 SOUL.md, .claude/agents/*.md
 */
export async function materializeOpenClawWorkspace(orgId: string): Promise<{
  runtimeDir: string;
  config: GeneratedOpenClawConfig;
  agentCount: number;
}> {
  const config = await generateOpenClawConfig(orgId);
  const runtimeDir = resolveRuntimeDir(orgId);

  // 런타임 디렉토리 초기화
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  // openclaw.json 기록
  fs.writeFileSync(
    path.join(runtimeDir, 'openclaw.json'),
    JSON.stringify(config, null, 2),
    'utf8',
  );

  // 에이전트별 워크스페이스 파일 생성
  const agents = await qall<DbAgent>(
    'SELECT * FROM agents WHERE org_id = ? ORDER BY created_at', [orgId],
  );

  const teams = await qall<DbTeam>(
    'SELECT * FROM teams WHERE org_id = ? ORDER BY order_index', [orgId],
  );
  const teamMap = new Map<string, DbTeam>();
  for (const t of teams) teamMap.set(t.id, t);

  // 팀별 디렉토리 생성 및 파일 기록
  const processedDirs = new Set<string>();

  for (const agent of agents) {
    let agentDir: string;

    if (agent.org_level === 'division' || agent.org_level === 'department') {
      agentDir = path.join(runtimeDir, 'orchestrator');
    } else if (agent.team_id) {
      const team = teamMap.get(agent.team_id);
      const teamDir = toAgentId(null, team?.name ?? agent.team_id);
      agentDir = path.join(runtimeDir, teamDir);
    } else {
      agentDir = path.join(runtimeDir, toAgentId(agent.command_name, agent.name));
    }

    fs.mkdirSync(path.join(agentDir, '.claude', 'agents'), { recursive: true });

    // SOUL.md — 팀 리더 또는 단독 에이전트일 때 작성
    if (agent.is_lead || !agent.team_id) {
      if (!processedDirs.has(agentDir + ':soul')) {
        fs.writeFileSync(path.join(agentDir, 'SOUL.md'), agent.soul || '', 'utf8');
        processedDirs.add(agentDir + ':soul');
      }
    }

    // .claude/agents/{command_name}.md
    const cmdName = toAgentId(agent.command_name, agent.name);
    const mdContent = [
      '---',
      `name: ${cmdName}`,
      `description: "${agent.name}"`,
      '---',
      '',
      agent.soul || '',
    ].join('\n');
    fs.writeFileSync(
      path.join(agentDir, '.claude', 'agents', `${cmdName}.md`),
      mdContent,
      'utf8',
    );
  }

  // 오케스트레이터 SOUL.md (리더가 없는 경우 자동 생성)
  const orchestratorDir = path.join(runtimeDir, 'orchestrator');
  if (!processedDirs.has(orchestratorDir + ':soul')) {
    fs.mkdirSync(path.join(orchestratorDir, '.claude', 'agents'), { recursive: true });
    const org = await q1<DbOrganization>(
      'SELECT * FROM organizations WHERE id = ?', [orgId],
    );
    const teamNames = teams.map(t => t.name).join(', ');
    const orchestratorSoul = [
      `## 정체성`,
      `당신은 ${org?.name ?? '조직'}의 CEO 에이전트입니다.`,
      '',
      '## 핵심 역할',
      '- 사용자의 요청을 분석하여 적절한 팀에 위임합니다.',
      '- 각 팀의 결과를 통합하여 최종 답변을 제공합니다.',
      '- 필요시 여러 팀에 동시 요청하여 효율을 높입니다.',
      '',
      '## 산하 팀',
      teamNames ? `- ${teamNames}` : '- (아직 구성된 팀이 없습니다)',
      '',
      '## 업무 처리 원칙',
      '- 단순 질문은 직접 답변, 복잡한 요청은 팀에 위임합니다.',
      '- 모든 위임 결과를 검토 후 사용자에게 전달합니다.',
      '- sessions_send를 사용하여 팀 에이전트에게 메시지를 보냅니다.',
    ].join('\n');
    fs.writeFileSync(path.join(orchestratorDir, 'SOUL.md'), orchestratorSoul, 'utf8');
  }

  // DB에 설정 저장/업데이트
  const existing = await q1<{ id: string }>(
    'SELECT id FROM openclaw_configs WHERE org_id = ?', [orgId],
  );
  const now = Math.floor(Date.now() / 1000);

  if (existing) {
    await exec(
      'UPDATE openclaw_configs SET config = ?, runtime_dir = ?, version = version + 1, updated_at = ? WHERE org_id = ?',
      [JSON.stringify(config), runtimeDir, now, orgId],
    );
  } else {
    await exec(
      'INSERT INTO openclaw_configs(id, org_id, config, runtime_dir, version, updated_at) VALUES(?, ?, ?, ?, 1, ?)',
      [newId(), orgId, JSON.stringify(config), runtimeDir, now],
    );
  }

  return { runtimeDir, config, agentCount: agents.length };
}

/**
 * DB에 저장된 OpenClaw 설정을 조회한다 (materialize 없이).
 */
export async function getStoredOpenClawConfig(orgId: string): Promise<{
  config: GeneratedOpenClawConfig;
  runtimeDir: string;
  version: number;
} | null> {
  const row = await q1<{ config: string; runtime_dir: string; version: number }>(
    'SELECT config, runtime_dir, version FROM openclaw_configs WHERE org_id = ?', [orgId],
  );
  if (!row) return null;

  return {
    config: JSON.parse(row.config),
    runtimeDir: row.runtime_dir,
    version: row.version,
  };
}
