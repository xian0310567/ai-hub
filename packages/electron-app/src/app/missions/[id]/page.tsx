'use client';
import React, { useEffect, useState, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';

interface Step {
  org_name: string;
  agent_name: string;
  status: 'queued' | 'waiting' | 'running' | 'done' | 'failed';
  queue_position?: number;
  output?: string;
  error?: string;
}

interface SSEEvent {
  type: 'start' | 'step' | 'consolidating' | 'done' | 'error';
  steps?: Step[];
  idx?: number;
  status?: Step['status'];
  org_name?: string;
  agent_name?: string;
  queue_position?: number;
  output?: string;
  error?: string;
  final_doc?: string;
}

export default function MissionRunPage() {
  const router = useRouter();
  const params = useParams();
  const missionId = params.id as string;

  const [missionTask, setMissionTask] = useState('');
  const [steps, setSteps] = useState<Step[]>([]);
  const [isConsolidating, setIsConsolidating] = useState(false);
  const [finalDoc, setFinalDoc] = useState('');
  const [error, setError] = useState('');
  const [isComplete, setIsComplete] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    // 미션 정보 로드
    fetch(`/api/missions/${missionId}`)
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.mission) {
          setMissionTask(d.mission.task);
        }
      })
      .catch(() => {});

    // SSE 연결
    const es = new EventSource(`/api/missions/${missionId}/run`, {
      withCredentials: true,
    });

    es.addEventListener('message', (e) => {
      try {
        const data: SSEEvent = JSON.parse(e.data);

        if (data.type === 'start' && data.steps) {
          setSteps(data.steps);
        } else if (data.type === 'step' && data.idx !== undefined) {
          setSteps(prev => {
            const next = [...prev];
            if (next[data.idx!]) {
              next[data.idx!] = {
                ...next[data.idx!],
                status: data.status!,
                queue_position: data.queue_position,
                output: data.output,
                error: data.error,
              };
            }
            return next;
          });
        } else if (data.type === 'consolidating') {
          setIsConsolidating(true);
        } else if (data.type === 'done' && data.final_doc) {
          setFinalDoc(data.final_doc);
          setIsConsolidating(false);
          setIsComplete(true);
          es.close();
        } else if (data.type === 'error' && data.error) {
          setError(data.error);
          setIsConsolidating(false);
          setIsComplete(true);
          es.close();
        }
      } catch (err) {
        console.error('SSE parse error:', err);
      }
    });

    es.onerror = () => {
      es.close();
    };

    eventSourceRef.current = es;

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, [missionId]);

  const getStatusColor = (status: Step['status']) => {
    switch (status) {
      case 'queued':
        return 'bg-gray-600 text-gray-200';
      case 'waiting':
        return 'bg-yellow-600 text-yellow-100';
      case 'running':
        return 'bg-blue-600 text-blue-100';
      case 'done':
        return 'bg-green-600 text-green-100';
      case 'failed':
        return 'bg-red-600 text-red-100';
      default:
        return 'bg-gray-600 text-gray-200';
    }
  };

  const getStatusIcon = (status: Step['status']) => {
    switch (status) {
      case 'queued':
        return '○';
      case 'waiting':
        return '⏳';
      case 'running':
        return '▶';
      case 'done':
        return '✓';
      case 'failed':
        return '✗';
      default:
        return '○';
    }
  };

  const totalSteps = steps.length;
  const completedSteps = steps.filter(s => s.status === 'done').length;
  const progressPercent = totalSteps > 0 ? (completedSteps / totalSteps) * 100 : 0;

  return (
    <div style={{ height: '100vh', background: 'var(--bg-canvas)', overflow: 'auto' }}>
      <nav>
        <div className="nav-title">미션 실행</div>
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
        <button className="nav-btn" onClick={() => router.push('/')}>
          대시보드로
        </button>
      </nav>

      <div style={{ marginTop: '54px', padding: '30px', maxWidth: '1200px', margin: '54px auto 0', color: 'var(--text-primary)' }}>
        {/* 미션 제목 */}
        <div style={{ marginBottom: '30px' }}>
          <h1 style={{ fontSize: '24px', fontWeight: '600', marginBottom: '15px' }}>
            {missionTask || '미션 로딩 중...'}
          </h1>

          {/* 전체 진행률 */}
          <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '8px', padding: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px', fontSize: '14px', color: 'var(--text-secondary)' }}>
              <span>전체 진행률</span>
              <span>{completedSteps} / {totalSteps} 완료</span>
            </div>
            <div style={{ width: '100%', height: '8px', background: 'var(--bg-canvas)', borderRadius: '4px', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${progressPercent}%`,
                  height: '100%',
                  background: 'var(--accent)',
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
          </div>
        </div>

        {/* 각 단계별 카드 */}
        <div style={{ display: 'grid', gap: '15px', marginBottom: '30px' }}>
          {steps.map((step, idx) => (
            <div
              key={idx}
              style={{
                background: 'var(--bg-panel)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                padding: '20px',
                transition: 'border-color 0.2s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                <span
                  className={getStatusColor(step.status)}
                  style={{
                    width: '32px',
                    height: '32px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: '50%',
                    fontSize: '16px',
                    fontWeight: '600',
                    flexShrink: 0,
                  }}
                >
                  {getStatusIcon(step.status)}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '16px', fontWeight: '600', color: 'var(--text-primary)' }}>
                    {step.org_name}
                  </div>
                  <div style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
                    {step.agent_name}
                  </div>
                </div>
                {step.status === 'waiting' && step.queue_position !== undefined && step.queue_position > 0 && (
                  <div style={{ fontSize: '13px', color: 'var(--text-muted)', background: 'var(--bg-elevated)', padding: '4px 10px', borderRadius: '4px' }}>
                    대기 순서: {step.queue_position}
                  </div>
                )}
              </div>

              {/* 완료 시 결과물 */}
              {step.status === 'done' && step.output && (
                <div style={{ marginTop: '12px', padding: '15px', background: 'var(--bg-elevated)', borderRadius: '6px', fontSize: '14px', lineHeight: '1.6', color: 'var(--text-secondary)', maxHeight: '300px', overflow: 'auto' }}>
                  <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {step.output}
                  </div>
                </div>
              )}

              {/* 실패 시 에러 메시지 */}
              {step.status === 'failed' && step.error && (
                <div style={{ marginTop: '12px', padding: '15px', background: 'var(--danger-dim)', border: '1px solid var(--danger)', borderRadius: '6px', fontSize: '14px', color: 'var(--danger)' }}>
                  오류: {step.error}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* 통합 문서 생성 중 */}
        {isConsolidating && (
          <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '8px', padding: '30px', textAlign: 'center' }}>
            <div className="spinner" style={{ margin: '0 auto 20px' }} />
            <div style={{ fontSize: '16px', color: 'var(--text-primary)' }}>
              최종 통합 문서 생성 중...
            </div>
          </div>
        )}

        {/* 최종 문서 */}
        {isComplete && finalDoc && (
          <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '8px', padding: '30px' }}>
            <h2 style={{ fontSize: '20px', fontWeight: '600', marginBottom: '20px', color: 'var(--text-primary)', borderBottom: '1px solid var(--border)', paddingBottom: '15px' }}>
              최종 통합 문서
            </h2>
            <div style={{ fontSize: '15px', lineHeight: '1.8', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {finalDoc}
            </div>
          </div>
        )}

        {/* 에러 */}
        {isComplete && error && (
          <div style={{ background: 'var(--danger-dim)', border: '1px solid var(--danger)', borderRadius: '8px', padding: '30px' }}>
            <h2 style={{ fontSize: '20px', fontWeight: '600', marginBottom: '15px', color: 'var(--danger)' }}>
              오류 발생
            </h2>
            <div style={{ fontSize: '15px', color: 'var(--danger)' }}>
              {error}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
