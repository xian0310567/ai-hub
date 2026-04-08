'use client';
/**
 * 라이브 관찰 대시보드 — 에이전트들의 작업 흐름을 2D 픽셀아트 캐릭터로 시각화
 *
 * 애니메이션:
 *  idle   — 살짝 위아래 (기본)
 *  type   — 빠르게 위아래 (타이핑 중)
 *  walk   — 좌우 이동 (다른 팀으로 이동)
 *  done   — 잠깐 커짐 (완료)
 */

import React, { useEffect, useRef, useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { drawSprite } from '@/lib/sprites';

// ── 타입 ─────────────────────────────────────────────────────────
interface Agent   { id: string; name: string; emoji: string; color: string; model: string; is_lead: boolean; }
interface Team    { id: string; name: string; color: string; lead: Agent | null; workers: Agent[]; }
interface Part    { id: string; name: string; team_id: string; lead: Agent | null; workers: Agent[]; }
interface Dept    { id: string; name: string; lead: Agent | null; teams: Team[]; }
interface MJob    { id: string; mission_id: string; agent_id: string; agent_name: string; status: string; subtask: string; }
interface Mission { id: string; task: string; status: string; routing: string; steps: string; }

// ── 스프라이트 모델 → 캐릭터 타입 매핑 ──────────────────────────
function spriteType(model: string): string {
  if (model?.includes('opus'))   return 'opus';
  if (model?.includes('haiku'))  return 'haiku';
  return 'sonnet';
}

// ── CSS keyframes + 전역 스타일 ───────────────────────────────────
const GLOBAL_CSS = `
  @keyframes anim-idle {
    0%, 100% { transform: translateY(0px); }
    50%       { transform: translateY(-4px); }
  }
  @keyframes anim-type {
    0%, 100% { transform: translateY(0px) rotate(0deg); }
    20%       { transform: translateY(-3px) rotate(-2deg); }
    40%       { transform: translateY(1px) rotate(1deg); }
    60%       { transform: translateY(-2px) rotate(-1deg); }
    80%       { transform: translateY(0px) rotate(2deg); }
  }
  @keyframes anim-done {
    0%        { transform: scale(1); }
    30%        { transform: scale(1.3) translateY(-6px); }
    60%        { transform: scale(0.95); }
    100%       { transform: scale(1); }
  }
  @keyframes anim-walk-r {
    0%   { transform: translateX(0)   scaleX(1); }
    49%  { transform: translateX(18px) scaleX(1); }
    50%  { transform: translateX(18px) scaleX(-1); }
    100% { transform: translateX(0)   scaleX(-1); }
  }
  @keyframes anim-walk-l {
    0%   { transform: translateX(0)    scaleX(-1); }
    49%  { transform: translateX(-18px) scaleX(-1); }
    50%  { transform: translateX(-18px) scaleX(1); }
    100% { transform: translateX(0)    scaleX(1); }
  }
  @keyframes anim-bubble {
    0%   { opacity: 0; transform: translateY(4px) scale(0.9); }
    15%  { opacity: 1; transform: translateY(0)   scale(1); }
    85%  { opacity: 1; transform: translateY(0)   scale(1); }
    100% { opacity: 0; transform: translateY(-4px) scale(0.9); }
  }
  @keyframes anim-progress {
    from { width: 0%; }
    to   { width: var(--progress-w); }
  }
  @keyframes anim-arrow {
    0%,100% { opacity: 0.3; }
    50%     { opacity: 1; }
  }
  .char-idle { animation: anim-idle 2s ease-in-out infinite; }
  .char-type { animation: anim-type 0.4s ease-in-out infinite; }
  .char-done { animation: anim-done 0.6s ease-out forwards; }
  .char-walk-r { animation: anim-walk-r 1.2s ease-in-out infinite; }
  .char-walk-l { animation: anim-walk-l 1.2s ease-in-out infinite; }
`;

// ── 말풍선 컴포넌트 ────────────────────────────────────────────────
function Bubble({ text, color }: { text: string; color: string }) {
  return (
    <div style={{
      position: 'absolute', bottom: '110%', left: '50%',
      transform: 'translateX(-50%)',
      background: color + 'ee',
      color: '#fff', fontSize: 10, fontWeight: 600,
      padding: '3px 7px', borderRadius: 8, whiteSpace: 'nowrap',
      maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis',
      animation: 'anim-bubble 4s ease-in-out forwards',
      pointerEvents: 'none', zIndex: 10,
      boxShadow: '0 2px 6px rgba(0,0,0,.3)',
    }}>
      {text}
      <div style={{ position: 'absolute', bottom: -5, left: '50%', transform: 'translateX(-50%)',
        width: 0, height: 0, borderLeft: '5px solid transparent',
        borderRight: '5px solid transparent', borderTop: `5px solid ${color}ee` }} />
    </div>
  );
}

// ── 에이전트 캐릭터 카드 ──────────────────────────────────────────
function AgentChar({
  agent, jobStatus, jobTask, isLead,
}: {
  agent: Agent; jobStatus?: string; jobTask?: string; isLead?: boolean;
}) {
  const cvRef = useRef<HTMLCanvasElement>(null);
  const [bubble, setBubble] = useState<string | null>(null);
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (cvRef.current) drawSprite(cvRef.current);
  }, [agent.model]);

  // 작업 텍스트 변경 시 말풍선 표시
  useEffect(() => {
    if (jobStatus === 'running' && jobTask) {
      setBubble(jobTask.slice(0, 30));
      if (bubbleTimer.current) clearTimeout(bubbleTimer.current);
      bubbleTimer.current = setTimeout(() => setBubble(null), 4200);
    }
    if (jobStatus === 'done') {
      setBubble('완료! ✓');
      if (bubbleTimer.current) clearTimeout(bubbleTimer.current);
      bubbleTimer.current = setTimeout(() => setBubble(null), 2000);
    }
    return () => { if (bubbleTimer.current) clearTimeout(bubbleTimer.current); };
  }, [jobStatus, jobTask]);

  const animClass = (() => {
    if (jobStatus === 'running') return 'char-type';
    if (jobStatus === 'done')    return 'char-done';
    // 리드는 좀 더 활발하게 idle
    return isLead ? 'char-idle' : 'char-idle';
  })();

  const statusColor = (() => {
    if (jobStatus === 'running') return '#0d99ff';
    if (jobStatus === 'done')    return '#14ae5c';
    if (jobStatus === 'failed')  return '#ff4444';
    return 'transparent';
  })();

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
      position: 'relative',
    }}>
      {/* 상태 링 */}
      {statusColor !== 'transparent' && (
        <div style={{
          position: 'absolute', top: -3, left: '50%', transform: 'translateX(-50%)',
          width: 48, height: 4, borderRadius: 2, background: statusColor, opacity: 0.8,
        }} />
      )}

      {/* 말풍선 */}
      {bubble && <Bubble text={bubble} color={agent.color || '#555'} />}

      {/* 스프라이트 */}
      <div className={animClass} style={{ cursor: 'default', position: 'relative' }}>
        <canvas
          ref={cvRef}
          data-sp={spriteType(agent.model)}
          data-tie={agent.color || '#888'}
          data-sc="3"
          style={{ imageRendering: 'pixelated', display: 'block' }}
        />
        {isLead && (
          <div style={{
            position: 'absolute', top: -8, right: -6, fontSize: 10,
            background: 'var(--bg-panel)', borderRadius: '50%',
            width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>⭐</div>
        )}
      </div>

      {/* 이름 + 이모지 */}
      <div style={{ textAlign: 'center', lineHeight: 1.2 }}>
        <div style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 500 }}>{agent.emoji}</div>
        <div style={{ fontSize: 9, color: 'var(--text-secondary)', maxWidth: 52, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {agent.name}
        </div>
      </div>
    </div>
  );
}

// ── 팀 섬 ────────────────────────────────────────────────────────
function TeamIsland({
  team, jobMap,
}: {
  team: Team;
  jobMap: Map<string, MJob>;
}) {
  const allAgents = [
    ...(team.lead ? [{ ...team.lead, isLead: true }] : []),
    ...team.workers.map(w => ({ ...w, isLead: false })),
  ];

  const runningCount = allAgents.filter(a => jobMap.get(a.id)?.status === 'running').length;

  return (
    <div style={{
      background: `${team.color || '#6b7280'}18`,
      border: `1.5px solid ${team.color || '#6b7280'}44`,
      borderRadius: 12,
      padding: '12px 14px',
      minWidth: 140,
      position: 'relative',
      transition: 'box-shadow .3s',
      boxShadow: runningCount > 0
        ? `0 0 16px ${team.color || '#6b7280'}55`
        : '0 2px 8px rgba(0,0,0,.15)',
    }}>
      {/* 팀 이름 */}
      <div style={{
        fontSize: 10, fontWeight: 700, color: team.color || '#9d9d9d',
        textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10,
        textAlign: 'center',
      }}>
        {team.name}
        {runningCount > 0 && (
          <span style={{ marginLeft: 5, fontSize: 9, background: '#0d99ff22', color: '#0d99ff', padding: '1px 5px', borderRadius: 8 }}>
            {runningCount}개 실행
          </span>
        )}
      </div>

      {/* 에이전트들 */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
        {allAgents.map(a => {
          const job = jobMap.get(a.id);
          return (
            <AgentChar
              key={a.id}
              agent={a}
              jobStatus={job?.status}
              jobTask={job?.subtask}
              isLead={a.isLead}
            />
          );
        })}
        {allAgents.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '8px 0' }}>에이전트 없음</div>
        )}
      </div>
    </div>
  );
}

// ── 미션 진행 패널 ─────────────────────────────────────────────────
function MissionPanel({ mission, jobs }: { mission: Mission; jobs: MJob[] }) {
  const done  = jobs.filter(j => j.status === 'done').length;
  const total = jobs.length;
  const pct   = total > 0 ? Math.round((done / total) * 100) : 0;

  const statusColor = mission.status === 'running' ? '#0d99ff'
    : mission.status === 'done' ? '#14ae5c'
    : mission.status === 'failed' ? '#ff4444' : '#f59e0b';

  return (
    <div style={{
      background: 'var(--bg-panel)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '12px 16px', marginBottom: 10,
      borderLeft: `3px solid ${statusColor}`,
    }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: statusColor, textTransform: 'uppercase' }}>
          {mission.status}
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {mission.task}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{done}/{total}</span>
      </div>

      {/* 진행 바 */}
      {total > 0 && (
        <div style={{ height: 4, background: 'var(--bg-canvas)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{
            height: '100%', background: statusColor, borderRadius: 2,
            width: `${pct}%`, transition: 'width .5s ease',
          }} />
        </div>
      )}

      {/* 잡 목록 (최대 5개) */}
      {jobs.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {jobs.slice(0, 6).map(j => (
            <div key={j.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 10, width: 8, textAlign: 'center',
                color: j.status === 'done' ? '#14ae5c' : j.status === 'running' ? '#0d99ff' : j.status === 'failed' ? '#ff4444' : 'var(--text-muted)' }}>
                {j.status === 'done' ? '✓' : j.status === 'running' ? '▶' : j.status === 'failed' ? '✗' : '○'}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <strong style={{ color: 'var(--text-secondary)' }}>{j.agent_name}</strong> — {j.subtask}
              </span>
            </div>
          ))}
          {jobs.length > 6 && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', paddingLeft: 14 }}>+{jobs.length - 6}개 더...</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── 메인 페이지 ──────────────────────────────────────────────────
export default function LivePage() {
  const router = useRouter();

  const [teams,    setTeams]    = useState<Team[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [jobs,     setJobs]     = useState<MJob[]>([]);

  // agent_id → MJob 매핑
  const jobMap = new Map<string, MJob>();
  for (const j of jobs) {
    if (j.status === 'running' || j.status === 'queued') {
      jobMap.set(j.agent_id, j);
    }
  }

  // 데이터 로드
  const loadStructure = useCallback(async () => {
    const r = await fetch('/api/divisions').then(r => r.json()).catch(() => null);
    if (!r?.ok) return;
    const allTeams: Team[] = [];
    for (const div of (r.divisions ?? [])) {
      for (const dept of (div.departments ?? [])) {
        allTeams.push(...(dept.teams ?? []));
      }
    }
    for (const dept of (r.standalone ?? [])) {
      allTeams.push(...(dept.teams ?? []));
    }
    setTeams(allTeams);
  }, []);

  const loadMissions = useCallback(async () => {
    const r = await fetch('/api/missions').then(r => r.json()).catch(() => null);
    if (!r?.ok) return;
    const active = (r.missions ?? []).filter((m: Mission) =>
      ['running', 'analyzing', 'routing'].includes(m.status)
    );
    setMissions(active);

    // 실행 중 미션의 잡 목록 수집
    const allJobs: MJob[] = [];
    for (const m of active) {
      try {
        const steps = JSON.parse(m.steps || '[]');
        if (Array.isArray(steps)) allJobs.push(...steps.map((s: MJob) => ({ ...s, mission_id: m.id })));
      } catch {}
    }
    setJobs(allJobs);
  }, []);

  useEffect(() => {
    fetch('/api/auth/me').then(r => { if (!r.ok) router.replace('/login'); }).catch(() => router.replace('/login'));
    loadStructure();
    loadMissions();

    // 3초마다 미션 상태 갱신
    const timer = setInterval(loadMissions, 3000);
    return () => clearInterval(timer);
  }, [loadStructure, loadMissions, router]);

  // 스프라이트 렌더링
  useEffect(() => {
    const t = setTimeout(() => {
      document.querySelectorAll<HTMLCanvasElement>('canvas[data-sp]').forEach(cv => drawSprite(cv));
    }, 50);
    return () => clearTimeout(t);
  }, [teams, jobs]);

  const activeMissions = missions.filter(m => m.status === 'running');
  const pendingMissions = missions.filter(m => m.status !== 'running');

  return (
    <>
      <style>{GLOBAL_CSS}</style>
      <div style={{
        minHeight: '100vh', background: 'var(--bg-canvas)',
        color: 'var(--text-primary)', display: 'flex', flexDirection: 'column',
        fontFamily: "'Inter', -apple-system, sans-serif",
      }}>

        {/* 헤더 */}
        <div style={{
          height: 44, display: 'flex', alignItems: 'center', gap: 12,
          padding: '0 20px', borderBottom: '1px solid var(--border)',
          background: 'var(--bg-panel)', flexShrink: 0,
        }}>
          <a href="/" style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', textDecoration: 'none' }}
            onMouseOver={e => (e.currentTarget.style.color = 'var(--text-primary)')}
            onMouseOut={e => (e.currentTarget.style.color = 'var(--text-muted)')}>
            ← 대시보드
          </a>
          <span style={{ color: 'var(--border)' }}>|</span>
          <span style={{ fontSize: 14, fontWeight: 700 }}>🎬 라이브 관찰</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%', display: 'inline-block',
              background: activeMissions.length > 0 ? '#14ae5c' : 'var(--text-muted)',
              boxShadow: activeMissions.length > 0 ? '0 0 6px #14ae5c' : 'none',
            }} />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {activeMissions.length > 0 ? `${activeMissions.length}개 미션 실행 중` : '대기 중'}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

          {/* 왼쪽: 미션 패널 */}
          <div style={{
            width: 300, borderRight: '1px solid var(--border)',
            background: 'var(--bg-panel)', overflowY: 'auto', padding: 16, flexShrink: 0,
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
              활성 미션
            </div>
            {missions.length === 0 ? (
              <div style={{ padding: '32px 0', textAlign: 'center' }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>😴</div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>실행 중인 미션 없음</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>메인 화면에서 미션을 시작하세요</div>
              </div>
            ) : (
              missions.map(m => {
                const mJobs = jobs.filter(j => j.mission_id === m.id);
                return <MissionPanel key={m.id} mission={m} jobs={mJobs} />;
              })
            )}
          </div>

          {/* 오른쪽: 에이전트 오피스 스테이지 */}
          <div style={{ flex: 1, overflowX: 'auto', overflowY: 'auto', padding: 24 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 16 }}>
              에이전트 오피스 — 실행 중인 에이전트는 타이핑 애니메이션으로 표시됩니다
            </div>

            {teams.length === 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300 }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 48, marginBottom: 12 }}>🏢</div>
                  <div style={{ fontSize: 14, color: 'var(--text-muted)' }}>팀 구성 정보가 없습니다</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>대시보드에서 팀과 에이전트를 설정하세요</div>
                </div>
              </div>
            ) : (
              <>
                {/* 팀 그리드 */}
                <div style={{
                  display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start',
                }}>
                  {teams.map(team => (
                    <TeamIsland key={team.id} team={team} jobMap={jobMap} />
                  ))}
                </div>

                {/* 범례 */}
                <div style={{
                  marginTop: 32, display: 'flex', gap: 20, fontSize: 11, color: 'var(--text-muted)',
                  borderTop: '1px solid var(--border-subtle)', paddingTop: 16, flexWrap: 'wrap',
                }}>
                  <span>○ 대기</span>
                  <span style={{ color: '#0d99ff' }}>▶ 실행 중 (타이핑 애니메이션)</span>
                  <span style={{ color: '#14ae5c' }}>✓ 완료</span>
                  <span style={{ color: '#ff4444' }}>✗ 실패</span>
                  <span>⭐ 리드 에이전트</span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
