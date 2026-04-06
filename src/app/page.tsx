'use client';
import React, { useEffect, useRef, useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { drawSprite } from '@/lib/sprites';

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

  // 미션 상태 (다중 미션 지원)
  const [missions, setMissions] = useState<MissionItem[]>([]);
  const [missionInput, setMissionInput] = useState('');
  const [activeMissionId, setActiveMissionId] = useState<string|null>(null);
  const [missionResultOpen, setMissionResultOpen] = useState(false);
  const missionLogRef = useRef<HTMLDivElement>(null);
  const pollRefs = useRef<Record<string, ReturnType<typeof setInterval>>>({});
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

  const loadMissions = useCallback((resumePoll: (id: string) => void) => {
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
    const onKey=(e:KeyboardEvent)=>{ if(e.code==='Space'&&!e.ctrlKey){e.preventDefault();st.spaceDown=true;stage.style.cursor='grab';} };
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
  }, []);

  // 초기 미션 히스토리 로드 (startPolling이 정의된 이후)
  useEffect(() => { loadMissions(startPolling); }, [loadMissions, startPolling]);

  const submitMission = useCallback(async () => {
    if (!missionInput.trim()) return;
    const task = missionInput.trim();
    setMissionInput('');
    try {
      const r = await fetch('/api/missions', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ task }),
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
  }, [missionInput, startPolling]);

  const removeMission = useCallback((missionId: string) => {
    stopPolling(missionId);
    setMissions(prev => prev.filter(m => m.id !== missionId));
    setActiveMissionId(prev => prev === missionId ? null : prev);
    setMissionResultOpen(false);
  }, [stopPolling]);

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
    try {
      const resp = await fetch(`/api/missions/${missionId}/run`, { method: 'POST' });
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
              updateMission(missionId, { phase: 'done', doc: ev.final_doc });
            } else if (ev.type === 'error') {
              updateMission(missionId, { err: ev.error });
            }
          } catch {}
        }
      }
    } catch (e: any) {
      updateMission(missionId, { err: e.message, phase: 'error' });
    }
  }, [updateMission]);

  const activeMission = missions.find(m => m.id === activeMissionId) || null;

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
        <a href="/tasks" style={{fontSize:12,fontWeight:500,color:'var(--text-secondary)',textDecoration:'none',padding:'4px 10px',border:'1px solid var(--border)',borderRadius:4,transition:'all .12s'}} onMouseOver={e=>{e.currentTarget.style.color='var(--text-primary)';e.currentTarget.style.borderColor='#555';}} onMouseOut={e=>{e.currentTarget.style.color='var(--text-secondary)';e.currentTarget.style.borderColor='var(--border)';}}>태스크</a>
        <a href="/org" style={{fontSize:12,fontWeight:500,color:'var(--text-secondary)',textDecoration:'none',padding:'4px 10px',border:'1px solid var(--border)',borderRadius:4,transition:'all .12s'}} onMouseOver={e=>{e.currentTarget.style.color='var(--text-primary)';e.currentTarget.style.borderColor='#555';}} onMouseOut={e=>{e.currentTarget.style.color='var(--text-secondary)';e.currentTarget.style.borderColor='var(--border)';}}>조직 관리</a>

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

        <div suppressHydrationWarning style={{marginLeft:'auto',fontSize:12,fontWeight:500,padding:'4px 11px',border:'1px solid',borderRadius:4,
          borderColor:authStatus?.loggedIn?'#14ae5c44':'var(--danger-dim)',
          background:authStatus?.loggedIn?'#14ae5c11':'var(--danger-dim)',
          color:authStatus?.loggedIn?'var(--success)':'var(--danger)',cursor:authStatus?.loggedIn?'default':'pointer'}}
          onClick={()=>{ if(!authStatus?.loggedIn) setLoginModal(true); }}>
          {authStatus==null?'...' : authStatus.loggedIn ? '● Claude 연결됨' : '● 미연결'}
        </div>
      </nav>

      {/* ── 미션 좌측 패널 ── */}
      <div id="mission-panel">
        <div style={{padding:'10px 14px',borderBottom:'1px solid var(--border)',flexShrink:0,background:'var(--bg-elevated)',display:'flex',alignItems:'center',gap:8}}>
          <span style={{fontSize:14}}>🎯</span>
          <span style={{fontSize:12,fontWeight:700,color:'var(--text-primary)'}}>미션</span>
          {missions.filter(m=>m.phase==='running'||m.phase==='routing').length > 0 && (
            <span style={{fontSize:10,color:'var(--text-muted)',marginLeft:'auto'}}>{missions.filter(m=>m.phase==='running'||m.phase==='routing').length}개 진행중</span>
          )}
        </div>
        <div className="mission-list">
          {missions.length === 0 && (
            <div style={{padding:'32px 16px',textAlign:'center',color:'var(--text-muted)',fontSize:11}}>
              <div style={{fontSize:28,marginBottom:8,opacity:0.3}}>🎯</div>
              미션을 입력하면 AI들이<br/>병렬로 처리합니다
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
                {m.phase==='routing' && <><div className="pulse-dot" style={{background:'#f59e0b'}} /><span style={{color:'#f59e0b'}}>분석 중</span></>}
                {m.phase==='clarify' && <><div className="pulse-dot" style={{background:'var(--accent)'}} /><span style={{color:'var(--accent)'}}>확인 필요</span></>}
                {m.phase==='confirm' && <><span style={{color:'var(--accent)',fontSize:10}}>●</span><span style={{color:'var(--accent)'}}>실행 대기</span></>}
                {m.phase==='running' && <><div className="pulse-dot" style={{background:'var(--success)'}} /><span style={{color:'var(--success)'}}>실행 중 ({m.steps.filter((s:any)=>s.status==='done').length}/{m.steps.length})</span></>}
                {m.phase==='done' && <><span style={{color:'var(--success)',fontSize:10}}>✓</span><span style={{color:'var(--success)'}}>완료</span></>}
                {m.phase==='error' && <><span style={{color:'var(--danger)',fontSize:10}}>✕</span><span style={{color:'var(--danger)'}}>오류</span></>}
                <button onClick={e=>{e.stopPropagation();removeMission(m.id);}} style={{marginLeft:'auto',background:'none',border:'none',color:'var(--text-muted)',cursor:'pointer',fontSize:10,padding:'0 2px',lineHeight:1}}
                  onMouseOver={e=>e.currentTarget.style.color='var(--danger)'} onMouseOut={e=>e.currentTarget.style.color='var(--text-muted)'}>✕</button>
              </div>

              {/* 확장된 미션 상세 (활성 미션만) */}
              {activeMissionId===m.id && (
                <div style={{marginTop:10,borderTop:'1px solid var(--border-subtle)',paddingTop:10}} onClick={e=>e.stopPropagation()}>
                  {m.phase==='routing' && (
                    <div style={{display:'flex',alignItems:'center',gap:8,padding:'6px 0'}}>
                      <span style={{fontSize:12}}>⏳</span>
                      <span style={{fontSize:11,color:'#f59e0b',fontWeight:500}}>조직도를 분석하고 업무를 배정하는 중...</span>
                    </div>
                  )}

                  {m.phase==='clarify' && m.clarify && (
                    <div>
                      <div style={{display:'flex',alignItems:'flex-start',gap:8,marginBottom:8}}>
                        <span style={{fontSize:14}}>🤔</span>
                        <div style={{flex:1}}>
                          <div style={{fontSize:11,fontWeight:700,color:'var(--text-primary)',marginBottom:3}}>확인이 필요합니다</div>
                          <div style={{fontSize:10,color:'var(--text-secondary)',lineHeight:1.6}}>{m.clarify.gap}</div>
                        </div>
                      </div>
                      <div style={{display:'flex',flexDirection:'column',gap:4}}>
                        {m.clarify.options?.map((opt: any) => (
                          <button key={opt.id} onClick={()=>pickClarifyOption(m.id, opt)}
                            style={{textAlign:'left',padding:'8px 10px',background:'var(--bg-canvas)',border:'1px solid var(--border)',borderRadius:5,cursor:'pointer',transition:'all .12s',fontFamily:'inherit'}}
                            onMouseOver={e=>{e.currentTarget.style.borderColor='var(--accent)';}}
                            onMouseOut={e=>{e.currentTarget.style.borderColor='var(--border)';}}>
                            <div style={{fontSize:11,fontWeight:600,color:'var(--text-primary)',marginBottom:2}}>{opt.label}</div>
                            <div style={{fontSize:10,color:'var(--text-secondary)',lineHeight:1.4}}>{opt.description}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {m.phase==='confirm' && m.data && (
                    <div>
                      <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:8}}>
                        <span style={{fontSize:11,fontWeight:700,color:'var(--text-primary)'}}>📋 라우팅 분석 완료</span>
                        {m.data.summary && <span style={{fontSize:9,color:'var(--text-muted)'}}>— {m.data.summary}</span>}
                      </div>
                      <div style={{display:'flex',flexDirection:'column',gap:4,marginBottom:10}}>
                        {m.data.routing?.map((r: any, i: number) => (
                          <div key={i} style={{fontSize:10,color:'var(--text-secondary)',padding:'5px 8px',background:'var(--bg-canvas)',border:'1px solid var(--border-subtle)',borderRadius:4,borderLeft:`2px solid ${r.org_type==='division'?'#7c3aed':r.org_type==='department'?'#4f46e5':'#0891b2'}`}}>
                            <span style={{fontWeight:600,color:'var(--text-primary)'}}>{r.org_name}</span>
                            <span style={{color:'var(--text-muted)',marginLeft:4}}>→ {r.agent_name}</span>
                            <div style={{marginTop:2,lineHeight:1.4}}>{r.subtask}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{display:'flex',gap:6}}>
                        <button onClick={()=>removeMission(m.id)} style={{flex:1,fontSize:10,background:'none',border:'1px solid var(--border)',color:'var(--text-muted)',padding:'6px',borderRadius:4,cursor:'pointer',fontFamily:'inherit'}}>취소</button>
                        <button onClick={()=>runMission(m.id)} style={{flex:2,fontSize:10,background:'var(--success)',color:'#fff',border:'none',padding:'6px',borderRadius:4,cursor:'pointer',fontWeight:600,fontFamily:'inherit'}}>▶ 실행</button>
                      </div>
                    </div>
                  )}

                  {(m.phase==='running'||m.phase==='done') && m.steps.length > 0 && (
                    <div ref={m.phase==='running'?missionLogRef:undefined}>
                      <div style={{display:'flex',flexDirection:'column',gap:3}}>
                        {m.steps.map((s: any, i: number) => {
                          const stepKey = `${m.id}-${i}`;
                          const isExpanded = !!expandedSteps[stepKey];
                          const hasOutput = !!(s.output || s.error);
                          return (
                            <div key={i} style={{borderRadius:4,border:'1px solid var(--border-subtle)',background:'var(--bg-canvas)',overflow:'hidden',
                              borderLeftColor:s.status==='done'?'var(--success)':s.status==='running'?'#f59e0b':s.status==='failed'?'var(--danger)':'var(--border)',borderLeftWidth:2}}>
                              <div
                                style={{display:'flex',alignItems:'center',gap:6,padding:'5px 8px',fontSize:10,cursor:hasOutput?'pointer':'default'}}
                                onClick={()=>hasOutput&&toggleStep(m.id,i)}
                              >
                                <span>{s.status==='done'?'✅':s.status==='running'?'🔄':s.status==='failed'?'❌':s.status==='waiting'?'⏸️':'⏳'}</span>
                                <span style={{fontWeight:500,color:'var(--text-primary)',flex:1}}>{s.org_name}</span>
                                <span style={{color:'var(--text-muted)',fontSize:9}}>{s.status==='running'?'작업 중':s.status==='done'?'완료':s.status==='failed'?'실패':s.status==='waiting'?`대기 ${s.queue_position??''}번째`:'대기'}</span>
                                {hasOutput && <span style={{color:'var(--text-muted)',fontSize:9,marginLeft:4}}>{isExpanded?'▲':'▼'}</span>}
                              </div>
                              {isExpanded && hasOutput && (
                                <div style={{padding:'6px 8px 8px',borderTop:'1px solid var(--border-subtle)',fontSize:10,color:'var(--text-secondary)',lineHeight:1.6,whiteSpace:'pre-wrap',maxHeight:200,overflowY:'auto',background:'#0d0d12'}}>
                                  {s.error ? <span style={{color:'var(--danger)'}}>{s.error}</span> : s.output}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      {m.err && <div style={{fontSize:10,color:'var(--danger)',marginTop:6}}>{m.err}</div>}
                    </div>
                  )}

                  {m.phase==='done' && (
                    <div style={{display:'flex',gap:6,marginTop: m.steps.length>0?6:0}}>
                      <button onClick={()=>{setActiveMissionId(m.id);setMissionResultOpen(true);}} style={{flex:1,fontSize:10,background:'var(--accent)',color:'#fff',border:'none',padding:'6px',borderRadius:4,cursor:'pointer',fontWeight:600,fontFamily:'inherit'}}>📄 결과 보기</button>
                      <button onClick={()=>navigator.clipboard.writeText(m.doc)} style={{fontSize:10,background:'none',border:'1px solid var(--border)',color:'var(--text-muted)',padding:'6px 10px',borderRadius:4,cursor:'pointer',fontFamily:'inherit'}}>📋</button>
                      <button onClick={()=>removeMission(m.id)} style={{fontSize:10,background:'none',border:'1px solid var(--border)',color:'var(--text-muted)',padding:'6px 10px',borderRadius:4,cursor:'pointer',fontFamily:'inherit'}}>✕</button>
                    </div>
                  )}

                  {m.phase==='error' && (
                    <div>
                      <div style={{fontSize:10,color:'var(--danger)',marginBottom:6}}>{m.err}</div>
                      <button onClick={()=>removeMission(m.id)} style={{fontSize:10,background:'none',border:'1px solid var(--border)',color:'var(--text-muted)',padding:'6px 10px',borderRadius:4,cursor:'pointer',fontFamily:'inherit'}}>닫기</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="mission-input-area">
          <div style={{display:'flex',gap:6}}>
            <input
              value={missionInput} onChange={e=>setMissionInput(e.target.value)}
              onKeyDown={e=>e.key==='Enter'&&!e.shiftKey&&submitMission()}
              placeholder="미션을 입력하세요..."
              style={{flex:1,background:'rgba(255,255,255,0.04)',border:'1px solid var(--border)',borderRadius:6,padding:'8px 12px',color:'var(--text-primary)',fontSize:11,fontFamily:'inherit',outline:'none'}}
            />
            <button onClick={submitMission} disabled={!missionInput.trim()} style={{background:'var(--accent-purple)',color:'#fff',border:'none',borderRadius:6,padding:'8px 14px',fontSize:11,fontWeight:600,cursor:'pointer',fontFamily:'inherit',opacity:missionInput.trim()?1:0.4,flexShrink:0,whiteSpace:'nowrap'}}>
              전송
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
                <DivisionRoom key={div.id} div={div} onSelect={setSelectedAgent} />
              ))}

              {/* 독립 실들 */}
              {standalone.length > 0 && (
                <div style={{display:'flex',flexDirection:'column',gap:4}}>
                  <div style={{fontSize:9,fontWeight:700,color:'var(--text-muted)',letterSpacing:'0.12em',textTransform:'uppercase',paddingLeft:4,marginBottom:8}}>
                    ─ 독립 실 ─
                  </div>
                  <div style={{display:'flex',gap:20,flexWrap:'wrap',alignItems:'flex-start'}}>
                    {standalone.map(d => <DeptRoom key={d.id} dept={d} onSelect={setSelectedAgent} />)}
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


      {loginModal && <LoginModal onClose={()=>setLoginModal(false)} onDone={()=>{setLoginModal(false);fetch('/api/auth').then(r=>r.json()).then(d=>setAuthStatus({loggedIn:d.loggedIn}));}} />}
    </>
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
// GATHER-TOWN OFFICE COMPONENTS  (defined outside Dashboard to prevent remount)
// ─────────────────────────────────────────────────────────────────────

/** 탑뷰 에이전트 데스크 — 스프라이트 + 책상 + 네임태그 */
function AgentDesk({ a, onSelect }: { a: Agent; onSelect: SelectAgent }) {
  const isLead = a.is_lead === 1;
  const lvl = agentLevelLabel(a.org_level, a.is_lead);
  return (
    <div
      className="agent-desk"
      onClick={() => onSelect(a)}
      title={`${a.name} — ${lvl}`}
    >
      {/* LEAD 배지 */}
      {isLead && (
        <div style={{
          fontSize:7,fontWeight:800,color:a.color,
          background:a.color+'25',border:`1px solid ${a.color}55`,
          padding:'1px 6px',borderRadius:8,marginBottom:3,
          letterSpacing:'0.08em',whiteSpace:'nowrap',
        }}>▲ {lvl.toUpperCase()}</div>
      )}

      {/* 캐릭터 스프라이트 */}
      <canvas
        data-sp={isLead ? 'sonnet' : 'haiku'}
        data-tie={a.color}
        data-sc={isLead ? '3' : '2.5'}
        style={{width:28,height:44,imageRendering:'pixelated',flexShrink:0}}
      />

      {/* 책상 (탑뷰) */}
      <div style={{
        width:54,height:16,
        background:'linear-gradient(180deg,#3c3c3c 0%,#2e2e2e 100%)',
        border:'1px solid #4e4e4e',
        borderBottom:`2px solid ${isLead ? a.color+'99' : '#202020'}`,
        borderRadius:2,
        display:'flex',alignItems:'center',justifyContent:'center',gap:3,
        boxShadow:'0 2px 6px rgba(0,0,0,0.5)',
        position:'relative',
        flexShrink:0,
      }}>
        {/* 모니터 */}
        <div style={{width:16,height:11,background:'#0d1117',border:`1px solid ${a.color}66`,borderRadius:1,boxShadow:`0 0 4px ${a.color}44`}} />
        {/* 키보드 */}
        <div style={{width:11,height:5,background:'#282828',border:'1px solid #3a3a3a',borderRadius:1}} />
      </div>

      {/* 네임태그 */}
      <div style={{
        marginTop:4,
        fontSize:8,fontWeight:isLead?700:500,
        color:isLead?a.color:'var(--text-muted)',
        textAlign:'center',
        maxWidth:72,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',
        letterSpacing:'0.02em',lineHeight:1.3,
      }}>
        {a.emoji} {a.name}
      </div>
    </div>
  );
}

/** 파트 구역 */
function PartZone({ part, onSelect }: { part: Part; onSelect: SelectAgent }) {
  const agents = [part.lead, ...part.workers].filter(Boolean) as Agent[];
  if (agents.length === 0) return null;
  return (
    <div style={{
      position:'relative',
      border:`1px dotted ${part.color}55`,
      borderRadius:3,
      padding:'18px 10px 10px',
      background:part.color+'06',
    }}>
      <div style={{
        position:'absolute',top:-1,left:6,
        fontSize:7,fontWeight:700,color:part.color,
        background:'#14141a',padding:'0 6px',letterSpacing:'0.08em',
      }}>◆ {part.name}</div>
      <div style={{display:'flex',flexWrap:'wrap',gap:16,justifyContent:'center'}}>
        {agents.map(a => <AgentDesk key={a.id} a={a} onSelect={onSelect} />)}
      </div>
    </div>
  );
}

/** 팀 구역 (방 안의 작업 공간) */
function TeamZone({ team, onSelect }: { team: Team; onSelect: SelectAgent }) {
  const directAgents = [team.lead, ...team.workers].filter(Boolean) as Agent[];
  const hasParts = team.parts.length > 0;

  return (
    <div style={{
      position:'relative',
      border:`1px dashed ${team.color}77`,
      borderRadius:4,
      padding:'20px 12px 12px',
      background:`${team.color}0a`,
      boxShadow:`inset 0 0 20px ${team.color}08`,
      minWidth:110,
    }}>
      {/* 팀 표지판 */}
      <div style={{
        position:'absolute',top:-1,left:8,
        fontSize:8,fontWeight:700,color:team.color,
        background:'#14141a',padding:'1px 8px',
        border:`1px solid ${team.color}44`,borderRadius:2,
        letterSpacing:'0.05em',whiteSpace:'nowrap',
      }}>▸ {team.name}</div>

      {hasParts ? (
        <div style={{display:'flex',flexDirection:'column',gap:10}}>
          {directAgents.length > 0 && (
            <div style={{display:'flex',flexWrap:'wrap',gap:14,justifyContent:'center'}}>
              {directAgents.map(a => <AgentDesk key={a.id} a={a} onSelect={onSelect} />)}
            </div>
          )}
          {team.parts.map(p => <PartZone key={p.id} part={p} onSelect={onSelect} />)}
        </div>
      ) : (
        <div style={{display:'flex',flexWrap:'wrap',gap:14,justifyContent:'center'}}>
          {directAgents.map(a => <AgentDesk key={a.id} a={a} onSelect={onSelect} />)}
          {directAgents.length === 0 && <div style={{fontSize:9,color:'var(--text-muted)',padding:'8px 4px'}}>에이전트 없음</div>}
        </div>
      )}
    </div>
  );
}

/** 실 (Department) 방 */
function DeptRoom({ dept, onSelect }: { dept: Dept; onSelect: SelectAgent }) {
  return (
    <div style={{
      position:'relative',
      border:'2px solid #3a3a46',
      borderRadius:5,
      background:'#1a1a22',
      padding:'30px 14px 14px',
      minWidth:160,
      // 타일 바닥
      backgroundImage:`
        repeating-linear-gradient(0deg,transparent,transparent 15px,rgba(255,255,255,0.014) 15px,rgba(255,255,255,0.014) 16px),
        repeating-linear-gradient(90deg,transparent,transparent 15px,rgba(255,255,255,0.014) 15px,rgba(255,255,255,0.014) 16px)
      `,
      boxShadow:'inset 0 0 40px rgba(0,0,0,0.3)',
    }}>
      {/* 문 표시판 */}
      <div style={{
        position:'absolute',top:-2,left:12,
        fontSize:9,fontWeight:700,color:'var(--text-primary)',
        background:'#252530',border:'1px solid #3a3a46',
        padding:'2px 12px',borderRadius:3,
        letterSpacing:'0.04em',whiteSpace:'nowrap',
      }}>🏢 {dept.name}</div>

      {/* 실장 코너 오피스 */}
      {dept.lead && (
        <div style={{
          display:'flex',justifyContent:'center',
          marginBottom:12,
          padding:'10px',
          background:'rgba(255,255,255,0.03)',
          border:'1px solid rgba(255,255,255,0.06)',
          borderRadius:3,
        }}>
          <AgentDesk a={dept.lead} onSelect={onSelect} />
        </div>
      )}

      {/* 팀 구역들 */}
      <div style={{display:'flex',gap:10,flexWrap:'wrap',alignItems:'flex-start'}}>
        {dept.teams.map(t => <TeamZone key={t.id} team={t} onSelect={onSelect} />)}
        {dept.teams.length === 0 && !dept.lead && (
          <div style={{fontSize:9,color:'var(--text-muted)',padding:'12px 8px',fontStyle:'italic'}}>팀 없음</div>
        )}
      </div>
    </div>
  );
}

/** 부문 (Division) 대형 룸 */
function DivisionRoom({ div, onSelect }: { div: Div; onSelect: SelectAgent }) {
  return (
    <div style={{
      position:'relative',
      border:`2px solid ${div.color}99`,
      borderRadius:8,
      padding:'40px 18px 18px',
      background:`${div.color}06`,
      boxShadow:`
        0 0 0 1px ${div.color}22,
        0 4px 32px ${div.color}18,
        inset 0 0 80px rgba(0,0,0,0.25)
      `,
      // 부문 바닥 타일 (색상 틴트)
      backgroundImage:`
        repeating-linear-gradient(0deg,transparent,transparent 63px,${div.color}0a 63px,${div.color}0a 64px),
        repeating-linear-gradient(90deg,transparent,transparent 63px,${div.color}0a 63px,${div.color}0a 64px)
      `,
    }}>
      {/* 부문 현판 */}
      <div style={{
        position:'absolute',top:-3,left:16,
        fontSize:11,fontWeight:800,color:div.color,
        background:'#14141a',
        padding:'4px 16px',
        border:`2px solid ${div.color}99`,
        borderRadius:4,
        letterSpacing:'0.05em',
        boxShadow:`0 0 12px ${div.color}44`,
        whiteSpace:'nowrap',
      }}>◉ {div.name}</div>

      <div style={{display:'flex',gap:18,flexWrap:'wrap',alignItems:'flex-start'}}>
        {/* 부문장 코너 */}
        {div.lead && (
          <div style={{
            position:'relative',
            border:`1px solid ${div.color}55`,
            borderRadius:5,
            padding:'22px 14px 12px',
            background:`${div.color}14`,
            display:'flex',justifyContent:'center',alignItems:'center',
            minWidth:90,
            boxShadow:`inset 0 0 20px ${div.color}08`,
          }}>
            <div style={{
              position:'absolute',top:-1,left:6,
              fontSize:7,fontWeight:800,color:div.color,
              background:'#14141a',padding:'0 7px',
              letterSpacing:'0.1em',
            }}>DIRECTOR</div>
            <AgentDesk a={div.lead} onSelect={onSelect} />
          </div>
        )}

        {/* 실 방들 */}
        {div.departments.map(d => <DeptRoom key={d.id} dept={d} onSelect={onSelect} />)}

        {div.departments.length === 0 && !div.lead && (
          <div style={{fontSize:10,color:'var(--text-muted)',padding:'24px',fontStyle:'italic'}}>
            실이 없습니다 · 조직 관리에서 추가하세요
          </div>
        )}
      </div>
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
