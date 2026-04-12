'use client';
import React, { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { drawSprite } from '@/lib/sprites';
import OpenClawStatus from '@/components/OpenClawStatus';
import SessionHistory from '@/components/SessionHistory';

// ── Types ───────────────────────────────────────────────────────────
interface Agent { id:string; name:string; emoji:string; color:string; command_name:string|null; is_lead:number; org_level:string; harness_pattern:string; model:string; soul:string; }
interface Part   { id:string; name:string; color:string; team_id:string; lead:Agent|null; workers:Agent[]; }
interface Team   { id:string; name:string; color:string; workspace_id:string; lead:Agent|null; workers:Agent[]; parts:Part[]; }
interface Dept   { id:string; name:string; path:string; lead:Agent|null; teams:Team[]; }
interface Div    { id:string; name:string; color:string; lead:Agent|null; departments:Dept[]; }
interface MissionItem {
  id: string;
  task: string;
  phase: 'routing'|'clarify'|'confirm'|'running'|'done'|'error';
  data: any;
  clarify: any;
  steps: any[];
  doc: string;
  err: string;
  progress?: {
    total: number;
    completed: number;
    percentage: number;
  };
}

export default function Dashboard() {
  const router    = useRouter();
  const stageRef  = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const stateRef  = useRef({ sc:1, tx:0, ty:0, drag:false, lx:0, ly:0, spaceDown:false });

  const [divs,       setDivs]       = useState<Div[]>([]);
  const [standalone, setStandalone] = useState<Dept[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<Agent|null>(null);
  const [authStatus, setAuthStatus] = useState<{loggedIn:boolean}|null>(null);
  const [loginModal, setLoginModal] = useState(false);
  const [sessionHistoryOpen, setSessionHistoryOpen] = useState(false);

  // 미션 상태 (다중 미션 지원)
  const [missions, setMissions] = useState<MissionItem[]>([]);
  const [missionInput, setMissionInput] = useState('');
  const [missionImages, setMissionImages] = useState<string[]>([]);
  const [activeMissionId, setActiveMissionId] = useState<string|null>(null);
  const [missionResultOpen, setMissionResultOpen] = useState(false);
  const [routingReportId, setRoutingReportId] = useState<string|null>(null);
  const missionLogRef = useRef<HTMLDivElement>(null);
  const pollRefs = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const runningPollRefs = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({});
  const toggleStep = useCallback((missionId: string, idx: number) => {
    const key = `${missionId}-${idx}`;
    setExpandedSteps(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

  // 알림 상태
  const [notifs,        setNotifs]        = useState<any[]>([]);
  const [notifUnread,   setNotifUnread]   = useState(0);
  const [notifOpen,     setNotifOpen]     = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(() => {
    fetch('/api/divisions').then(r=>r.json()).then(d=>{
      if (d.ok) { setDivs(d.divisions); setStandalone(d.standalone); }
    });
  }, []);

  const reloadNotifs = useCallback(() => {
    fetch('/api/notifications').then(r=>r.json()).then(d=>{
      if (d.ok) { setNotifs(d.notifications); setNotifUnread(d.unread); }
    }).catch(()=>{});
  }, []);

  const loadMissions = useCallback((resumePoll: (id: string) => void, resumeRunningPoll: (id: string) => void) => {
    fetch('/api/missions').then(r=>r.json()).then(d=>{
      if (!d.ok) return;
      const loaded: MissionItem[] = d.missions.map((m: any) => {
        let stepsData: any = null;
        try { stepsData = m.steps ? JSON.parse(m.steps) : null; } catch {}
        const routingArr = m.routing ? (typeof m.routing === 'string' ? JSON.parse(m.routing) : m.routing) : null;
        const metaObj = Array.isArray(stepsData) ? {} : (stepsData || {});
        const execSteps: any[] = Array.isArray(stepsData) ? stepsData : [];

        let phase: MissionItem['phase'] = 'routing';
        if      (m.status === 'done')               phase = 'done';
        else if (m.status === 'failed')             phase = 'error';
        else if (m.status === 'running')            phase = 'running';
        else if (m.status === 'routed')             phase = 'confirm';
        else if (m.status === 'needs_clarification') phase = 'clarify';
        else if (m.status === 'routing_failed')     phase = 'error';
        else if (m.status === 'analyzing')          phase = 'routing';

        return {
          id: m.id, task: m.task, phase,
          data: routingArr?.length ? { id: m.id, task: m.task, summary: metaObj.summary, routing: routingArr } : null,
          clarify: phase === 'clarify' ? metaObj.clarification : null,
          steps: execSteps,
          doc: m.final_doc || '',
          err: (phase === 'error') ? (m.status === 'routing_failed' ? '라우팅 분석 실패' : '실행 실패') : '',
        } as MissionItem;
      });
      setMissions(loaded);
      // analyzing 상태인 미션은 폴링 재개
      loaded.filter(m => m.phase === 'routing').forEach(m => resumePoll(m.id));
      // running 상태인 미션은 진행 상황 폴링 재개
      loaded.filter(m => m.phase === 'running').forEach(m => resumeRunningPoll(m.id));
    }).catch(()=>{});
  }, []);

  useEffect(() => {
    fetch('/api/auth/me').then(r => {
      if (!r.ok) router.replace('/login');
    }).catch(() => router.replace('/login'));
    reload();
    reloadNotifs();
    // Claude 인증: sessionStorage 캐시 (5분)
    const cached = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('claude-auth') : null;
    if (cached) {
      try {
        const { loggedIn, ts } = JSON.parse(cached);
        if (Date.now() - ts < 5 * 60 * 1000) { setAuthStatus({ loggedIn }); return; }
      } catch {}
    }
    fetch('/api/auth').then(r=>r.json()).then(d=>{
      setAuthStatus({loggedIn:d.loggedIn});
      try { sessionStorage.setItem('claude-auth', JSON.stringify({loggedIn:d.loggedIn,ts:Date.now()})); } catch {}
    }).catch(()=>{});
  }, [reload, router]);

  // 스프라이트
  useEffect(() => {
    const t = setTimeout(()=>{ document.querySelectorAll<HTMLCanvasElement>('canvas[data-sp]').forEach(cv=>drawSprite(cv)); }, 50);
    return () => clearTimeout(t);
  }, [divs, standalone]);

  // ── Pan/Zoom ──
  const applyT = useCallback(() => {
    const {sc,tx,ty}=stateRef.current;
    if(canvasRef.current) canvasRef.current.style.transform=`translate(${tx}px,${ty}px) scale(${sc})`;
  }, []);

  useEffect(() => {
    const stage=stageRef.current; if(!stage) return;
    const st=stateRef.current;
    const onWheel=(e:WheelEvent)=>{
      e.preventDefault();
      if(e.ctrlKey||e.metaKey){ const f=e.deltaY<0?1.1:0.9; const r=stage.getBoundingClientRect(); const c=Math.max(0.3,Math.min(2.5,st.sc*f)); st.tx=e.clientX-r.left-(e.clientX-r.left-st.tx)*(c/st.sc); st.ty=e.clientY-r.top-(e.clientY-r.top-st.ty)*(c/st.sc); st.sc=c; }
      else{ st.tx-=e.deltaX; st.ty-=e.deltaY; }
      applyT();
    };
    const onDown=(e:MouseEvent)=>{ if(e.button===1||e.button===0&&st.spaceDown){e.preventDefault();st.drag=true;st.lx=e.clientX;st.ly=e.clientY;} };
    const onMove=(e:MouseEvent)=>{ if(!st.drag)return; st.tx+=e.clientX-st.lx; st.ty+=e.clientY-st.ly; st.lx=e.clientX; st.ly=e.clientY; applyT(); };
    const onUp=()=>{ st.drag=false; };
    const isTyping=()=>{ const el=document.activeElement; if(!el) return false; const tag=el.tagName; return tag==='INPUT'||tag==='TEXTAREA'||(el as HTMLElement).isContentEditable; };
    const onKey=(e:KeyboardEvent)=>{ if(e.code==='Space'&&!e.ctrlKey&&!isTyping()){e.preventDefault();st.spaceDown=true;stage.style.cursor='grab';} };
    const onKeyUp=(e:KeyboardEvent)=>{ if(e.code==='Space'){st.spaceDown=false;stage.style.cursor='default';} };
    stage.addEventListener('wheel',onWheel,{passive:false});
    stage.addEventListener('mousedown',onDown);
    window.addEventListener('mousemove',onMove);
    window.addEventListener('mouseup',onUp);
    window.addEventListener('keydown',onKey);
    window.addEventListener('keyup',onKeyUp);
    return ()=>{ stage.removeEventListener('wheel',onWheel); stage.removeEventListener('mousedown',onDown); window.removeEventListener('mousemove',onMove); window.removeEventListener('mouseup',onUp); window.removeEventListener('keydown',onKey); window.removeEventListener('keyup',onKeyUp); };
  }, [applyT]);

  // ── 미션 로직 (다중 미션 + 비동기 큐 + 폴링) ──
  const updateMission = useCallback((id: string, patch: Partial<MissionItem>) => {
    setMissions(prev => prev.map(m => m.id === id ? { ...m, ...patch } : m));
  }, []);

  const stopPolling = useCallback((missionId: string) => {
    if (pollRefs.current[missionId]) {
      clearInterval(pollRefs.current[missionId]);
      delete pollRefs.current[missionId];
    }
  }, []);

  const stopRunningPolling = useCallback((missionId: string) => {
    if (runningPollRefs.current[missionId]) {
      clearInterval(runningPollRefs.current[missionId]);
      delete runningPollRefs.current[missionId];
    }
  }, []);

  const startRunningPolling = useCallback((missionId: string) => {
    stopRunningPolling(missionId);
    runningPollRefs.current[missionId] = setInterval(async () => {
      try {
        const r = await fetch(`/api/missions/${missionId}/status`);
        const d = await r.json();
        if (!d.ok) return;

        // steps와 progress 업데이트
        updateMission(missionId, {
          steps: d.steps || [],
          progress: d.progress,
        });

        // 미션 완료/실패 시 폴링 중단
        if (d.mission?.status === 'done') {
          stopRunningPolling(missionId);
          updateMission(missionId, { phase: 'done' });
        } else if (d.mission?.status === 'failed') {
          stopRunningPolling(missionId);
          updateMission(missionId, { phase: 'error', err: '실행 실패' });
        }
      } catch {}
    }, 2000);
  }, [stopRunningPolling, updateMission]);

  const startPolling = useCallback((missionId: string) => {
    stopPolling(missionId);
    pollRefs.current[missionId] = setInterval(async () => {
      try {
        const r = await fetch(`/api/missions/${missionId}`);
        const d = await r.json();
        if (!d.ok) return;
        const m = d.mission;
        const meta = m.steps ? (typeof m.steps === 'string' ? JSON.parse(m.steps) : m.steps) : {};

        if (m.status === 'routed') {
          stopPolling(missionId);
          updateMission(missionId, {
            phase: 'confirm', clarify: null,
            data: { id: m.id, task: m.task, summary: meta.summary, routing: m.routing },
          });
          if (meta.new_org_needed?.length > 0) reloadNotifs();
        } else if (m.status === 'needs_clarification') {
          stopPolling(missionId);
          updateMission(missionId, {
            phase: 'clarify',
            clarify: meta.clarification,
            data: { id: m.id, task: m.task, summary: meta.summary, routing: m.routing },
          });
          if (meta.new_org_needed?.length > 0) reloadNotifs();
        } else if (m.status === 'routing_failed') {
          stopPolling(missionId);
          updateMission(missionId, { phase: 'error', err: '라우팅 분석에 실패했습니다' });
        }
      } catch {}
    }, 2000);
  }, [stopPolling, reloadNotifs, updateMission]);

  // cleanup all polls
  useEffect(() => () => {
    Object.keys(pollRefs.current).forEach(id => clearInterval(pollRefs.current[id]));
    Object.keys(runningPollRefs.current).forEach(id => clearInterval(runningPollRefs.current[id]));
  }, []);

  // 초기 미션 히스토리 로드 (startPolling이 정의된 이후)
  useEffect(() => { loadMissions(startPolling, startRunningPolling); }, [loadMissions, startPolling, startRunningPolling]);

  const submitMission = useCallback(async () => {
    if (!missionInput.trim()) return;
    const task = missionInput.trim();
    const images = missionImages.slice();
    setMissionInput('');
    setMissionImages([]);
    try {
      const r = await fetch('/api/missions', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ task, images }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error);
      const newMission: MissionItem = {
        id: d.mission.id, task, phase: 'routing',
        data: d.mission, clarify: null, steps: [], doc: '', err: '',
      };
      setMissions(prev => [newMission, ...prev]);
      setActiveMissionId(d.mission.id);
      startPolling(d.mission.id);
    } catch (e: any) {
      // 임시 ID로 에러 미션 추가
      const errId = `err-${Date.now()}`;
      setMissions(prev => [{ id: errId, task, phase: 'error', data: null, clarify: null, steps: [], doc: '', err: e.message }, ...prev]);
    }
  }, [missionInput, missionImages, startPolling]);

  const removeMission = useCallback((missionId: string) => {
    stopPolling(missionId);
    setMissions(prev => prev.filter(m => m.id !== missionId));
    setActiveMissionId(prev => prev === missionId ? null : prev);
    setMissionResultOpen(false);
    // err- 접두사는 DB에 저장되지 않은 임시 에러 미션
    if (!missionId.startsWith('err-')) {
      fetch(`/api/missions?id=${missionId}`, { method: 'DELETE' }).catch(() => {});
    }
  }, [stopPolling]);

  // 이미지 처리 유틸리티
  const addImage = useCallback((file: File) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const maxSize = 5 * 1024 * 1024; // 5MB

    if (!allowedTypes.includes(file.type)) {
      alert(`허용되지 않는 이미지 형식입니다. (jpeg, png, gif, webp만 가능)`);
      return;
    }
    if (file.size > maxSize) {
      alert(`이미지 크기는 5MB를 초과할 수 없습니다. (현재: ${(file.size / 1024 / 1024).toFixed(1)}MB)`);
      return;
    }
    if (missionImages.length >= 5) {
      alert('최대 5개까지 이미지를 첨부할 수 있습니다.');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const base64 = e.target?.result as string;
      setMissionImages(prev => [...prev, base64]);
    };
    reader.readAsDataURL(file);
  }, [missionImages.length]);

  const removeImage = useCallback((index: number) => {
    setMissionImages(prev => prev.filter((_, i) => i !== index));
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) addImage(file);
        break;
      }
    }
  }, [addImage]);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer.files);
    files.forEach(file => {
      if (file.type.startsWith('image/')) {
        addImage(file);
      }
    });
  }, [addImage]);

  const pickClarifyOption = useCallback(async (missionId: string, option: any) => {
    if (option.extra_routing === null) {
      removeMission(missionId);
      return;
    }
    if (option.extra_routing && option.extra_routing.length > 0) {
      const r = await fetch('/api/missions', {
        method: 'PATCH', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ id: missionId, extra_routing: option.extra_routing }),
      });
      const d = await r.json();
      if (d.ok) {
        setMissions(prev => prev.map(m => m.id === missionId ? {
          ...m, phase: 'confirm' as const, clarify: null,
          data: { ...m.data, routing: d.routing },
        } : m));
      }
    } else {
      updateMission(missionId, { phase: 'confirm', clarify: null });
    }
  }, [updateMission, removeMission]);

  const runMission = useCallback(async (missionId: string) => {
    // Use functional update to get latest mission data
    let missionData: any = null;
    setMissions(prev => {
      const m = prev.find(m => m.id === missionId);
      if (m?.data) missionData = m.data;
      return prev;
    });
    if (!missionData) return;

    updateMission(missionId, {
      phase: 'running',
      steps: missionData.routing.map((r: any) => ({ org_name: r.org_name, agent_name: r.agent_name, status: 'pending' })),
      doc: '', err: '',
    });

    // 진행 상황 폴링 시작
    startRunningPolling(missionId);
    try {
      const resp = await fetch(`/api/missions/${missionId}/run`, { method: 'POST' });
      if (!resp.ok) {
        stopRunningPolling(missionId);
        const errData = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        updateMission(missionId, { phase: 'error', err: errData.error || `실행 요청 실패 (${resp.status})` });
        return;
      }
      const reader = resp.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === 'start') {
              updateMission(missionId, { steps: ev.steps });
            } else if (ev.type === 'step') {
              setMissions(prev => prev.map(m => m.id === missionId ? {
                ...m, steps: m.steps.map((s: any, i: number) => i === ev.idx ? { ...s, status: ev.status, output: ev.output, error: ev.error } : s)
              } : m));
            } else if (ev.type === 'done') {
              stopRunningPolling(missionId);
              updateMission(missionId, { phase: 'done', doc: ev.final_doc });
            } else if (ev.type === 'error') {
              stopRunningPolling(missionId);
              updateMission(missionId, { phase: 'error', err: ev.error });
            }
          } catch {}
        }
      }
    } catch (e: any) {
      stopRunningPolling(missionId);
      updateMission(missionId, { err: e.message, phase: 'error' });
    }
  }, [updateMission, startRunningPolling, stopRunningPolling]);

  const activeMission = missions.find(m => m.id === activeMissionId) || null;

  // 현재 실행 중인 에이전트 ID 집합 (오피스 맵 시각화용)
  const runningAgentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of missions) {
      if (m.phase === 'running' && m.data?.routing) {
        (m.data.routing as any[]).forEach((r: any, i: number) => {
          if (m.steps[i]?.status === 'running') ids.add(r.agent_id);
        });
      }
    }
    return ids;
  }, [missions]);

  useEffect(() => {
    if (missionLogRef.current) missionLogRef.current.scrollTop = missionLogRef.current.scrollHeight;
  }, [activeMission?.steps, activeMission?.doc]);

  // 알림 팝오버 외부 클릭 닫기
  useEffect(() => {
    if (!notifOpen) return;
    const handler = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [notifOpen]);

  const isEmpty = divs.length === 0 && standalone.length === 0;

  return (
    <>
      <nav suppressHydrationWarning>
        <div className="nav-title">AI 사업부</div>
        <a href="/missions" style={{fontSize:12,fontWeight:500,color:'var(--text-secondary)',textDecoration:'none',padding:'4px 10px',border:'1px solid var(--border)',borderRadius:4,transition:'all .12s'}} onMouseOver={e=>{e.currentTarget.style.color='var(--text-primary)';e.currentTarget.style.borderColor='#555';}} onMouseOut={e=>{e.currentTarget.style.color='var(--text-secondary)';e.currentTarget.style.borderColor='var(--border)';}}>미션</a>
        <a href="/schedules" style={{fontSize:12,fontWeight:500,color:'var(--text-secondary)',textDecoration:'none',padding:'4px 10px',border:'1px solid var(--border)',borderRadius:4,transition:'all .12s'}} onMouseOver={e=>{e.currentTarget.style.color='var(--text-primary)';e.currentTarget.style.borderColor='#555';}} onMouseOut={e=>{e.currentTarget.style.color='var(--text-secondary)';e.currentTarget.style.borderColor='var(--border)';}}>스케줄</a>
        <a href="/tasks" style={{fontSize:12,fontWeight:500,color:'var(--text-secondary)',textDecoration:'none',padding:'4px 10px',border:'1px solid var(--border)',borderRadius:4,transition:'all .12s'}} onMouseOver={e=>{e.currentTarget.style.color='var(--text-primary)';e.currentTarget.style.borderColor='#555';}} onMouseOut={e=>{e.currentTarget.style.color='var(--text-secondary)';e.currentTarget.style.borderColor='var(--border)';}}>태스크</a>
        <a href="/org" style={{fontSize:12,fontWeight:500,color:'var(--text-secondary)',textDecoration:'none',padding:'4px 10px',border:'1px solid var(--border)',borderRadius:4,transition:'all .12s'}} onMouseOver={e=>{e.currentTarget.style.color='var(--text-primary)';e.currentTarget.style.borderColor='#555';}} onMouseOut={e=>{e.currentTarget.style.color='var(--text-secondary)';e.currentTarget.style.borderColor='var(--border)';}}>조직 관리</a>
        <a href="/vault" style={{fontSize:12,fontWeight:500,color:'var(--text-secondary)',textDecoration:'none',padding:'4px 10px',border:'1px solid var(--border)',borderRadius:4,transition:'all .12s'}} onMouseOver={e=>{e.currentTarget.style.color='var(--text-primary)';e.currentTarget.style.borderColor='#555';}} onMouseOut={e=>{e.currentTarget.style.color='var(--text-secondary)';e.currentTarget.style.borderColor='var(--border)';}}>🔐 Vault</a>
        <a href="/settings" style={{fontSize:12,fontWeight:500,color:'var(--text-secondary)',textDecoration:'none',padding:'4px 10px',border:'1px solid var(--border)',borderRadius:4,transition:'all .12s'}} onMouseOver={e=>{e.currentTarget.style.color='var(--text-primary)';e.currentTarget.style.borderColor='#555';}} onMouseOut={e=>{e.currentTarget.style.color='var(--text-secondary)';e.currentTarget.style.borderColor='var(--border)';}}>⚙️ 설정</a>

        <button onClick={()=>setSessionHistoryOpen(true)} style={{fontSize:12,fontWeight:500,color:'var(--text-secondary)',textDecoration:'none',padding:'4px 10px',border:'1px solid var(--border)',borderRadius:4,transition:'all .12s',background:'none',cursor:'pointer',fontFamily:'inherit'}} onMouseOver={e=>{e.currentTarget.style.color='var(--text-primary)';e.currentTarget.style.borderColor='#555';}} onMouseOut={e=>{e.currentTarget.style.color='var(--text-secondary)';e.currentTarget.style.borderColor='var(--border)';}}>히스토리</button>

        {/* 🔔 알림 벨 */}
        <div ref={notifRef} style={{position:'relative'}} suppressHydrationWarning>
          <button onClick={()=>setNotifOpen(v=>!v)} style={{position:'relative',background:'none',border:'1px solid var(--border)',borderRadius:4,color:'var(--text-secondary)',fontSize:14,padding:'4px 10px',cursor:'pointer',lineHeight:1,transition:'all .12s'}}
            onMouseOver={e=>{e.currentTarget.style.borderColor='#555';e.currentTarget.style.color='var(--text-primary)';}} onMouseOut={e=>{e.currentTarget.style.borderColor='var(--border)';e.currentTarget.style.color='var(--text-secondary)';}}>
            🔔
            {notifUnread > 0 && <span style={{position:'absolute',top:-5,right:-5,background:'var(--danger)',color:'#fff',fontSize:9,fontWeight:700,borderRadius:'50%',width:15,height:15,display:'flex',alignItems:'center',justifyContent:'center',lineHeight:1}}>{notifUnread > 9 ? '9+' : notifUnread}</span>}
          </button>
          {notifOpen && (
            <div style={{position:'fixed',top:48,right:12,width:340,maxHeight:480,background:'var(--bg-panel)',border:'1px solid var(--border)',borderRadius:8,boxShadow:'0 12px 40px rgba(0,0,0,.5)',zIndex:8000,display:'flex',flexDirection:'column',overflow:'hidden'}}>
              <div style={{display:'flex',alignItems:'center',padding:'12px 16px',borderBottom:'1px solid var(--border)'}}>
                <span style={{fontSize:13,fontWeight:700,color:'var(--text-primary)'}}>🔔 알림 / 할 일</span>
                {notifUnread > 0 && <button onClick={()=>{fetch('/api/notifications',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({all:true})}).then(()=>reloadNotifs());}} style={{marginLeft:'auto',fontSize:10,background:'none',border:'none',color:'var(--accent)',cursor:'pointer',padding:0}}>모두 읽음</button>}
              </div>
              <div style={{overflowY:'auto',flex:1}}>
                {notifs.length === 0 && <div style={{padding:'24px 16px',textAlign:'center',fontSize:12,color:'var(--text-muted)'}}>알림이 없습니다</div>}
                {notifs.map(n=>(
                  <div key={n.id} style={{padding:'10px 16px',borderBottom:'1px solid var(--border)',background:n.read?'transparent':'var(--accent-dim)',display:'flex',gap:10,alignItems:'flex-start',cursor:'pointer'}}
                    onClick={()=>{fetch('/api/notifications',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:n.id})}).then(()=>reloadNotifs());}}>
                    <span style={{fontSize:16,flexShrink:0,marginTop:2}}>{n.type==='org_needed'?'🏗️':'ℹ️'}</span>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:12,fontWeight:600,color:'var(--text-primary)',marginBottom:2}}>{n.title}</div>
                      <div style={{fontSize:11,color:'var(--text-secondary)',lineHeight:1.5}}>{n.message}</div>
                      {n.type==='org_needed' && <a href="/org" onClick={()=>setNotifOpen(false)} style={{display:'inline-block',marginTop:6,fontSize:10,color:'var(--accent)',textDecoration:'none',border:'1px solid var(--accent-dim)',padding:'2px 8px',borderRadius:3}}>조직 관리로 이동 →</a>}
                    </div>
                    <button onClick={e=>{e.stopPropagation();fetch(`/api/notifications?id=${n.id}`,{method:'DELETE'}).then(()=>reloadNotifs());}} style={{background:'none',border:'none',color:'var(--text-muted)',cursor:'pointer',fontSize:12,flexShrink:0,padding:'0 2px'}}
                      onMouseOver={e=>e.currentTarget.style.color='var(--danger)'} onMouseOut={e=>e.currentTarget.style.color='var(--text-muted)'}>✕</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

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
            cursor: 'pointer'
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

        <div suppressHydrationWarning style={{fontSize:12,fontWeight:500,padding:'4px 11px',border:'1px solid',borderRadius:4,
          borderColor:authStatus?.loggedIn?'#14ae5c44':'var(--danger-dim)',
          background:authStatus?.loggedIn?'#14ae5c11':'var(--danger-dim)',
          color:authStatus?.loggedIn?'var(--success)':'var(--danger)',cursor:authStatus?.loggedIn?'default':'pointer'}}
          onClick={()=>{ if(!authStatus?.loggedIn) setLoginModal(true); }}>
          {authStatus==null?'...' : authStatus.loggedIn ? '● Claude 연결됨' : '● 미연결'}
        </div>
      </nav>

      {/* ── 미션 좌측 패널 ── */}
      <div id="mission-panel">
        <div className="mission-header">
          <span style={{fontSize:16}}>🎯</span>
          <span className="mission-title">미션 센터</span>
          {missions.filter(m=>m.phase==='running'||m.phase==='routing').length > 0 && (
            <span className="mission-count-badge">{missions.filter(m=>m.phase==='running'||m.phase==='routing').length}개 진행중</span>
          )}
        </div>
        <div className="mission-list">
          {missions.length === 0 && (
            <div className="mission-empty">
              <div className="mission-empty-icon">🚀</div>
              <div className="mission-empty-title">미션을 시작하세요</div>
              <div className="mission-empty-desc">아래에 미션을 입력하면<br/>AI 에이전트들이 병렬로 처리합니다</div>
            </div>
          )}
          {missions.map(m => (
            <div
              key={m.id}
              className={`mission-card${activeMissionId===m.id?' active':''}`}
              onClick={()=>setActiveMissionId(activeMissionId===m.id?null:m.id)}
            >
              <div className="mc-task">{m.task}</div>
              <div className="mc-status">
                {m.phase==='routing' && <span className="mc-status-pill routing"><span className="pulse-dot" style={{background:'#f59e0b'}} />분석 중</span>}
                {m.phase==='clarify' && <span className="mc-status-pill clarify"><span className="pulse-dot" style={{background:'var(--accent)'}} />확인 필요</span>}
                {m.phase==='confirm' && <span className="mc-status-pill confirm">● 실행 대기</span>}
                {m.phase==='running' && <span className="mc-status-pill running"><span className="pulse-dot" style={{background:'var(--success)'}} />실행 중 {m.steps.filter((s:any)=>s.status==='done').length}/{m.steps.length}</span>}
                {m.phase==='done' && <span className="mc-status-pill done">✓ 완료</span>}
                {m.phase==='error' && <span className="mc-status-pill error">✕ 오류</span>}
                <button className="mc-delete-btn" onClick={e=>{e.stopPropagation();removeMission(m.id);}}>✕</button>
              </div>

              {/* 진행률 바 (running 상태 미션만) */}
              {m.phase==='running' && m.progress && (
                <div onClick={e=>e.stopPropagation()}>
                  <div className="mission-progress-track">
                    <div className="mission-progress-fill" style={{width: `${m.progress.percentage}%`}} />
                  </div>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:6,fontSize:10,color:'var(--text-muted)'}}>
                    <span>{m.progress.completed}/{m.progress.total} 완료</span>
                    {(() => {
                      const runningStep = m.steps.find((s:any) => s.status === 'running');
                      const waitingCount = m.steps.filter((s:any) => s.status === 'waiting' || s.status === 'queued').length;
                      return (
                        <div style={{display:'flex',alignItems:'center',gap:6}}>
                          {runningStep && (
                            <span style={{color:'var(--accent)',fontWeight:600,fontSize:10}}>
                              ▶ {runningStep.agent_name}
                            </span>
                          )}
                          {waitingCount > 0 && (
                            <span style={{color:'var(--text-muted)',fontSize:10}}>
                              · 대기 {waitingCount}
                            </span>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              )}

              {/* 확장된 미션 상세 (활성 미션만) */}
              {activeMissionId===m.id && (
                <div className="mission-detail" onClick={e=>e.stopPropagation()}>
                  {m.phase==='routing' && (
                    <div style={{display:'flex',alignItems:'center',gap:8,padding:'8px 12px',background:'#f59e0b0a',border:'1px solid #f59e0b22',borderRadius:8}}>
                      <span className="pulse-dot" style={{background:'#f59e0b'}} />
                      <span style={{fontSize:12,color:'#f59e0b',fontWeight:500}}>조직도를 분석하고 업무를 배정하는 중...</span>
                    </div>
                  )}

                  {m.phase==='clarify' && m.clarify && (
                    <div>
                      <div style={{display:'flex',alignItems:'flex-start',gap:10,marginBottom:10,padding:'10px 12px',background:'var(--accent-dim)',borderRadius:8,border:'1px solid #0d99ff22'}}>
                        <span style={{fontSize:16,flexShrink:0}}>🤔</span>
                        <div style={{flex:1}}>
                          <div style={{fontSize:12,fontWeight:700,color:'var(--text-primary)',marginBottom:4}}>확인이 필요합니다</div>
                          <div style={{fontSize:11,color:'var(--text-secondary)',lineHeight:1.6}}>{m.clarify.gap}</div>
                        </div>
                      </div>
                      <div style={{display:'flex',flexDirection:'column',gap:5}}>
                        {m.clarify.options?.map((opt: any) => (
                          <button key={opt.id} onClick={()=>pickClarifyOption(m.id, opt)}
                            style={{textAlign:'left',padding:'10px 12px',background:'var(--bg-canvas)',border:'1px solid var(--border)',borderRadius:8,cursor:'pointer',transition:'all .15s',fontFamily:'inherit'}}
                            onMouseOver={e=>{e.currentTarget.style.borderColor='var(--accent)';e.currentTarget.style.background='var(--bg-hover)';}}
                            onMouseOut={e=>{e.currentTarget.style.borderColor='var(--border)';e.currentTarget.style.background='var(--bg-canvas)';}}>
                            <div style={{fontSize:12,fontWeight:600,color:'var(--text-primary)',marginBottom:3}}>{opt.label}</div>
                            <div style={{fontSize:11,color:'var(--text-secondary)',lineHeight:1.5}}>{opt.description}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {m.phase==='confirm' && m.data && (
                    <div>
                      {m.data.summary && (
                        <div style={{fontSize:11,color:'var(--text-secondary)',lineHeight:1.6,marginBottom:10,padding:'8px 12px',background:'var(--bg-canvas)',borderRadius:8,borderLeft:'3px solid var(--accent)'}}>
                          {m.data.summary}
                        </div>
                      )}
                      <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:10}}>
                        <span style={{fontSize:11,color:'var(--text-secondary)',fontWeight:500}}>{m.data.routing?.length}개 조직 배정됨</span>
                        <button onClick={()=>setRoutingReportId(m.id)} className="mission-action-btn secondary" style={{marginLeft:'auto',fontSize:10,borderColor:'var(--accent)',color:'var(--accent)'}}>📋 보고서</button>
                      </div>
                      <div style={{display:'flex',gap:6}}>
                        <button onClick={()=>removeMission(m.id)} className="mission-action-btn secondary" style={{flex:1}}>취소</button>
                        <button onClick={()=>runMission(m.id)} className="mission-action-btn primary" style={{flex:2}}>▶ 미션 실행</button>
                      </div>
                    </div>
                  )}

                  {(m.phase==='running'||m.phase==='done') && m.steps.length > 0 && (
                    <div ref={m.phase==='running'?missionLogRef:undefined}>
                      <div style={{display:'flex',flexDirection:'column',gap:4}}>
                        {m.steps.map((s: any, i: number) => {
                          const stepKey = `${m.id}-${i}`;
                          const isExpanded = !!expandedSteps[stepKey];
                          const hasOutput = !!(s.output || s.error);
                          return (
                            <div key={i} className="mission-step-card" style={{
                              borderLeftColor:s.status==='done'?'var(--success)':s.status==='running'?'#f59e0b':s.status==='failed'?'var(--danger)':'var(--border)',borderLeftWidth:2}}>
                              <div
                                className="mission-step-header"
                                style={{cursor:hasOutput?'pointer':'default'}}
                                onClick={()=>hasOutput&&toggleStep(m.id,i)}
                              >
                                <div className="agent-indicator">
                                  {s.status==='queued' && <div className="agent-indicator-queued" />}
                                  {s.status==='waiting' && <div className="agent-indicator-waiting" />}
                                  {s.status==='running' && <div className="agent-indicator-running" />}
                                  {s.status==='done' && <span className="agent-indicator-done">✓</span>}
                                  {s.status==='failed' && <span className="agent-indicator-failed">✕</span>}
                                  {!s.status && <div className="agent-indicator-queued" />}
                                </div>
                                <span style={{fontWeight:500,color:'var(--text-primary)',flex:1,fontSize:11}}>{s.org_name}</span>
                                <span style={{color:'var(--text-muted)',fontSize:10}}>{s.status==='running'?'작업 중':s.status==='done'?'완료':s.status==='failed'?'실패':s.status==='waiting'?`대기 ${s.queue_position??''}번째`:'대기'}</span>
                                {hasOutput && <span style={{color:'var(--text-muted)',fontSize:10,marginLeft:4,transition:'transform .2s',display:'inline-block',transform:isExpanded?'rotate(180deg)':'none'}}>▼</span>}
                              </div>
                              {isExpanded && hasOutput && (
                                <div className="mission-step-output">
                                  {s.error ? <span style={{color:'var(--danger)'}}>{s.error}</span> : s.output}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      {m.err && <div style={{fontSize:11,color:'var(--danger)',marginTop:8,padding:'6px 10px',background:'var(--danger-dim)',borderRadius:6}}>{m.err}</div>}
                    </div>
                  )}

                  {m.phase==='done' && (
                    <div style={{display:'flex',gap:6,marginTop: m.steps.length>0?8:0}}>
                      <button onClick={()=>{setActiveMissionId(m.id);setMissionResultOpen(true);}} className="mission-action-btn accent" style={{flex:1}}>📄 결과 보기</button>
                      <button onClick={()=>navigator.clipboard.writeText(m.doc)} className="mission-action-btn secondary" style={{padding:'7px 10px'}}>📋</button>
                      <button onClick={()=>removeMission(m.id)} className="mission-action-btn secondary" style={{padding:'7px 10px'}}>✕</button>
                    </div>
                  )}

                  {m.phase==='error' && (
                    <div>
                      <div style={{fontSize:11,color:'var(--danger)',marginBottom:8,padding:'8px 10px',background:'var(--danger-dim)',borderRadius:6,border:'1px solid #f2482222'}}>{m.err}</div>
                      <button onClick={()=>removeMission(m.id)} className="mission-action-btn secondary">닫기</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="mission-input-area">
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            <textarea
              className="mission-textarea"
              value={missionInput} onChange={e=>setMissionInput(e.target.value)}
              onKeyDown={e=>e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing&&(e.preventDefault(),submitMission())}
              onPaste={handlePaste}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              placeholder="미션을 입력하세요... (Shift+Enter 줄바꿈)"
              rows={2}
              ref={el=>{ if(el){ el.style.height='auto'; el.style.height=Math.min(el.scrollHeight,120)+'px'; } }}
              onInput={e=>{ const el=e.currentTarget; el.style.height='auto'; el.style.height=Math.min(el.scrollHeight,120)+'px'; }}
            />
            {missionImages.length > 0 && (
              <div style={{display:'flex',flexDirection:'column',gap:6}}>
                <span style={{fontSize:10,color:'var(--text-muted)',fontWeight:500}}>{missionImages.length}/5 이미지 첨부됨</span>
                <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                  {missionImages.map((img, idx) => (
                    <div key={idx} style={{position:'relative',width:52,height:52,borderRadius:8,overflow:'hidden',border:'1px solid var(--border)',transition:'border-color .12s'}}
                      onMouseOver={e=>e.currentTarget.style.borderColor='var(--accent)'}
                      onMouseOut={e=>e.currentTarget.style.borderColor='var(--border)'}>
                      <img src={img} alt={`첨부 이미지 ${idx + 1}`} style={{width:'100%',height:'100%',objectFit:'cover'}} />
                      <button
                        onClick={() => removeImage(idx)}
                        aria-label={`이미지 ${idx + 1} 삭제`}
                        style={{position:'absolute',top:2,right:2,width:16,height:16,borderRadius:'50%',background:'rgba(0,0,0,0.7)',border:'none',color:'#fff',fontSize:10,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',lineHeight:1,padding:0,transition:'background .12s'}}
                        onMouseOver={e=>e.currentTarget.style.background='var(--danger)'}
                        onMouseOut={e=>e.currentTarget.style.background='rgba(0,0,0,0.7)'}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <button onClick={submitMission} disabled={!missionInput.trim()} className="mission-submit-btn">
              미션 전송
            </button>
          </div>
        </div>
      </div>

      {/* ── 오피스 맵 ── */}
      <div id="stage" ref={stageRef} style={selectedAgent ? {right:340} : undefined}>
        <div id="canvas" ref={canvasRef}>
          {isEmpty ? (
            <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',height:400,gap:12,color:'var(--text-muted)',userSelect:'none'}}>
              <div style={{fontSize:48,opacity:0.3}}>🏢</div>
              <div style={{fontSize:13,fontWeight:600,color:'var(--text-secondary)'}}>사무실이 비어있습니다</div>
              <div style={{fontSize:11}}>조직 관리에서 부문 또는 실을 추가하세요</div>
            </div>
          ) : (
            <div style={{display:'flex',flexDirection:'column',gap:32}}>

              {/* 부문 룸들 */}
              {divs.map(div => (
                <DivisionRoom key={div.id} div={div} onSelect={setSelectedAgent} runningAgentIds={runningAgentIds} />
              ))}

              {/* 독립 실들 */}
              {standalone.length > 0 && (
                <div style={{display:'flex',flexDirection:'column',gap:4}}>
                  <div style={{fontSize:9,fontWeight:700,color:'var(--text-muted)',letterSpacing:'0.12em',textTransform:'uppercase',paddingLeft:4,marginBottom:8}}>
                    ─ 독립 실 ─
                  </div>
                  <div style={{display:'flex',gap:20,flexWrap:'wrap',alignItems:'flex-start'}}>
                    {standalone.map(d => <DeptRoom key={d.id} dept={d} onSelect={setSelectedAgent} runningAgentIds={runningAgentIds} />)}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── 에이전트 상세 패널 ── */}
      {selectedAgent && (
        <div id="chat-panel">
          <div className="chat-panel-hdr">
            <div>
              <div style={{fontSize:15,fontWeight:700,letterSpacing:'-0.01em'}}>{selectedAgent.emoji} {selectedAgent.name}</div>
              <div style={{fontSize:11,color:'var(--text-muted)',marginTop:2}}>{agentLevelLabel(selectedAgent.org_level, selectedAgent.is_lead)}</div>
            </div>
            <button onClick={()=>setSelectedAgent(null)} style={{marginLeft:'auto',background:'none',border:'none',color:'var(--text-muted)',cursor:'pointer',fontSize:16,padding:'0 4px',lineHeight:1}} onMouseOver={e=>e.currentTarget.style.color='var(--text-primary)'} onMouseOut={e=>e.currentTarget.style.color='var(--text-muted)'}>✕</button>
          </div>
          <div style={{padding:'16px',display:'flex',flexDirection:'column',gap:14,overflowY:'auto',flex:1}}>
            <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
              <span style={{fontSize:10,fontWeight:600,padding:'3px 9px',borderRadius:10,background:'var(--bg-canvas)',border:'1px solid var(--border)',color:'var(--text-secondary)',letterSpacing:'0.04em'}}>
                {patternLabel(selectedAgent.harness_pattern)}
              </span>
              <span style={{fontSize:10,fontWeight:600,padding:'3px 9px',borderRadius:10,background:'var(--accent-dim)',border:'1px solid var(--accent)',color:'var(--accent)',letterSpacing:'0.04em'}}>
                {selectedAgent.model || 'claude-sonnet-4-5'}
              </span>
            </div>
            {selectedAgent.soul ? (
              <div>
                <div style={{fontSize:10,fontWeight:700,color:'var(--text-muted)',marginBottom:8,letterSpacing:'0.08em',textTransform:'uppercase'}}>Soul</div>
                <div style={{fontSize:11,color:'var(--text-secondary)',lineHeight:1.75,whiteSpace:'pre-wrap',background:'var(--bg-canvas)',border:'1px solid var(--border)',borderRadius:5,padding:'12px 14px',overflowY:'auto',maxHeight:460}}>
                  {selectedAgent.soul}
                </div>
              </div>
            ) : (
              <div style={{fontSize:11,color:'var(--text-muted)',textAlign:'center',padding:'24px 0'}}>
                소울이 없습니다. 조직 관리에서 하네스를 설정하세요.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── 라우팅 보고서 모달 ── */}
      {routingReportId && (() => {
        const rm = missions.find(m => m.id === routingReportId);
        if (!rm?.data) return null;
        return (
          <RoutingReportModal
            mission={rm}
            onClose={()=>setRoutingReportId(null)}
            onRun={()=>{setRoutingReportId(null);runMission(rm.id);}}
          />
        );
      })()}

      {/* ── 미션 결과 오버레이 ── */}
      {missionResultOpen && activeMission?.doc && (
        <div className="modal-backdrop" onClick={()=>setMissionResultOpen(false)}>
          <div className="modal" style={{width:700,maxWidth:'90vw',maxHeight:'80vh',display:'flex',flexDirection:'column'}} onClick={e=>e.stopPropagation()}>
            <div className="modal-title" style={{display:'flex',alignItems:'center',gap:8}}>
              <span>📄 미션 결과</span>
              <div style={{marginLeft:'auto',display:'flex',gap:8}}>
                <button onClick={()=>navigator.clipboard.writeText(activeMission.doc)} style={{fontSize:11,background:'none',border:'1px solid var(--border)',color:'var(--text-muted)',padding:'4px 12px',borderRadius:4,cursor:'pointer',fontFamily:'inherit'}} onMouseOver={e=>e.currentTarget.style.color='var(--text-primary)'} onMouseOut={e=>e.currentTarget.style.color='var(--text-muted)'}>📋 복사</button>
                <button onClick={()=>setMissionResultOpen(false)} style={{background:'none',border:'none',color:'var(--text-muted)',cursor:'pointer',fontSize:16,padding:'0 2px',lineHeight:1}} onMouseOver={e=>e.currentTarget.style.color='var(--text-primary)'} onMouseOut={e=>e.currentTarget.style.color='var(--text-muted)'}>✕</button>
              </div>
            </div>
            <div style={{overflowY:'auto',flex:1,padding:'16px 20px',fontSize:12,lineHeight:1.7}} dangerouslySetInnerHTML={{__html:renderMd(activeMission.doc)}} />
          </div>
        </div>
      )}


      {/* ── 세션 히스토리 ── */}
      {sessionHistoryOpen && <SessionHistory onClose={()=>setSessionHistoryOpen(false)} />}

      {/* ── OpenClaw 상태 위젯 ── */}
      <OpenClawStatus />

      {loginModal && <LoginModal onClose={()=>setLoginModal(false)} onDone={()=>{setLoginModal(false);fetch('/api/auth').then(r=>r.json()).then(d=>setAuthStatus({loggedIn:d.loggedIn}));}} />}
    </>
  );
}

// ── 라우팅 보고서 모달 컴포넌트 ──────────────────────────────────────
function RoutingReportModal({ mission, onClose, onRun }: { mission: MissionItem; onClose: ()=>void; onRun: ()=>void }) {
  const [expandedCards, setExpandedCards] = useState<Set<number>>(new Set());
  const orgColor = (type: string) => type==='division'?'#7c3aed':type==='department'?'#4f46e5':'#0891b2';
  const toggleCard = (i: number) => setExpandedCards(prev => {
    const next = new Set(prev); next.has(i) ? next.delete(i) : next.add(i); return next;
  });
  const routing = mission.data?.routing ?? [];
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div style={{background:'var(--bg-panel)',border:'1px solid var(--border)',borderRadius:10,width:'min(980px,95vw)',maxHeight:'88vh',display:'flex',flexDirection:'column',boxShadow:'0 24px 80px rgba(0,0,0,.7)',overflow:'hidden'}} onClick={e=>e.stopPropagation()}>
        {/* 헤더 */}
        <div style={{padding:'20px 24px 16px',borderBottom:'1px solid var(--border)',flexShrink:0}}>
          <div style={{display:'flex',alignItems:'flex-start',gap:12}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:11,fontWeight:700,color:'var(--text-muted)',letterSpacing:'0.08em',textTransform:'uppercase',marginBottom:6}}>미션 라우팅 보고서</div>
              <div style={{fontSize:14,fontWeight:700,color:'var(--text-primary)',lineHeight:1.5,marginBottom:8}}>{mission.task}</div>
              {mission.data?.summary && (
                <div style={{fontSize:12,color:'var(--text-secondary)',lineHeight:1.6,padding:'8px 12px',background:'var(--bg-elevated)',borderRadius:5,borderLeft:'3px solid var(--accent)'}}>
                  {mission.data.summary}
                </div>
              )}
            </div>
            <button onClick={onClose} style={{background:'none',border:'none',color:'var(--text-muted)',cursor:'pointer',fontSize:18,padding:'0 4px',flexShrink:0,lineHeight:1}} onMouseOver={e=>e.currentTarget.style.color='var(--text-primary)'} onMouseOut={e=>e.currentTarget.style.color='var(--text-muted)'}>✕</button>
          </div>
          <div style={{display:'flex',gap:16,marginTop:14}}>
            <div style={{fontSize:11,color:'var(--text-muted)'}}><span style={{fontWeight:600,color:'var(--text-secondary)'}}>참여 조직</span> {routing.length}개</div>
            <div style={{fontSize:11,color:'var(--text-muted)'}}><span style={{fontWeight:600,color:'var(--text-secondary)'}}>실행 방식</span> 병렬 처리</div>
          </div>
        </div>
        {/* 조직별 계획 */}
        <div style={{overflowY:'auto',flex:1,padding:'20px 24px'}}>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit, minmax(min(100%, 420px), 1fr))',gap:12}}>
            {routing.map((r: any, i: number) => {
              const isExpanded = expandedCards.has(i);
              return (
                <div key={i} style={{border:'1px solid var(--border)',borderRadius:7,overflow:'hidden',borderTop:`3px solid ${orgColor(r.org_type)}`}}>
                  <div onClick={()=>toggleCard(i)} style={{padding:'10px 14px',background:'var(--bg-elevated)',display:'flex',alignItems:'flex-start',gap:8,cursor:'pointer'}}
                    onMouseOver={e=>e.currentTarget.style.background='var(--bg-hover)'} onMouseOut={e=>e.currentTarget.style.background='var(--bg-elevated)'}>
                    <div style={{width:7,height:7,borderRadius:'50%',background:orgColor(r.org_type),flexShrink:0,marginTop:4}} />
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:12,fontWeight:700,color:'var(--text-primary)',marginBottom:2}}>{r.org_name}</div>
                      <div style={{fontSize:10,color:'var(--text-muted)',marginBottom:4}}>담당: {r.agent_name} · {r.org_type==='division'?'부문':r.org_type==='department'?'실':'팀'}</div>
                      <div style={{fontSize:11,color:'var(--text-secondary)',lineHeight:1.5,overflow:'hidden',display:'-webkit-box',WebkitLineClamp:isExpanded?'unset':2,WebkitBoxOrient:'vertical'}}>{r.subtask}</div>
                    </div>
                    <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:4,flexShrink:0}}>
                      <div style={{fontSize:9,fontWeight:700,padding:'2px 7px',borderRadius:10,background:orgColor(r.org_type)+'22',color:orgColor(r.org_type),border:`1px solid ${orgColor(r.org_type)}44`}}>{i+1}/{routing.length}</div>
                      <div style={{fontSize:11,color:'var(--text-muted)',transition:'transform 0.2s',transform:isExpanded?'rotate(180deg)':'none'}}>▼</div>
                    </div>
                  </div>
                  {isExpanded && (
                    <div style={{padding:'12px 14px',display:'flex',flexDirection:'column',gap:10,borderTop:'1px solid var(--border)',background:'var(--bg-panel)'}}>
                      {r.approach && (
                        <div>
                          <div style={{fontSize:9,fontWeight:700,color:'var(--text-muted)',letterSpacing:'0.07em',textTransform:'uppercase',marginBottom:4}}>수행 방식</div>
                          <div style={{fontSize:11,color:'var(--text-secondary)',lineHeight:1.6}}>{r.approach}</div>
                        </div>
                      )}
                      {r.deliverables?.length > 0 && (
                        <div>
                          <div style={{fontSize:9,fontWeight:700,color:'var(--text-muted)',letterSpacing:'0.07em',textTransform:'uppercase',marginBottom:4}}>산출물</div>
                          <div style={{display:'flex',flexDirection:'column',gap:3}}>
                            {r.deliverables.map((d: string, j: number) => (
                              <div key={j} style={{display:'flex',alignItems:'flex-start',gap:5,fontSize:11,color:'var(--text-secondary)',lineHeight:1.5}}>
                                <span style={{color:orgColor(r.org_type),flexShrink:0,marginTop:1}}>▸</span><span>{d}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {/* 푸터 */}
        <div style={{padding:'14px 24px',borderTop:'1px solid var(--border)',display:'flex',gap:8,flexShrink:0,background:'var(--bg-elevated)'}}>
          <button onClick={onClose} style={{flex:1,fontSize:12,fontWeight:500,color:'var(--text-secondary)',background:'none',border:'1px solid var(--border)',padding:'9px',borderRadius:5,cursor:'pointer',fontFamily:'inherit'}}>닫기</button>
          <button onClick={onRun} style={{flex:2,fontSize:12,fontWeight:700,color:'#fff',background:'var(--success)',border:'none',padding:'9px',borderRadius:5,cursor:'pointer',fontFamily:'inherit'}}>▶ 미션 실행</button>
        </div>
      </div>
    </div>
  );
}

// ── 헬퍼 ────────────────────────────────────────────────────────────
function agentLevelLabel(level: string, is_lead: number): string {
  if (level === 'division')   return '부문장';
  if (level === 'department') return '실장';
  if (level === 'team')       return is_lead ? '팀장' : '팀원';
  if (level === 'part')       return is_lead ? '파트장' : '팀원';
  return '팀원';
}
function patternLabel(p: string): string {
  const map: Record<string,string> = {
    orchestrator:'오케스트레이터',pipeline:'파이프라인',
    'scatter-gather':'스캐터/게더','worker-pool':'워커 풀',
    'check-fix':'체크/픽스',single:'단독',
  };
  return map[p] || p;
}

type SelectAgent = (a: Agent) => void;

// ─────────────────────────────────────────────────────────────────────
// GATHER-TOWN STYLE OFFICE — 2D top-down pixel-art office
// ─────────────────────────────────────────────────────────────────────
const WALL = 8;
const WALL_CLR = '#6a6a72';
const FLOOR_CLR = '#484850';
const FLOOR_LOUNGE = '#5a5a88';
const DESK_CLR = '#c89060';
const DESK_BORDER = '#a07050';
const CHAIR_CLR = '#7a4a2a';
const CHAIR_BORDER = '#5a3a1a';
const CHAIR_LOUNGE = '#d09030';
const TABLE_ROUND = '#404050';

/** 사무실 창문 (벽 위에 그려짐) */
function OfficeWindow() {
  return <div style={{width:48,height:14,background:'linear-gradient(180deg,#a0c8e0 0%,#80b0d0 50%,#b8d8e8 100%)',border:`2px solid ${WALL_CLR}`,borderRadius:1,boxShadow:'inset 0 0 4px rgba(255,255,255,0.2)'}} />;
}

/** 책장 (벽 장식) */
function Bookshelf() {
  const c = ['#d04040','#4080c0','#40a050','#c08030','#7050a0','#c06040','#40b0b0','#b0b040'];
  return (
    <div style={{width:56,height:24,background:'#4a2a1a',border:'2px solid #3a1a0a',borderRadius:1,display:'grid',gridTemplateColumns:'repeat(8,1fr)',gridTemplateRows:'repeat(3,1fr)',gap:1,padding:2,overflow:'hidden'}}>
      {Array.from({length:24},(_,i)=><div key={i} style={{background:c[i%8],opacity:i%5===0?0.3:1}} />)}
    </div>
  );
}

/** 화분 */
function OfficePlant({ size='md' }: {size?:'sm'|'md'|'lg'}) {
  const s = size==='lg'?28:size==='md'?20:14;
  return (
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',userSelect:'none',pointerEvents:'none'}}>
      <div style={{width:s,height:s*0.8,background:'radial-gradient(ellipse,#3a9a4a 20%,#2a7a3a 80%)',borderRadius:'40% 40% 20% 20%'}} />
      <div style={{width:s*0.35,height:s*0.3,background:'#8a6040',borderRadius:'0 0 2px 2px',marginTop:-1}} />
    </div>
  );
}

/** 의자 (방향별) */
function Chair({ facing='down' }: {facing?:'up'|'down'}) {
  return <div style={{
    width:20,height:14,
    background:`linear-gradient(${facing==='down'?'180deg':'0deg'},${CHAIR_CLR} 0%,#6a3a1a 100%)`,
    border:`1px solid ${CHAIR_BORDER}`,
    borderRadius:facing==='down'?'2px 2px 4px 4px':'4px 4px 2px 2px',
    boxShadow:'0 1px 2px rgba(0,0,0,0.3)',
  }} />;
}

/** 라운지 의자 */
function LoungeChair() {
  return <div style={{width:16,height:16,background:CHAIR_LOUNGE,borderRadius:3,border:'1px solid #b07020',boxShadow:'0 1px 2px rgba(0,0,0,0.2)'}} />;
}

/** 라운드 테이블 + 의자 4개 */
function RoundTable() {
  return (
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:3}}>
      <div style={{display:'flex',gap:8}}><LoungeChair /><LoungeChair /></div>
      <div style={{width:40,height:40,background:TABLE_ROUND,borderRadius:'50%',border:'2px solid #505060',boxShadow:'0 2px 6px rgba(0,0,0,0.3)'}} />
      <div style={{display:'flex',gap:8}}><LoungeChair /><LoungeChair /></div>
    </div>
  );
}

/** 에이전트 좌석 (작은 스프라이트 + 이름표) */
function AgentSeat({ a, onSelect, isRunning }: { a: Agent; onSelect: SelectAgent; isRunning?: boolean }) {
  const isLead = a.is_lead === 1;
  const glowColor = a.color || '#0d99ff';
  const wrap = (
    <div className="agent-desk" onClick={() => onSelect(a)}
      title={`${a.name} — ${agentLevelLabel(a.org_level, a.is_lead)}${isRunning ? ' (작업 중)' : ''}`}
      style={{width:46,display:'flex',flexDirection:'column',alignItems:'center',gap:0}}
    >
      {isRunning && <div className="agent-working-badge" style={{background:glowColor}} />}
      {/* 이름표 */}
      <div style={{
        fontSize:7,fontWeight:isLead?700:500,
        color:isRunning?glowColor:'#bbb',
        background:'rgba(0,0,0,0.75)',padding:'1px 5px',borderRadius:2,
        marginBottom:1,maxWidth:50,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',
        textShadow:isRunning?`0 0 4px ${glowColor}`:'none',
        border:isLead?`1px solid ${a.color}55`:'1px solid transparent',
      }}>
        {isLead && <span style={{color:a.color}}>● </span>}{a.name}
      </div>
      {/* 스프라이트 */}
      <canvas data-sp={isLead?'opus':'sonnet'} data-tie={a.color} data-sc="2"
        style={{width:20,height:36,imageRendering:'pixelated'}} />
      {/* 작업중 */}
      {isRunning && <div style={{display:'flex',gap:1,marginTop:1}}>
        <span className="agent-typing-dot" style={{color:glowColor}} />
        <span className="agent-typing-dot" style={{color:glowColor}} />
        <span className="agent-typing-dot" style={{color:glowColor}} />
      </div>}
    </div>
  );
  if (!isRunning) return wrap;
  return <div className="agent-desk-running-wrap" style={{['--glow-color' as any]:glowColor,padding:4,margin:-4}}>{wrap}</div>;
}

/** 팀 데스크 클러스터 — 큰 테이블 양쪽에 의자+에이전트 */
function DeskCluster({ team, onSelect, runningAgentIds }: {
  team: Team; onSelect: SelectAgent; runningAgentIds: Set<string>;
}) {
  const all: Agent[] = [];
  if (team.lead) all.push(team.lead);
  all.push(...team.workers);
  for (const p of team.parts) { if (p.lead) all.push(p.lead); all.push(...p.workers); }
  if (all.length === 0) return null;

  const half = Math.ceil(all.length / 2);
  const topRow = all.slice(0, half);
  const bottomRow = all.slice(half);
  const cols = Math.max(topRow.length, bottomRow.length, 2);
  const deskW = cols * 52;
  const hasRunning = all.some(a => runningAgentIds.has(a.id));

  return (
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:2}}>
      {/* 팀명 */}
      <div style={{
        fontSize:8,fontWeight:700,color:team.color,
        background:'rgba(0,0,0,0.6)',padding:'2px 10px',borderRadius:3,
        border:`1px solid ${team.color}55`,marginBottom:2,
        boxShadow:hasRunning?`0 0 8px ${team.color}44`:'none',
      }}>{team.name}{hasRunning?' ⚡':''}</div>
      {/* 윗줄 에이전트 */}
      <div style={{display:'flex',gap:2,justifyContent:'center'}}>
        {topRow.map(a => <AgentSeat key={a.id} a={a} onSelect={onSelect} isRunning={runningAgentIds.has(a.id)} />)}
      </div>
      {/* 윗줄 의자 */}
      <div style={{display:'flex',gap:28,justifyContent:'center'}}>
        {topRow.map((_,i) => <Chair key={i} facing="down" />)}
      </div>
      {/* 큰 테이블 */}
      <div style={{
        width:deskW,height:36,
        background:`linear-gradient(180deg,${DESK_CLR} 0%,#b08050 100%)`,
        border:`2px solid ${DESK_BORDER}`,borderRadius:2,
        display:'flex',alignItems:'center',justifyContent:'center',gap:8,padding:'0 8px',
        boxShadow:'0 2px 8px rgba(0,0,0,0.4)',
      }}>
        {all.map(a => <div key={a.id} style={{
          width:14,height:10,
          background:runningAgentIds.has(a.id)?'#2a4a6a':'#1a1a2a',
          border:`1px solid ${a.color}${runningAgentIds.has(a.id)?'aa':'55'}`,
          borderRadius:1,
          boxShadow:runningAgentIds.has(a.id)?`0 0 6px ${a.color}55`:'none',
        }} />)}
      </div>
      {/* 아랫줄 의자 */}
      {bottomRow.length > 0 && <div style={{display:'flex',gap:28,justifyContent:'center'}}>
        {bottomRow.map((_,i) => <Chair key={i} facing="up" />)}
      </div>}
      {/* 아랫줄 에이전트 */}
      {bottomRow.length > 0 && <div style={{display:'flex',gap:2,justifyContent:'center'}}>
        {bottomRow.map(a => <AgentSeat key={a.id} a={a} onSelect={onSelect} isRunning={runningAgentIds.has(a.id)} />)}
      </div>}
    </div>
  );
}

/** 실(Department) 방 — 두꺼운 벽 + 창문 + 바닥타일 */
function DeptRoom({ dept, onSelect, runningAgentIds }: { dept: Dept; onSelect: SelectAgent; runningAgentIds: Set<string> }) {
  const winCount = Math.min(dept.teams.length + 1, 3);
  return (
    <div style={{
      position:'relative',
      border:`${WALL}px solid ${WALL_CLR}`,
      borderRadius:3,background:FLOOR_CLR,
      backgroundImage:`
        repeating-linear-gradient(0deg,transparent,transparent 31px,rgba(0,0,0,0.08) 31px,rgba(0,0,0,0.08) 32px),
        repeating-linear-gradient(90deg,transparent,transparent 31px,rgba(0,0,0,0.08) 31px,rgba(0,0,0,0.08) 32px)`,
      padding:'40px 20px 20px',minWidth:220,
      boxShadow:'inset 0 0 40px rgba(0,0,0,0.3), 0 4px 16px rgba(0,0,0,0.3)',
    }}>
      {/* 방 이름 */}
      <div style={{position:'absolute',top:WALL+2,left:WALL+8,fontSize:9,fontWeight:700,color:'#ccc',background:'rgba(0,0,0,0.5)',padding:'2px 10px',borderRadius:2,letterSpacing:'0.06em'}}>
        🏢 {dept.name}
      </div>
      {/* 창문들 (상단 벽) */}
      <div style={{position:'absolute',top:-2,left:0,right:0,display:'flex',gap:16,justifyContent:'center'}}>
        {Array.from({length:winCount},(_,i) => <OfficeWindow key={i} />)}
      </div>
      {/* 문 (하단 벽 중앙) */}
      <div style={{position:'absolute',bottom:-WALL,left:'50%',transform:'translateX(-50%)',width:28,height:WALL,background:'#8a8a92',borderRadius:'0 0 2px 2px'}} />

      {/* 실장 코너오피스 */}
      {dept.lead && (
        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:16,padding:'8px 12px',background:'rgba(255,255,255,0.03)',borderLeft:`3px solid ${dept.lead.color||'#666'}66`,borderRadius:3}}>
          <AgentSeat a={dept.lead} onSelect={onSelect} isRunning={runningAgentIds.has(dept.lead.id)} />
          <div style={{display:'flex',flexDirection:'column',gap:6,alignItems:'center'}}>
            {/* 실장 책상 */}
            <div style={{width:44,height:24,background:`linear-gradient(180deg,${DESK_CLR} 0%,#a07040 100%)`,border:`1px solid ${DESK_BORDER}`,borderRadius:1,display:'flex',alignItems:'center',justifyContent:'center'}}>
              <div style={{width:14,height:10,background:dept.lead&&runningAgentIds.has(dept.lead.id)?'#2a4a6a':'#1a1a2a',border:`1px solid ${dept.lead.color}66`,borderRadius:1}} />
            </div>
            <OfficePlant size="sm" />
          </div>
        </div>
      )}

      {/* 팀 데스크들 */}
      <div style={{display:'flex',gap:24,flexWrap:'wrap',justifyContent:'center',alignItems:'flex-start'}}>
        {dept.teams.map(t => <DeskCluster key={t.id} team={t} onSelect={onSelect} runningAgentIds={runningAgentIds} />)}
        {dept.teams.length === 0 && !dept.lead && (
          <div style={{fontSize:9,color:'var(--text-muted)',padding:'12px 8px',fontStyle:'italic'}}>팀 없음</div>
        )}
      </div>

      {/* 코너 화분 */}
      <div style={{position:'absolute',bottom:WALL+4,right:WALL+4}}><OfficePlant size="sm" /></div>
      {dept.teams.length > 1 && <div style={{position:'absolute',bottom:WALL+4,left:WALL+4}}><OfficePlant size="sm" /></div>}
    </div>
  );
}

/** 부문(Division) — 오피스 빌딩 한 층 전체 */
function DivisionRoom({ div, onSelect, runningAgentIds }: { div: Div; onSelect: SelectAgent; runningAgentIds: Set<string> }) {
  const leadRunning = !!(div.lead && runningAgentIds.has(div.lead.id));
  const loungeTableCount = Math.min(div.departments.length + 1, 4);

  return (
    <div style={{
      position:'relative',
      border:`${WALL+2}px solid ${div.color}55`,borderRadius:6,
      padding:'52px 24px 24px',
      background:`${div.color}04`,
      backgroundImage:`
        repeating-linear-gradient(0deg,transparent,transparent 63px,${div.color}08 63px,${div.color}08 64px),
        repeating-linear-gradient(90deg,transparent,transparent 63px,${div.color}08 63px,${div.color}08 64px)`,
      boxShadow:`0 0 0 1px ${div.color}22, inset 0 0 80px rgba(0,0,0,0.2)`,
    }}>
      {/* 부문 간판 */}
      <div style={{
        position:'absolute',top:-7,left:20,
        fontSize:12,fontWeight:800,color:'#fff',
        background:`linear-gradient(135deg,${div.color} 0%,${div.color}cc 100%)`,
        padding:'5px 18px',borderRadius:5,
        boxShadow:`0 3px 16px ${div.color}55`,
        whiteSpace:'nowrap',letterSpacing:'0.06em',
      }}>◉ {div.name}</div>

      <div style={{display:'flex',gap:24,flexWrap:'wrap',alignItems:'flex-start'}}>
        {/* 부문장 오피스 */}
        {div.lead && (
          <div style={{
            position:'relative',
            border:`${WALL}px solid ${WALL_CLR}`,borderRadius:3,
            background:FLOOR_CLR,
            backgroundImage:'repeating-linear-gradient(0deg,transparent,transparent 31px,rgba(0,0,0,0.08) 31px,rgba(0,0,0,0.08) 32px),repeating-linear-gradient(90deg,transparent,transparent 31px,rgba(0,0,0,0.08) 31px,rgba(0,0,0,0.08) 32px)',
            padding:'30px 16px 16px',
            boxShadow:'inset 0 0 30px rgba(0,0,0,0.3)',
          }}>
            <div style={{position:'absolute',top:WALL+2,left:WALL+4,fontSize:7,fontWeight:800,color:div.color,background:'rgba(0,0,0,0.5)',padding:'1px 6px',borderRadius:2,letterSpacing:'0.1em'}}>
              DIRECTOR
            </div>
            {/* 디렉터실 창문 */}
            <div style={{position:'absolute',top:-2,left:WALL+16}}><OfficeWindow /></div>
            <div style={{display:'flex',alignItems:'center',gap:10}}>
              <AgentSeat a={div.lead} onSelect={onSelect} isRunning={leadRunning} />
              <div style={{display:'flex',flexDirection:'column',gap:6,alignItems:'center'}}>
                <div style={{width:44,height:24,background:`linear-gradient(180deg,${DESK_CLR} 0%,#a07040 100%)`,border:`1px solid ${DESK_BORDER}`,borderRadius:1,display:'flex',alignItems:'center',justifyContent:'center'}}>
                  <div style={{width:14,height:10,background:leadRunning?'#2a4a6a':'#1a1a2a',border:`1px solid ${div.color}66`,borderRadius:1,boxShadow:leadRunning?`0 0 4px ${div.color}44`:'none'}} />
                </div>
                <div style={{display:'flex',gap:6}}><OfficePlant size="sm" /><span style={{fontSize:10,opacity:0.5,userSelect:'none'}}>🏆</span></div>
              </div>
            </div>
            {/* 문 */}
            <div style={{position:'absolute',bottom:-WALL,right:16,width:24,height:WALL,background:'#8a8a92',borderRadius:'0 0 2px 2px'}} />
          </div>
        )}

        {/* 실 방들 */}
        {div.departments.map(d => <DeptRoom key={d.id} dept={d} onSelect={onSelect} runningAgentIds={runningAgentIds} />)}

        {div.departments.length === 0 && !div.lead && (
          <div style={{fontSize:10,color:'var(--text-muted)',padding:'24px',fontStyle:'italic'}}>
            실이 없습니다 · 조직 관리에서 추가하세요
          </div>
        )}
      </div>

      {/* ── 라운지 공간 ── */}
      {div.departments.length > 0 && (
        <div style={{
          marginTop:20,
          border:`${WALL}px solid ${WALL_CLR}`,borderRadius:3,
          background:FLOOR_LOUNGE,
          backgroundImage:'repeating-linear-gradient(0deg,transparent,transparent 31px,rgba(0,0,0,0.06) 31px,rgba(0,0,0,0.06) 32px),repeating-linear-gradient(90deg,transparent,transparent 31px,rgba(0,0,0,0.06) 31px,rgba(0,0,0,0.06) 32px)',
          padding:'32px 24px 20px',
          display:'flex',gap:28,alignItems:'center',flexWrap:'wrap',
          boxShadow:'inset 0 0 40px rgba(0,0,0,0.2)',position:'relative',
        }}>
          {/* 라운지 간판 */}
          <div style={{position:'absolute',top:WALL+2,right:WALL+8,fontSize:9,fontWeight:700,color:'#aaa',background:'rgba(0,0,0,0.5)',padding:'2px 8px',borderRadius:2,letterSpacing:'0.1em'}}>
            LOUNGE
          </div>
          {/* 벽면 책장+화분 */}
          <div style={{position:'absolute',top:-2,left:WALL+12,display:'flex',gap:10,alignItems:'flex-end'}}>
            <Bookshelf />
            <OfficePlant size="lg" />
            <Bookshelf />
          </div>
          {/* 라운드 테이블들 */}
          {Array.from({length:loungeTableCount},(_,i) => <RoundTable key={i} />)}
          {/* 커피 & 화분 */}
          <div style={{display:'flex',flexDirection:'column',gap:8,marginLeft:'auto',alignItems:'center'}}>
            <span style={{fontSize:20,opacity:0.6,userSelect:'none'}}>☕</span>
            <OfficePlant size="md" />
          </div>
          {/* 문 */}
          <div style={{position:'absolute',bottom:-WALL,left:40,width:28,height:WALL,background:'#8a8a92',borderRadius:'0 0 2px 2px'}} />
        </div>
      )}
    </div>
  );
}

// ── 마크다운 렌더 ────────────────────────────────────────────────────
function renderMd(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/```([\s\S]*?)```/g,'<pre style="background:#1a1a1a;padding:10px 12px;overflow-x:auto;margin:8px 0;font-size:11px;border:1px solid #3e3e3e;border-radius:4px;white-space:pre-wrap;font-family:monospace;color:#d4d4d4">$1</pre>')
    .replace(/`([^`]+)`/g,'<code style="background:#2d2d2d;padding:1px 6px;font-size:11px;border-radius:3px;color:#d4d4d4;font-family:monospace">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g,'<strong style="color:#e8e8e8;font-weight:600">$1</strong>')
    .replace(/^### (.+)$/gm,'<div style="color:#9d9d9d;margin:8px 0 3px;font-size:11px;font-weight:600">$1</div>')
    .replace(/^## (.+)$/gm,'<div style="color:#c4c4c4;margin:10px 0 4px;font-size:12px;font-weight:600">$1</div>')
    .replace(/^# (.+)$/gm,'<div style="color:#e8e8e8;margin:12px 0 4px;font-size:13px;font-weight:700">$1</div>')
    .replace(/^- (.+)$/gm,'<div style="padding-left:10px;margin:2px 0;color:#c4c4c4">· $1</div>')
    .replace(/\n/g,'<br>');
}

// ── 로그인 모달 ──────────────────────────────────────────────────────
function LoginModal({ onClose, onDone }: { onClose:()=>void; onDone:()=>void }) {
  const [loading, setLoading] = useState(false);
  const [err,     setErr]     = useState('');

  const check = async () => {
    setLoading(true); setErr('');
    const r = await fetch('/api/auth');
    const d = await r.json();
    setLoading(false);
    if (d.loggedIn) setTimeout(onDone, 300);
    else setErr('Claude가 연결되지 않았습니다. 호스트에서 claude login을 실행했는지 확인하세요.');
  };

  return (
    <div className="modal-backdrop" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="modal" style={{width:460}}>
        <div className="modal-title">🔐 Claude 연결 확인</div>
        <div style={{fontSize:12,color:'var(--text-secondary)',lineHeight:1.8,marginBottom:4}}>
          이 앱이 설치된 호스트(서버/PC)에서 claude가 로그인되어 있어야 합니다.<br/>
          호스트 터미널에서 아래를 실행하세요:
        </div>
        <div style={{background:'var(--bg-canvas)',border:'1px solid var(--border)',padding:'10px 14px',borderRadius:4}}>
          <code style={{fontSize:12,color:'var(--accent)',fontFamily:'monospace'}}>claude login</code>
        </div>
        {err && <div style={{color:'var(--danger)',fontSize:11,padding:'6px 10px',background:'var(--danger-dim)',borderRadius:4,border:'1px solid #f2482233',marginTop:8}}>{err}</div>}
        <div style={{display:'flex',gap:8,marginTop:12}}>
          <button className="modal-btn-cancel" onClick={onClose}>닫기</button>
          <button className="modal-btn-ok" onClick={check} disabled={loading}>{loading?'확인 중...':'연결 확인'}</button>
        </div>
      </div>
    </div>
  );
}
