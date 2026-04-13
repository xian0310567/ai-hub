'use client';
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';

interface Routing {
  org_id: string;
  org_type: string;
  org_name: string;
  agent_id: string;
  agent_name: string;
  subtask: string;
  executor?: 'c3' | 'openclaw';
  executor_reason?: string;
  capability_tags?: string[];
}

interface PreTask {
  type: string;
  params: Record<string, unknown>;
}

interface PostTask {
  type: string;
  params: Record<string, unknown>;
}

interface ExecutionPlanMeta {
  pre_tasks: PreTask[];
  post_tasks: PostTask[];
}

interface Step {
  org_name: string;
  agent_name: string;
  status: 'pending' | 'queued' | 'waiting' | 'running' | 'done' | 'failed' | 'gate_pending';
  queue_position?: number;
  output?: string;
  error?: string;
  job_id?: string;
}

interface Mission {
  id: string;
  task: string;
  status: string;
  routing: Routing[];
  steps: Step[];
  final_doc: string;
  error?: string;
  summary?: string;
  routingMeta?: {
    needs_clarification?: boolean;
    clarification?: string;
    new_org_needed?: string[];
    is_recurring?: boolean;
    cron_expr?: string;
    schedule_name?: string;
    execution_plan?: ExecutionPlanMeta;
  };
  created_at?: number;
}

interface Template {
  id: string;
  name: string;
  description: string;
  task: string;
  tags: string;
  is_builtin: number;
}

interface QualityScores {
  quality: number;
  completeness: number;
  accuracy: number;
  timeliness: number;
  collaboration: number;
  average: number;
}

interface MissionJob {
  id: string;
  agent_name: string;
  quality_scores?: string;
}

type View = 'list' | 'create' | 'routing' | 'running' | 'result';

export default function MissionsPage() {
  const router = useRouter();
  const [missions, setMissions] = useState<Mission[]>([]);
  const [view, setView] = useState<View>('list');
  const [task, setTask] = useState('');
  const [loading, setLoading] = useState(false);
  const [current, setCurrent] = useState<Mission | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [finalDoc, setFinalDoc] = useState('');
  const [err, setErr] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  const [attachedImages, setAttachedImages] = useState<Array<{ id: string; dataUrl: string; name: string; size: number }>>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [expandedSubtasks, setExpandedSubtasks] = useState<Set<number>>(new Set());
  const [templates, setTemplates] = useState<Template[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [missionJobs, setMissionJobs] = useState<MissionJob[]>([]);
  const [boardContent, setBoardContent] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const reload = useCallback(() => {
    fetch('/api/missions').then(r => r.json()).then(d => {
      if (d.ok) setMissions(d.missions);
      else if (d.error === 'Unauthorized') router.replace('/login');
    });
  }, [router]);

  useEffect(() => { reload(); }, [reload]);

  const loadTemplates = useCallback(() => {
    fetch('/api/templates').then(r => r.json()).then(d => { if (d.ok) setTemplates(d.templates); });
  }, []);
  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [steps, finalDoc]);

  // IME 이벤트 핸들러
  const handleCompositionStart = () => {
    setIsComposing(true);
  };

  const handleCompositionEnd = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    setIsComposing(false);
    // 조합 완료 시 최종 텍스트를 명시적으로 상태에 반영
    setTask(e.currentTarget.value);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Shift+Enter 조합은 textarea 기본 동작(줄넘김)을 유지
    if (e.key === 'Enter' && e.shiftKey) {
      // textarea는 기본적으로 Shift+Enter를 줄넘김으로 처리하므로 별도 처리 불필요
      return;
    }
  };

  // 이미지 파일 검증
  const validateImage = (file: File): string | null => {
    const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      return '지원하지 않는 이미지 형식입니다 (jpg, png, gif, webp만 가능)';
    }
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      return '이미지 크기는 5MB 이하여야 합니다';
    }
    return null;
  };

  // 이미지를 base64로 변환하고 첨부 목록에 추가
  const addImageFile = async (file: File) => {
    const error = validateImage(file);
    if (error) {
      setErr(error);
      return;
    }

    if (attachedImages.length >= 5) {
      setErr('최대 5개까지 첨부할 수 있습니다');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      setAttachedImages(prev => [
        ...prev,
        {
          id: Math.random().toString(36).substring(7),
          dataUrl,
          name: file.name,
          size: file.size,
        },
      ]);
      setErr('');
    };
    reader.readAsDataURL(file);
  };

  // 클립보드 붙여넣기 핸들러
  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          await addImageFile(file);
        }
      }
    }
  };

  // 드래그 앤 드롭 핸들러
  const handleDragEnter = (e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
      setIsDragging(false);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = async (e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        await addImageFile(file);
      }
    }
  };

  // 이미지 삭제
  const removeImage = (id: string) => {
    setAttachedImages(prev => prev.filter(img => img.id !== id));
  };

  // 미션 생성 (라우팅 분석) — routing 완료까지 폴링 후 뷰 전환
  const createMission = async () => {
    if (!task.trim()) { setErr('미션을 설명하세요'); return; }
    setLoading(true); setErr('');
    try {
      const r = await fetch('/api/missions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task,
          images: attachedImages.map(img => img.dataUrl),
        }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error);

      // routing 분석이 완료될 때까지 폴링 (최대 310초 — 백엔드 timeout 300s + 여유 10s)
      let mission = d.mission;
      const deadline = Date.now() + 310_000;
      while ((mission.status === 'analyzing' || mission.status === 'routing_failed') && Date.now() < deadline) {
        await new Promise(res => setTimeout(res, 2500));
        const pollRes = await fetch(`/api/missions/${mission.id}`).catch(() => null);
        if (pollRes?.ok) {
          const pollData = await pollRes.json();
          if (pollData.ok) mission = pollData.mission;
        }
        // routing_failed 상태가 routed로 바뀔 수 있으므로 계속 대기
      }

      if (mission.status === 'routing_failed') throw new Error(mission.error || '라우팅 분석 실패 — 다시 시도해주세요');
      if (mission.status === 'analyzing') throw new Error('라우팅 분석 시간 초과 — 다시 시도해주세요');

      setCurrent({ ...mission, routing: mission.routing || [] });
      setView('routing');
      setAttachedImages([]);
    } catch (e: any) { setErr(e.message || '오류'); }
    setLoading(false);
  };

  // SSE 스트림 처리 (run / resume 공통)
  const handleSSEStream = async (missionId: string, endpoint: string) => {
    let streamCompleted = false;

    try {
      const resp = await fetch(endpoint, { method: 'POST' });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        setErr(errData.error || `실행 요청 실패 (${resp.status})`);
        return;
      }

      const reader = resp.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });

        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === 'start') {
              setSteps(ev.steps);
            } else if (ev.type === 'board_update') {
              setBoardContent(ev.content);
            } else if (ev.type === 'step') {
              setSteps(prev => prev.map((s, i) =>
                i === ev.idx ? { ...s, status: ev.status, output: ev.output, error: ev.error, job_id: ev.job_id ?? s.job_id } : s
              ));
            } else if (ev.type === 'done') {
              streamCompleted = true;
              setFinalDoc(ev.final_doc);
              setView('result');
              reload();
              // 잡 품질 점수 로드 (비동기 채점이 완료됐을 수 있음)
              if (missionId) {
                setTimeout(async () => {
                  const jRes = await fetch(`/api/missions/${missionId}/jobs`).catch(() => null);
                  if (jRes?.ok) { const jData = await jRes.json(); setMissionJobs(jData.jobs ?? []); }
                }, 2000);
              }
            } else if (ev.type === 'error') {
              streamCompleted = true;
              setErr(ev.error);
              // 스텝은 완료됐지만 통합 문서 생성 등에서 실패한 경우 — 폴링으로 최종 상태 재확인
              if (missionId) {
                setTimeout(async () => {
                  try {
                    const res = await fetch(`/api/missions/${missionId}`);
                    if (!res.ok) return;
                    const d = await res.json();
                    if (d.ok && d.mission?.status === 'done') {
                      setErr('');
                      setSteps(d.mission.steps || []);
                      setFinalDoc(d.mission.final_doc || '');
                      setCurrent(d.mission);
                      setView('result');
                      reload();
                    }
                  } catch {}
                }, 5000);
              }
            }
          } catch { /* skip parse errors */ }
        }
      }
    } catch (sseErr) {
      // SSE 연결 끊김 — 백엔드에서 아직 실행 중일 수 있으므로 상태 확인
      if (!streamCompleted) {
        const reason = sseErr instanceof Error ? sseErr.message : String(sseErr);
        await pollMissionUntilSettled(missionId, reason);
      }
    }
  };

  // SSE 끊김 시 백엔드 미션 상태를 폴링하여 실제 결과 반영
  const pollMissionUntilSettled = async (missionId: string, reason?: string) => {
    setErr(`실시간 연결이 재설정되었습니다. 백그라운드 실행 상태를 확인 중...`);
    const deadline = Date.now() + 5 * 60 * 1000; // 최대 5분 폴링

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const res = await fetch(`/api/missions/${missionId}`);
        if (!res.ok) continue;
        const d = await res.json();
        if (!d.ok) continue;
        const m = d.mission;

        if (m.status === 'done') {
          setErr('');
          setSteps(m.steps || []);
          setFinalDoc(m.final_doc || '');
          setCurrent(m);
          setView('result');
          reload();
          return;
        }
        if (m.status === 'failed') {
          const stepErrors = (m.steps || []).filter((s: Step) => s.error).map((s: Step) => `[${s.org_name}] ${s.error}`);
          const detail = m.error || stepErrors.join('; ') || '원인을 확인할 수 없습니다';
          setErr(`미션 실행 실패: ${detail}`);
          setSteps(m.steps || []);
          reload();
          return;
        }
        // 아직 running — steps 갱신하며 계속 폴링
        if (m.steps?.length) setSteps(m.steps);
      } catch { /* 폴링 실패 무시, 재시도 */ }
    }
    setErr('백그라운드 실행 상태를 확인할 수 없습니다. 미션 목록에서 결과를 확인하세요.');
  };

  // 미션 실행
  const runMission = async (mission: Mission) => {
    setView('running');
    setCurrent(mission);
    setSteps(mission.routing.map(r => ({ org_name: r.org_name, agent_name: r.agent_name, status: 'pending' as const })));
    setFinalDoc('');
    setBoardContent('');
    setErr('');
    await handleSSEStream(mission.id, `/api/missions/${mission.id}/run`);
  };

  // 미션 재개 (실패한 잡만 다시 실행)
  const resumeMission = async (mission: Mission) => {
    setView('running');
    setCurrent(mission);
    setFinalDoc('');
    setBoardContent('');
    setErr('');
    // 기존 step 상태 유지 (done 항목은 그대로 보여줌)
    try {
      const d = await fetch(`/api/missions/${mission.id}`).then(r => r.json());
      if (d.ok) setSteps(d.mission.steps || []);
    } catch {}
    await handleSSEStream(mission.id, `/api/missions/${mission.id}/resume`);
  };

  // Human Gate 승인
  const approveJob = async (missionId: string, jobId: string) => {
    const res = await fetch(`/api/missions/${missionId}/jobs/${jobId}/approve`, { method: 'PATCH' });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setErr(d.error || '승인 실패');
    }
  };

  // 과거 미션 결과 보기
  const viewMission = async (m: Mission) => {
    try {
      const [missionRes, jobsRes] = await Promise.all([
        fetch(`/api/missions/${m.id}`),
        fetch(`/api/missions/${m.id}/jobs`),
      ]);
      const d = await missionRes.json();
      const jobsData = await jobsRes.json().catch(() => ({ ok: false }));
      if (d.ok) {
        setCurrent(d.mission);
        setSteps(d.mission.steps || []);
        setFinalDoc(d.mission.final_doc || '');
        setMissionJobs(jobsData.ok ? jobsData.jobs : []);
        setView('result');
      }
    } catch {}
  };

  const deleteMission = async (id: string) => {
    if (!confirm('이 미션을 삭제할까요?')) return;
    await fetch(`/api/missions?id=${id}`, { method: 'DELETE' });
    reload();
  };

  const isRecentMission = (m: any) => {
    const now = Math.floor(Date.now() / 1000);
    return (now - (m.created_at || 0)) < 300; // 5분 이내
  };

  const getStatusBadge = (m: any) => {
    // routing_failed 이지만 5분 이내 미션은 아직 분석 중으로 표시 (CLI 재시도 가능)
    if (m.status === 'routing_failed' && isRecentMission(m)) {
      return { label: '분석 중', color: '#8b5cf6' };
    }
    return STATUS_BADGE[m.status] || { label: m.status, color: 'var(--text-muted)' };
  };

  const STATUS_BADGE: Record<string, { label: string; color: string }> = {
    pending:             { label: '대기',    color: 'var(--text-muted)' },
    analyzing:           { label: '분석 중', color: '#8b5cf6' },
    routing_failed:      { label: '라우팅 실패', color: 'var(--danger)' },
    needs_clarification: { label: '확인 필요', color: '#f59e0b' },
    routed:              { label: '준비됨',  color: '#3b82f6' },
    running:             { label: '실행 중', color: '#f59e0b' },
    done:                { label: '완료',    color: 'var(--success)' },
    failed:              { label: '실패',    color: 'var(--danger)' },
  };

  const STEP_ICON: Record<string, string> = {
    pending:      '⏳',
    queued:       '🕐',
    waiting:      '⏸',
    running:      '🔄',
    done:         '✅',
    failed:       '❌',
    gate_pending: '🔐',
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-canvas)' }}>
      <nav>
        <div className="nav-title">AI 사업부</div>
        <a href="/" style={navLink}>대시보드</a>
        <a href="/org" style={navLink}>조직 관리</a>
        <span style={{ ...navLink, color: 'var(--accent)', borderColor: 'var(--accent-dim)' }}>미션</span>
        <a href="/schedules" style={navLink}>스케줄</a>
        <button
          onClick={async () => {
            if (confirm('로그아웃하시겠습니까?')) {
              try {
                await fetch('/api/auth/signout', { method: 'POST' });
                router.push('/login');
              } catch (e) {
                alert('로그아웃 실패');
              }
            }
          }}
          style={{
            marginLeft: 'auto',
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--text-secondary)',
            textDecoration: 'none',
            padding: '4px 10px',
            border: '1px solid var(--border)',
            borderRadius: 4,
            transition: 'all .12s',
            background: 'none',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
          onMouseOver={e => {
            e.currentTarget.style.color = 'var(--danger)';
            e.currentTarget.style.borderColor = 'var(--danger)';
          }}
          onMouseOut={e => {
            e.currentTarget.style.color = 'var(--text-secondary)';
            e.currentTarget.style.borderColor = 'var(--border)';
          }}
        >
          로그아웃
        </button>
      </nav>

      <div style={{ padding: '24px 32px', maxWidth: 900, margin: '54px auto 0' }}>

        {/* 헤더 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <span style={{ fontSize: 20 }}>🎯</span>
          <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>미션 센터</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {view !== 'list' && (
              <button className="nav-btn" onClick={() => { setView('list'); setCurrent(null); setErr(''); }}>← 목록</button>
            )}
            {view === 'list' && (
              <button className="nav-btn purple" onClick={() => setView('create')}>+ 새 미션</button>
            )}
          </div>
        </div>

        {/* ── 목록 뷰 ── */}
        {view === 'list' && (
          <>
            {missions.length === 0 && (
              <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
                <div style={{ fontSize: 36, marginBottom: 16 }}>🎯</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>미션이 없습니다</div>
                <div style={{ fontSize: 12 }}>자연어로 업무를 설명하면 조직에 자동 배정됩니다</div>
                <button className="nav-btn purple" style={{ marginTop: 16 }} onClick={() => setView('create')}>+ 첫 미션 만들기</button>
              </div>
            )}
            {missions.map(m => (
              <div key={m.id} style={{
                border: '1px solid var(--border)', borderRadius: 6, padding: '14px 18px',
                marginBottom: 10, background: 'var(--bg-panel)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 12,
                transition: 'border-color .12s',
              }}
                onMouseOver={e => e.currentTarget.style.borderColor = '#555'}
                onMouseOut={e => e.currentTarget.style.borderColor = 'var(--border)'}
                onClick={() => m.status === 'done' ? viewMission(m) : m.status === 'routed' ? runMission(m) : m.status === 'needs_clarification' ? (() => { setCurrent(m); setView('routing'); })() : undefined}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>{m.task}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {m.routing.length}개 조직 배정 · {new Date((m.created_at || 0) * 1000).toLocaleDateString('ko')}
                  </div>
                  {(m.status === 'failed' || (m.status === 'routing_failed' && !isRecentMission(m))) && m.error && (
                    <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 4, lineHeight: 1.5 }}>
                      오류: {m.error.length > 120 ? m.error.slice(0, 120) + '...' : m.error}
                    </div>
                  )}
                  {m.status === 'running' && m.steps?.some((s: Step) => s.status === 'failed') && (
                    <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 4, lineHeight: 1.5 }}>
                      일부 실패: {m.steps.filter((s: Step) => s.status === 'failed').map((s: Step) => `[${s.org_name}] ${s.error || '알 수 없음'}`).join(', ').slice(0, 120)}
                    </div>
                  )}
                </div>
                {(() => {
                  const badge = getStatusBadge(m);
                  return (
                    <span style={{
                      fontSize: 10, fontWeight: 600, padding: '3px 10px', borderRadius: 12,
                      color: badge.color, background: badge.color + '18',
                      border: `1px solid ${badge.color}33`,
                    }}>
                      {badge.label}
                    </span>
                  );
                })()}
                {m.status === 'failed' && (
                  <button onClick={e => { e.stopPropagation(); resumeMission(m); }}
                    style={{ background: 'none', border: '1px solid #f59e0b', color: '#f59e0b', cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 4, fontFamily: 'inherit' }}
                    title="실패한 잡만 이어서 실행"
                  >↺ 재개</button>
                )}
                <button onClick={e => { e.stopPropagation(); deleteMission(m.id); }}
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14 }}
                  onMouseOver={e => e.currentTarget.style.color = 'var(--danger)'}
                  onMouseOut={e => e.currentTarget.style.color = 'var(--text-muted)'}
                >✕</button>
              </div>
            ))}
          </>
        )}

        {/* ── 생성 뷰 ── */}
        {view === 'create' && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 24, background: 'var(--bg-panel)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>🎯 새 미션 생성</span>
              {templates.length > 0 && (
                <button onClick={() => setShowTemplates(v => !v)} style={{
                  marginLeft: 'auto', fontSize: 11, fontWeight: 600, padding: '4px 12px', borderRadius: 4,
                  background: showTemplates ? 'var(--accent)' : 'none', color: showTemplates ? '#fff' : 'var(--accent)',
                  border: '1px solid var(--accent)', cursor: 'pointer', fontFamily: 'inherit',
                }}>
                  📋 템플릿 {showTemplates ? '▲' : '▼'}
                </button>
              )}
            </div>

            {/* 템플릿 갤러리 */}
            {showTemplates && templates.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 10 }}>
                  템플릿 선택
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8, maxHeight: 260, overflowY: 'auto', paddingBottom: 4 }}>
                  {templates.map(t => (
                    <div key={t.id} onClick={() => { setTask(t.task); setShowTemplates(false); }}
                      style={{
                        border: '1px solid var(--border)', borderRadius: 6, padding: '12px 14px',
                        cursor: 'pointer', background: 'var(--bg-elevated)', transition: 'border-color .1s',
                        borderLeft: t.is_builtin ? '3px solid var(--accent)' : '3px solid var(--border)',
                      }}
                      onMouseOver={e => { (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--accent)'; }}
                      onMouseOut={e => { (e.currentTarget as HTMLDivElement).style.borderColor = t.is_builtin ? 'var(--accent)' : 'var(--border)'; }}
                    >
                      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
                        {t.is_builtin ? '⭐ ' : ''}{t.name}
                      </div>
                      {t.description && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>{t.description}</div>
                      )}
                      <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.4, fontStyle: 'italic' }}>
                        {t.task.slice(0, 80)}{t.task.length > 80 ? '…' : ''}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 16 }}>
              어떤 업무를 진행하고 싶은지 자연어로 설명하세요.<br />
              AI가 조직도를 분석하여 적합한 팀에 자동 배정합니다.
            </div>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>
              미션 설명
              <textarea
                ref={textareaRef}
                className="modal-input"
                value={task}
                onChange={e => setTask(e.target.value)}
                onCompositionStart={handleCompositionStart}
                onCompositionEnd={handleCompositionEnd}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                rows={5}
                autoFocus
                style={{
                  resize: 'vertical',
                  lineHeight: 1.7,
                  fontSize: 13,
                  border: isDragging ? '2px dashed var(--accent)' : undefined,
                  background: isDragging ? 'var(--accent-dim)' : undefined,
                }}
                placeholder="예: AI Hub에 채팅 히스토리 검색 기능을 추가해줘. 백엔드 API 설계 + 프론트엔드 UI + 테스트까지."
              />
            </label>

            {/* 이미지 첨부 안내 */}
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span>💡</span>
              <span>Ctrl+V로 이미지 붙여넣기 또는 드래그하여 첨부 (최대 5개, 각 5MB 이하)</span>
            </div>

            {/* 첨부된 이미지 미리보기 */}
            {attachedImages.length > 0 && (
              <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {attachedImages.map(img => (
                  <div
                    key={img.id}
                    style={{
                      position: 'relative',
                      width: 100,
                      height: 100,
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      overflow: 'hidden',
                      background: 'var(--bg-elevated)',
                    }}
                  >
                    <img
                      src={img.dataUrl}
                      alt={img.name}
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                      }}
                    />
                    <button
                      onClick={() => removeImage(img.id)}
                      style={{
                        position: 'absolute',
                        top: 2,
                        right: 2,
                        background: 'rgba(0, 0, 0, 0.7)',
                        border: 'none',
                        borderRadius: 3,
                        color: '#fff',
                        cursor: 'pointer',
                        fontSize: 14,
                        width: 20,
                        height: 20,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: 0,
                      }}
                      onMouseOver={e => e.currentTarget.style.background = 'rgba(242, 72, 34, 0.9)'}
                      onMouseOut={e => e.currentTarget.style.background = 'rgba(0, 0, 0, 0.7)'}
                    >
                      ✕
                    </button>
                    <div
                      style={{
                        position: 'absolute',
                        bottom: 0,
                        left: 0,
                        right: 0,
                        background: 'rgba(0, 0, 0, 0.7)',
                        color: '#fff',
                        fontSize: 9,
                        padding: '2px 4px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={`${img.name} (${(img.size / 1024).toFixed(1)}KB)`}
                    >
                      {img.name}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {err && <div style={{ color: 'var(--danger)', fontSize: 11, padding: '6px 10px', background: 'var(--danger-dim)', borderRadius: 4, border: '1px solid #f2482233', marginTop: 10 }}>{err}</div>}
            {loading && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, padding: '10px 14px', background: 'var(--accent-dim)', borderRadius: 6, border: '1px solid var(--accent)33' }}>
                <span style={{ fontSize: 14, display: 'inline-block' }}>⏳</span>
                <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 500 }}>조직도 분석 중... 적합한 팀을 찾고 있습니다 (약 30초)</span>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button className="modal-btn-cancel" onClick={() => { setView('list'); setErr(''); setAttachedImages([]); }} disabled={loading} style={{ flex: 1, opacity: loading ? 0.4 : 1 }}>취소</button>
              <button className="modal-btn-ok" onClick={createMission} disabled={loading} style={{ flex: 2, opacity: loading ? 0.7 : 1 }}>
                {loading ? '분석 중...' : '🔍 라우팅 분석'}
              </button>
            </div>
          </div>
        )}

        {/* ── 라우팅 미리보기 ── */}
        {view === 'routing' && current && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 24, background: 'var(--bg-panel)' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>📋 라우팅 분석 결과</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 20 }}>{current.task}</div>

            {current.summary && (
              <div style={{ padding: '10px 14px', background: 'var(--bg-elevated)', borderRadius: 6, border: '1px solid var(--border)', marginBottom: 16, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                💡 {current.summary}
              </div>
            )}

            {/* 확인 필요 안내 */}
            {current.status === 'needs_clarification' && (
              <div style={{ padding: '14px 16px', background: '#f59e0b0a', border: '1px solid #f59e0b40', borderRadius: 6, marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 16 }}>⚠️</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#f59e0b' }}>확인이 필요합니다</span>
                </div>
                {current.routingMeta?.clarification && (
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 10 }}>
                    {current.routingMeta.clarification}
                  </div>
                )}
                {current.routingMeta?.new_org_needed && current.routingMeta.new_org_needed.length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
                    권장 조직 생성: {current.routingMeta.new_org_needed.map((org, i) => (
                      <span key={i} style={{ display: 'inline-block', background: '#f59e0b18', color: '#f59e0b', padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600, marginLeft: i > 0 ? 4 : 0 }}>{org}</span>
                    ))}
                  </div>
                )}
                {current.routing.length > 0 && (
                  <button
                    className="nav-btn purple"
                    style={{ fontSize: 11, padding: '6px 14px' }}
                    onClick={() => {
                      fetch(`/api/missions`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: current.id, extra_routing: [] }) })
                        .then(() => { setCurrent({ ...current, status: 'routed' }); })
                        .catch(() => setErr('상태 변경 실패'));
                    }}
                  >
                    그래도 실행하기
                  </button>
                )}
              </div>
            )}

            {/* 반복 미션 스케줄 배지 */}
            {(() => {
              try {
                const stepsData = typeof current.steps === 'string' ? JSON.parse(current.steps) : current.steps;
                if (stepsData?.is_recurring && stepsData?.cron_expr) {
                  return (
                    <div style={{ padding: '10px 14px', background: '#0891b208', border: '1px solid #0891b240', borderRadius: 6, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                      <span style={{ fontSize: 16 }}>🕐</span>
                      <div>
                        <span style={{ fontWeight: 600, color: '#0891b2' }}>반복 미션으로 스케줄 등록됨</span>
                        {stepsData.schedule_name && <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>— {stepsData.schedule_name}</span>}
                        <code style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{stepsData.cron_expr}</code>
                      </div>
                      <a href="/schedules" style={{ marginLeft: 'auto', fontSize: 11, color: '#0891b2', textDecoration: 'none', border: '1px solid #0891b240', borderRadius: 4, padding: '3px 8px' }}>스케줄 관리 →</a>
                    </div>
                  );
                }
              } catch {}
              return null;
            })()}

            {/* 실행 계획 (execution_plan) */}
            {current.routingMeta?.execution_plan && (
              (() => {
                const ep = current.routingMeta.execution_plan!;
                const hasPreTasks = ep.pre_tasks && ep.pre_tasks.length > 0;
                const hasPostTasks = ep.post_tasks && ep.post_tasks.length > 0;
                const hasExecutors = current.routing.some(r => r.executor === 'openclaw');
                if (!hasPreTasks && !hasPostTasks && !hasExecutors) return null;
                return (
                  <div style={{ padding: '14px 16px', background: '#8b5cf608', border: '1px solid #8b5cf640', borderRadius: 6, marginBottom: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                      <span style={{ fontSize: 14 }}>{'⚡'}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#8b5cf6' }}>실행 계획</span>
                    </div>
                    {hasPreTasks && (
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>사전 작업 ({ep.pre_tasks.length}건)</div>
                        {ep.pre_tasks.map((t, i) => (
                          <div key={i} style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '4px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ color: '#8b5cf6' }}>{'▸'}</span>
                            {t.type === 'openclaw_cron' ? `OpenClaw 크론 등록: ${(t.params as any).name || (t.params as any).cron || ''}` : t.type}
                          </div>
                        ))}
                      </div>
                    )}
                    {hasExecutors && (
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>에이전트 실행 수단</div>
                        {current.routing.filter(r => r.executor).map((r, i) => (
                          <div key={i} style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '4px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ display: 'inline-block', padding: '1px 6px', borderRadius: 4, fontSize: 10, fontWeight: 600, background: r.executor === 'openclaw' ? '#8b5cf618' : '#10b98118', color: r.executor === 'openclaw' ? '#8b5cf6' : '#10b981' }}>{r.executor === 'openclaw' ? 'OpenClaw' : 'c3'}</span>
                            <span>[{r.org_name}] {r.agent_name}</span>
                            {r.executor_reason && <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>— {r.executor_reason}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                    {hasPostTasks && (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>후속 작업 ({ep.post_tasks.length}건)</div>
                        {ep.post_tasks.map((t, i) => (
                          <div key={i} style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '4px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ color: '#8b5cf6' }}>{'▸'}</span>
                            {t.type === 'openclaw_deliver' ? `채널 전송: ${(t.params as any).channel || ''} ${(t.params as any).to || ''}` : t.type}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()
            )}

            {/* 통계 요약 카드 */}
            {(() => {
              const divisionCount = current.routing.filter(r => r.org_type === 'division').length;
              const departmentCount = current.routing.filter(r => r.org_type === 'department').length;
              const teamCount = current.routing.filter(r => r.org_type === 'team').length;

              return (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 16 }}>
                  <div style={{
                    padding: '12px 14px', background: 'var(--bg-elevated)', borderRadius: 6,
                    border: '1px solid var(--border)', textAlign: 'center'
                  }}>
                    <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 2 }}>
                      {current.routing.length}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, letterSpacing: '0.05em' }}>
                      총 조직
                    </div>
                  </div>
                  {divisionCount > 0 && (
                    <div style={{
                      padding: '12px 14px', background: '#7c3aed08', borderRadius: 6,
                      border: '1px solid #7c3aed33', textAlign: 'center'
                    }}>
                      <div style={{ fontSize: 20, fontWeight: 700, color: '#7c3aed', marginBottom: 2 }}>
                        {divisionCount}
                      </div>
                      <div style={{ fontSize: 10, color: '#7c3aed', fontWeight: 600, letterSpacing: '0.05em' }}>
                        사업부
                      </div>
                    </div>
                  )}
                  {departmentCount > 0 && (
                    <div style={{
                      padding: '12px 14px', background: '#4f46e508', borderRadius: 6,
                      border: '1px solid #4f46e533', textAlign: 'center'
                    }}>
                      <div style={{ fontSize: 20, fontWeight: 700, color: '#4f46e5', marginBottom: 2 }}>
                        {departmentCount}
                      </div>
                      <div style={{ fontSize: 10, color: '#4f46e5', fontWeight: 600, letterSpacing: '0.05em' }}>
                        본부
                      </div>
                    </div>
                  )}
                  {teamCount > 0 && (
                    <div style={{
                      padding: '12px 14px', background: '#0891b208', borderRadius: 6,
                      border: '1px solid #0891b233', textAlign: 'center'
                    }}>
                      <div style={{ fontSize: 20, fontWeight: 700, color: '#0891b2', marginBottom: 2 }}>
                        {teamCount}
                      </div>
                      <div style={{ fontSize: 10, color: '#0891b2', fontWeight: 600, letterSpacing: '0.05em' }}>
                        팀
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 10 }}>배정 조직</div>

            {/* 스크롤 가능한 라우팅 목록 */}
            <div style={{ maxHeight: '50vh', overflowY: 'auto', paddingRight: 4 }}>
              {current.routing.map((r, i) => {
                const isExpanded = expandedSubtasks.has(i);
                const subtaskLines = r.subtask.split('\n');
                const needsExpand = subtaskLines.length > 2 || r.subtask.length > 150;
                const displaySubtask = (!isExpanded && needsExpand)
                  ? subtaskLines.slice(0, 2).join('\n') + (subtaskLines.length > 2 ? '...' : '')
                  : r.subtask;

                return (
                  <div key={i} style={{
                    border: '1px solid var(--border)', borderRadius: 6, padding: '14px 16px',
                    marginBottom: 8, background: 'var(--bg-elevated)',
                    borderLeft: `3px solid ${r.org_type === 'division' ? '#7c3aed' : r.org_type === 'department' ? '#4f46e5' : '#0891b2'}`,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{
                        fontSize: 11, fontWeight: 700,
                        color: r.org_type === 'division' ? '#7c3aed' : r.org_type === 'department' ? '#4f46e5' : '#0891b2',
                        background: r.org_type === 'division' ? '#7c3aed18' : r.org_type === 'department' ? '#4f46e518' : '#0891b218',
                        padding: '2px 8px', borderRadius: 10,
                        minWidth: 24, textAlign: 'center'
                      }}>
                        {i + 1}
                      </span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
                        {r.org_type === 'division' ? '◉' : r.org_type === 'department' ? '🏢' : '▸'} {r.org_name}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg-canvas)', padding: '2px 8px', borderRadius: 10 }}>
                        → {r.agent_name}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
                      {displaySubtask}
                    </div>
                    {needsExpand && (
                      <button
                        onClick={() => {
                          setExpandedSubtasks(prev => {
                            const newSet = new Set(prev);
                            if (isExpanded) newSet.delete(i);
                            else newSet.add(i);
                            return newSet;
                          });
                        }}
                        style={{
                          marginTop: 8, fontSize: 11, fontWeight: 500, color: 'var(--accent)',
                          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                          textDecoration: 'underline'
                        }}
                        onMouseOver={e => e.currentTarget.style.opacity = '0.7'}
                        onMouseOut={e => e.currentTarget.style.opacity = '1'}
                      >
                        {isExpanded ? '접기 ▲' : '더보기 ▼'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
              <button className="modal-btn-cancel" onClick={() => { setView('list'); setCurrent(null); setExpandedSubtasks(new Set()); reload(); }} style={{ flex: 1 }}>취소</button>
              {current.status !== 'needs_clarification' ? (
                <button className="modal-btn-ok" onClick={() => runMission(current)} style={{ flex: 2, background: 'var(--success)', borderColor: 'var(--success)' }}>
                  ▶ 미션 실행
                </button>
              ) : current.routing.length > 0 ? (
                <button className="modal-btn-ok" onClick={() => {
                  fetch('/api/missions', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: current.id, extra_routing: [] }) })
                    .then(() => runMission({ ...current, status: 'routed' }))
                    .catch(() => setErr('상태 변경 실패'));
                }} style={{ flex: 2, background: '#f59e0b', borderColor: '#f59e0b' }}>
                  ⚠ 확인 후 실행
                </button>
              ) : (
                <button className="modal-btn-ok" disabled style={{ flex: 2, opacity: 0.4 }}>
                  배정된 조직 없음
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── 실행 중 ── */}
        {view === 'running' && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 24, background: 'var(--bg-panel)' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>⚡ 미션 실행 중</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 20 }}>{current?.task}</div>

            <div ref={logRef} style={{ maxHeight: '60vh', overflowY: 'auto' }}>
              {steps.map((s, i) => (
                <div key={i} style={{
                  border: '1px solid var(--border)', borderRadius: 6, padding: '12px 16px',
                  marginBottom: 8, background: 'var(--bg-elevated)',
                  borderLeft: `3px solid ${s.status === 'done' ? 'var(--success)' : s.status === 'running' ? '#f59e0b' : s.status === 'failed' ? 'var(--danger)' : s.status === 'gate_pending' ? '#f59e0b' : 'var(--border)'}`,
                  transition: 'border-color .3s',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>{STEP_ICON[s.status] ?? '○'}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{s.org_name}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>({s.agent_name})</span>
                    <span style={{
                      marginLeft: 'auto', fontSize: 10, fontWeight: 600,
                      color: s.status === 'done' ? 'var(--success)' : s.status === 'running' ? '#f59e0b' : s.status === 'failed' ? 'var(--danger)' : s.status === 'gate_pending' ? '#f59e0b' : 'var(--text-muted)',
                    }}>
                      {s.status === 'running' ? '작업 중...' : s.status === 'done' ? '완료' : s.status === 'failed' ? '실패' : s.status === 'gate_pending' ? '승인 대기' : '대기'}
                    </span>
                  </div>
                  {/* Human Gate 승인 버튼 */}
                  {s.status === 'gate_pending' && s.job_id && current && (
                    <div style={{ marginTop: 10, padding: '10px 12px', background: '#f59e0b18', border: '1px solid #f59e0b44', borderRadius: 4 }}>
                      <div style={{ fontSize: 11, color: '#f59e0b', marginBottom: 8, fontWeight: 600 }}>
                        🔐 Human Gate — 이 작업은 실행 전 담당자 승인이 필요합니다
                      </div>
                      <button
                        onClick={() => approveJob(current.id, s.job_id!)}
                        style={{
                          fontSize: 11, fontWeight: 700, padding: '5px 16px', borderRadius: 4,
                          background: '#f59e0b', border: 'none', color: '#000', cursor: 'pointer', fontFamily: 'inherit',
                        }}
                      >✓ 승인하여 실행</button>
                    </div>
                  )}
                  {s.output && (
                    <div style={{ marginTop: 8, padding: '8px 10px', background: 'var(--bg-canvas)', borderRadius: 4, fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6, maxHeight: 100, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
                      {s.output.slice(0, 500)}{s.output.length > 500 ? '...' : ''}
                    </div>
                  )}
                  {s.error && (
                    <div style={{ marginTop: 8, padding: '8px 10px', background: 'var(--danger-dim)', borderRadius: 4, fontSize: 11, color: 'var(--danger)', lineHeight: 1.6 }}>
                      {s.error}
                    </div>
                  )}
                </div>
              ))}

              {steps.length > 0 && steps.every(s => s.status === 'done' || s.status === 'failed') && !finalDoc && (
                <div style={{ padding: '16px', textAlign: 'center', fontSize: 12, color: 'var(--accent)', fontWeight: 500 }}>
                  📝 최종 통합 문서 생성 중...
                </div>
              )}
            </div>

            {/* 협업 보드 실시간 패널 */}
            {boardContent && (
              <div style={{ marginTop: 20, border: '1px solid var(--accent)', borderRadius: 6, overflow: 'hidden' }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
                  background: 'var(--accent-dim)', borderBottom: '1px solid var(--accent)33',
                }}>
                  <span style={{ fontSize: 12 }}>🤝</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)' }}>협업 보드</span>
                  <span style={{ fontSize: 10, color: 'var(--accent)', opacity: 0.7, marginLeft: 4 }}>— 에이전트 간 실시간 소통</span>
                  <span style={{
                    marginLeft: 'auto', width: 7, height: 7, borderRadius: '50%',
                    background: 'var(--accent)', display: 'inline-block',
                  }} />
                </div>
                <div style={{
                  padding: '14px 16px', fontSize: 11, color: 'var(--text-secondary)',
                  lineHeight: 1.8, whiteSpace: 'pre-wrap', maxHeight: 280, overflowY: 'auto',
                  background: 'var(--bg-elevated)',
                }} dangerouslySetInnerHTML={{ __html: renderMd(boardContent) }} />
              </div>
            )}

            {err && (
              err.includes('확인 중') ? (
                <div style={{ marginTop: 16, padding: '12px 18px', background: 'var(--accent-dim)', borderRadius: 8, border: '1px solid var(--accent)33' }}>
                  <div style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 500 }}>{err}</div>
                </div>
              ) : (
                <div style={{ marginTop: 16, padding: '14px 18px', background: 'var(--danger-dim)', borderRadius: 8, border: '1px solid #f2482244' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 14 }}>⚠</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--danger)' }}>오류 발생</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--danger)', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{err}</div>
                </div>
              )
            )}
          </div>
        )}

        {/* ── 결과 뷰 ── */}
        {view === 'result' && (
          <div>
            {/* 실행 이력 + 품질 점수 */}
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 18, background: 'var(--bg-panel)', marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 10 }}>📊 실행 이력</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>{current?.task}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: missionJobs.some(j => j.quality_scores) ? 16 : 0 }}>
                {steps.map((s, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px',
                    borderRadius: 20, fontSize: 11, fontWeight: 500,
                    background: s.status === 'done' ? '#14ae5c18' : '#f2482218',
                    color: s.status === 'done' ? 'var(--success)' : 'var(--danger)',
                    border: `1px solid ${s.status === 'done' ? '#14ae5c33' : '#f2482233'}`,
                  }}>
                    {STEP_ICON[s.status]} {s.org_name}
                  </div>
                ))}
              </div>
              {/* 품질 점수 위젯 */}
              {missionJobs.some(j => j.quality_scores) && (
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 10 }}>
                    품질 점수
                  </div>
                  {missionJobs.filter(j => j.quality_scores).map(job => {
                    const scores: QualityScores = JSON.parse(job.quality_scores!);
                    const dims: { key: keyof QualityScores; label: string; color: string }[] = [
                      { key: 'quality',       label: '품질',   color: '#8b5cf6' },
                      { key: 'completeness',  label: '완성도', color: '#3b82f6' },
                      { key: 'accuracy',      label: '정확도', color: '#0891b2' },
                      { key: 'timeliness',    label: '신속성', color: '#059669' },
                      { key: 'collaboration', label: '협업',   color: '#d97706' },
                    ];
                    const avgColor = scores.average >= 80 ? 'var(--success)' : scores.average >= 65 ? '#f59e0b' : 'var(--danger)';
                    return (
                      <div key={job.id} style={{ marginBottom: 14 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }}>{job.agent_name}</span>
                          <span style={{
                            fontSize: 13, fontWeight: 800, color: avgColor,
                            background: avgColor + '18', padding: '2px 10px', borderRadius: 10, border: `1px solid ${avgColor}44`,
                          }}>{scores.average}점</span>
                        </div>
                        <div style={{ display: 'grid', gap: 4 }}>
                          {dims.map(d => (
                            <div key={d.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ fontSize: 10, color: 'var(--text-muted)', width: 40, textAlign: 'right' }}>{d.label}</span>
                              <div style={{ flex: 1, height: 6, background: 'var(--bg-canvas)', borderRadius: 3, overflow: 'hidden' }}>
                                <div style={{ width: `${scores[d.key]}%`, height: '100%', background: d.color, borderRadius: 3, transition: 'width .6s ease' }} />
                              </div>
                              <span style={{ fontSize: 10, color: 'var(--text-secondary)', width: 28, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                                {scores[d.key]}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 최종 문서 */}
            {finalDoc && (
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-panel)', overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', padding: '12px 18px', borderBottom: '1px solid var(--border)', background: 'var(--bg-elevated)' }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>📄 최종 보고서</span>
                  <button onClick={() => navigator.clipboard.writeText(finalDoc)} style={{
                    marginLeft: 'auto', fontSize: 11, fontWeight: 500, color: 'var(--text-muted)',
                    background: 'none', border: '1px solid var(--border)', padding: '3px 10px',
                    cursor: 'pointer', borderRadius: 4, fontFamily: 'inherit',
                  }}
                    onMouseOver={e => { e.currentTarget.style.color = 'var(--text-primary)'; e.currentTarget.style.borderColor = '#555'; }}
                    onMouseOut={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.borderColor = 'var(--border)'; }}
                  >📋 복사</button>
                </div>
                <div style={{
                  padding: '20px 24px', fontSize: 13, color: 'var(--text-secondary)',
                  lineHeight: 1.8, whiteSpace: 'pre-wrap', maxHeight: '70vh', overflowY: 'auto',
                }} dangerouslySetInnerHTML={{ __html: renderMd(finalDoc) }} />
              </div>
            )}

            {!finalDoc && (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)', fontSize: 12 }}>
                결과 문서가 없습니다
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 스타일 ──
const navLink: React.CSSProperties = {
  fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', textDecoration: 'none',
  padding: '4px 10px', border: '1px solid var(--border)', borderRadius: 4,
};

// ── 간이 마크다운 렌더 ──
function renderMd(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3 style="font-size:14px;font-weight:700;color:var(--text-primary);margin:16px 0 6px">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="font-size:15px;font-weight:700;color:var(--text-primary);margin:20px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--border)">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 style="font-size:18px;font-weight:700;color:var(--text-primary);margin:0 0 12px">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:var(--text-primary)">$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code style="background:var(--bg-canvas);padding:1px 5px;border-radius:3px;font-size:12px">$1</code>')
    .replace(/^- (.+)$/gm, '<div style="padding-left:12px;margin:3px 0">• $1</div>')
    .replace(/^---$/gm, '<hr style="border:none;border-top:1px solid var(--border);margin:16px 0">')
    .replace(/\n/g, '<br/>');
}
