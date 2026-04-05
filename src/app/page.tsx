'use client';
import React, { useEffect, useRef, useCallback, useState } from 'react';
import { drawSprite } from '@/lib/sprites';

// ── Types ───────────────────────────────────────────────────────────
interface Agent { id:string; name:string; emoji:string; color:string; command_name:string|null; is_lead:number; org_level:string; harness_pattern:string; }
interface Part   { id:string; name:string; color:string; team_id:string; lead:Agent|null; workers:Agent[]; }
interface Team   { id:string; name:string; color:string; workspace_id:string; lead:Agent|null; workers:Agent[]; parts:Part[]; }
interface Dept   { id:string; name:string; path:string; lead:Agent|null; teams:Team[]; }
interface Div    { id:string; name:string; color:string; lead:Agent|null; departments:Dept[]; }

type ChatTarget = { id:string; name:string; label:string; color:string };
type ModalType  = 'division'|'department'|'team'|'part'|'agent-team'|'agent-part'|'agent-sub';

export default function Dashboard() {
  const stageRef  = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const chatLogRef= useRef<HTMLDivElement>(null);
  const stateRef  = useRef({ sc:0.7, tx:40, ty:40, drag:false, lx:0, ly:0, spaceDown:false });

  const [divs,       setDivs]       = useState<Div[]>([]);
  const [standalone, setStandalone] = useState<Dept[]>([]);
  const [chat,       setChat]       = useState<ChatTarget|null>(null);
  const [chatLog,    setChatLog]    = useState<{role:string;text:string}[]>([]);
  const [chatInput,  setChatInput]  = useState('');
  const [chatBusy,   setChatBusy]   = useState(false);
  const [authStatus, setAuthStatus] = useState<{loggedIn:boolean}|null>(null);
  const [loginModal, setLoginModal] = useState(false);

  // 모달 상태
  const [modal,      setModal]      = useState<ModalType|null>(null);
  const [mCtx,       setMCtx]       = useState<any>({});  // 모달 컨텍스트

  const reload = useCallback(() => {
    fetch('/api/divisions').then(r=>r.json()).then(d=>{
      if (d.ok) { setDivs(d.divisions); setStandalone(d.standalone); }
    });
  }, []);

  useEffect(() => {
    reload();
    fetch('/api/auth').then(r=>r.json()).then(d=>setAuthStatus({loggedIn:d.loggedIn})).catch(()=>{});
  }, [reload]);

  // 스프라이트
  useEffect(() => {
    setTimeout(()=>{ document.querySelectorAll<HTMLCanvasElement>('canvas[data-sp]').forEach(cv=>drawSprite(cv)); }, 60);
  }, [divs, standalone]);

  // 채팅 스크롤
  useEffect(() => {
    const el = chatLogRef.current; if (el) el.scrollTop = el.scrollHeight;
  }, [chatLog]);

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
      if(e.ctrlKey||e.metaKey){ const f=e.deltaY<0?1.1:0.9; const r=stage.getBoundingClientRect(); const c=Math.max(0.2,Math.min(3,st.sc*f)); st.tx=e.clientX-r.left-(e.clientX-r.left-st.tx)*(c/st.sc); st.ty=e.clientY-r.top-(e.clientY-r.top-st.ty)*(c/st.sc); st.sc=c; }
      else{ st.tx-=e.deltaX; st.ty-=e.deltaY; }
      applyT();
    };
    const onDown=(e:MouseEvent)=>{ if(e.button===1||st.spaceDown){e.preventDefault();st.drag=true;st.lx=e.clientX;st.ly=e.clientY;} };
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

  // ── Claude 채팅 ──
  const sendChat = useCallback(async () => {
    if (!chatInput.trim()||!chat||chatBusy) return;
    const msg=chatInput.trim(); setChatInput(''); setChatBusy(true);
    setChatLog(l=>[...l,{role:'user',text:msg},{role:'assistant',text:''}]);
    let full='';
    try {
      const resp=await fetch(`/api/claude/${chat.id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg})});
      const reader=resp.body!.getReader(); const dec=new TextDecoder();
      while(true){const{done,value}=await reader.read();if(done)break;full+=dec.decode(value,{stream:true});setChatLog(l=>[...l.slice(0,-1),{role:'assistant',text:full}]);}
    } catch(e){ setChatLog(l=>[...l.slice(0,-1),{role:'assistant',text:`[오류: ${e}]`}]); }
    setChatBusy(false);
  }, [chatInput,chat,chatBusy]);

  const openChat = (target: ChatTarget) => { setChat(target); setChatLog([]); };

  const del = async (url: string) => { await fetch(url,{method:'DELETE'}); reload(); };

  // ── 렌더 헬퍼 ──
  const AgentRow = ({ a, onChat }: { a:Agent; onChat:()=>void }) => (
    <div className="org-agent-card" style={{borderLeft:`3px solid ${a.color}`,cursor:a.is_lead?'pointer':'default',opacity:a.is_lead?1:0.7}} onClick={a.is_lead?onChat:undefined}>
      <canvas data-sp={a.is_lead?'sonnet':'haiku'} data-tie={a.color} data-sc={a.is_lead?'3':'2.5'} />
      <div style={{flex:1}}>
        <div className="org-agent-name">{a.emoji} {a.name}</div>
        <div className="org-agent-role">{a.org_level==='team'?'팀장':a.org_level==='part'?'파트장':a.org_level==='department'?'실장':a.org_level==='division'?'부문장':'팀원'}</div>
      </div>
      {a.is_lead && <div className="org-lead-badge" style={{background:'#1e1b4b',color:'#a78bfa',fontSize:8}}>LEAD</div>}
      <button onClick={e=>{e.stopPropagation();if(confirm(`"${a.name}" 삭제?`)) del(`/api/agents?id=${a.id}`);}} style={{background:'none',border:'none',color:'#374151',cursor:'pointer',fontSize:11,padding:'0 4px'}}>✕</button>
    </div>
  );

  const PartBlock = ({ part, teamId, wsId }: { part:Part; teamId:string; wsId:string }) => (
    <div style={{marginLeft:16,marginBottom:8,border:`1px solid ${part.color}44`,background:'#070714'}}>
      <div style={{display:'flex',alignItems:'center',padding:'6px 10px',gap:8,borderBottom:`1px solid ${part.color}22`,background:part.color+'11'}}>
        <span style={{fontSize:10,color:part.color}}>◆ {part.name} 파트</span>
        <div style={{display:'flex',gap:6,marginLeft:'auto'}}>
          {part.lead && <button className="org-add-btn" style={{color:'#a78bfa',borderColor:'#312e81'}} onClick={()=>part.lead&&openChat({id:part.lead.id,name:part.name,label:'파트',color:part.color})}>💬</button>}
          <button className="org-add-btn" onClick={()=>{setMCtx({partId:part.id,teamId,wsId});setModal('agent-part');}}>+ 파트장</button>
          {part.lead && <button className="org-add-btn" onClick={()=>{setMCtx({partId:part.id,leadId:part.lead!.id,teamId,wsId});setModal('agent-sub');}}>+ 서브</button>}
          <button className="org-add-btn" style={{color:'#ef4444',borderColor:'#7f1d1d'}} onClick={()=>confirm(`"${part.name}" 파트 삭제?`)&&del(`/api/parts?id=${part.id}`)}>🗑</button>
        </div>
      </div>
      {part.lead && <AgentRow a={part.lead} onChat={()=>part.lead&&openChat({id:part.lead.id,name:part.name,label:'파트',color:part.color})} />}
      {!part.lead && <div className="org-empty-lead" onClick={()=>{setMCtx({partId:part.id,teamId,wsId});setModal('agent-part');}}>+ 파트장 추가</div>}
      {part.workers.map(w=><AgentRow key={w.id} a={w} onChat={()=>{}} />)}
    </div>
  );

  const TeamBlock = ({ team, wsId }: { team:Team; wsId:string }) => (
    <div style={{marginLeft:12,marginBottom:10,border:`1px solid ${team.color}55`,background:'#08081a'}}>
      <div style={{display:'flex',alignItems:'center',padding:'8px 12px',gap:8,borderBottom:`1px solid ${team.color}33`,background:team.color+'18'}}>
        <span style={{fontSize:11,color:team.color}}>▶ {team.name} 팀</span>
        <div style={{display:'flex',gap:6,marginLeft:'auto'}}>
          {team.lead && <button className="org-add-btn" style={{color:'#a78bfa',borderColor:'#312e81'}} onClick={()=>team.lead&&openChat({id:team.lead.id,name:team.name,label:'팀',color:team.color})}>💬 팀에게</button>}
          <button className="org-add-btn" onClick={()=>{setMCtx({teamId:team.id,wsId});setModal('agent-team');}}>+ 팀장</button>
          {team.lead && <button className="org-add-btn" onClick={()=>{setMCtx({teamId:team.id,wsId});setModal('part');}}>+ 파트</button>}
          {team.lead && <button className="org-add-btn" onClick={()=>{setMCtx({teamId:team.id,leadId:team.lead!.id,wsId});setModal('agent-sub');}}>+ 서브</button>}
          <button className="org-add-btn" style={{color:'#ef4444',borderColor:'#7f1d1d'}} onClick={()=>confirm(`"${team.name}" 팀 삭제?`)&&del(`/api/teams?id=${team.id}`)}>🗑</button>
        </div>
      </div>
      {team.lead && <AgentRow a={team.lead} onChat={()=>team.lead&&openChat({id:team.lead.id,name:team.name,label:'팀',color:team.color})} />}
      {!team.lead && <div className="org-empty-lead" onClick={()=>{setMCtx({teamId:team.id,wsId});setModal('agent-team');}}>+ 팀장 추가</div>}
      {team.workers.map(w=><AgentRow key={w.id} a={w} onChat={()=>{}} />)}
      {team.parts.map(p=><PartBlock key={p.id} part={p} teamId={team.id} wsId={wsId} />)}
    </div>
  );

  const DeptBlock = ({ dept }: { dept:Dept }) => (
    <div style={{marginLeft:8,marginBottom:12,border:'1.5px solid #1a1a30',background:'#09091a',minWidth:320}}>
      <div style={{display:'flex',alignItems:'center',padding:'10px 14px',gap:8,borderBottom:'1px solid #1a1a30',background:'#0d0d20'}}>
        <span style={{fontSize:12,color:'#c4b5fd'}}>🏢 {dept.name} 실</span>
        <div style={{display:'flex',gap:6,marginLeft:'auto'}}>
          {dept.lead && <button className="org-add-btn" style={{color:'#a78bfa',borderColor:'#312e81'}} onClick={()=>dept.lead&&openChat({id:dept.lead.id,name:dept.name,label:'실',color:'#c4b5fd'})}>💬 실에게</button>}
          <button className="org-add-btn" onClick={()=>{setMCtx({wsId:dept.id});setModal('team');}}>+ 팀</button>
          <button className="org-add-btn" style={{color:'#ef4444',borderColor:'#7f1d1d'}} onClick={()=>confirm(`"${dept.name}" 실 삭제?`)&&del(`/api/workspaces?id=${dept.id}`)}>🗑</button>
        </div>
      </div>
      {dept.teams.map(t=><TeamBlock key={t.id} team={t} wsId={dept.id} />)}
      {dept.teams.length===0 && <div style={{padding:'16px',fontSize:9,color:'#2a2a45',textAlign:'center'}}>팀이 없습니다 · + 팀 추가</div>}
    </div>
  );

  return (
    <>
      <nav>
        <div className="nav-title">🏢 AI 사업부</div>
        <button className="nav-btn" onClick={()=>{Object.assign(stateRef.current,{sc:0.7,tx:40,ty:40});applyT();}}>전체보기</button>
        <button className="nav-btn" style={{background:'#4c1d95',color:'#c4b5fd'}} onClick={()=>setModal('division')}>+ 부문</button>
        <button className="nav-btn" style={{background:'#1e1b4b',color:'#a78bfa'}} onClick={()=>{setMCtx({});setModal('department');}}>+ 실</button>
        <a href="/org" style={{fontSize:10,color:"#6b7280",textDecoration:"none",padding:"4px 10px",border:"1px solid #1a1a30"}}>🏛 조직관리</a>
        <div className="nav-hint">Space+drag · Ctrl+scroll</div>
        <div style={{marginLeft:'auto',fontSize:10,padding:'4px 12px',border:'1px solid',
          borderColor:authStatus?.loggedIn?'#064e3b':'#7f1d1d',
          color:authStatus?.loggedIn?'#34d399':'#ef4444',cursor:authStatus?.loggedIn?'default':'pointer'}}
          onClick={()=>{ if(!authStatus?.loggedIn) setLoginModal(true); }}>
          {authStatus==null?'...':authStatus.loggedIn?'✓ Claude 연결됨':'⚠ 미연결 (클릭)'}
        </div>
      </nav>

      <div id="stage" ref={stageRef}>
        <div id="canvas" ref={canvasRef}>
          {divs.length===0 && standalone.length===0 ? (
            <div style={{position:'absolute',left:200,top:160,color:'#2a2a45',fontSize:9,textAlign:'center',lineHeight:3}}>
              <div style={{fontSize:28,marginBottom:12}}>🏗️</div>
              <div>조직이 없습니다</div>
              <div style={{color:'#1a1a30'}}>상단 [+ 부문] 또는 [+ 실]로 시작하세요</div>
            </div>
          ) : (
            <div style={{display:'flex',flexDirection:'column',gap:24,padding:'20px 0'}}>
              {/* 부문들 */}
              {divs.map(div=>(
                <div key={div.id} style={{border:`2px solid ${div.color}`,background:'#060610',padding:'0 0 12px 0'}}>
                  <div style={{display:'flex',alignItems:'center',padding:'10px 16px',gap:10,borderBottom:`1px solid ${div.color}44`,background:div.color+'22'}}>
                    <span style={{fontSize:14,color:div.color}}>◉ {div.name} 부문</span>
                    <div style={{display:'flex',gap:6,marginLeft:'auto'}}>
                      {div.lead && <button className="org-add-btn" style={{color:'#a78bfa',borderColor:'#312e81'}} onClick={()=>div.lead&&openChat({id:div.lead.id,name:div.name,label:'부문',color:div.color})}>💬 부문에게</button>}
                      <button className="org-add-btn" onClick={()=>{setMCtx({divId:div.id});setModal('department');}}>+ 실 추가</button>
                      <button className="org-add-btn" style={{color:'#ef4444',borderColor:'#7f1d1d'}} onClick={()=>confirm(`"${div.name}" 부문 삭제?`)&&del(`/api/divisions?id=${div.id}`)}>🗑</button>
                    </div>
                  </div>
                  <div style={{padding:'12px 12px 0'}}>
                    {div.departments.map(d=><DeptBlock key={d.id} dept={d} />)}
                    {div.departments.length===0 && <div style={{fontSize:9,color:'#2a2a45',padding:'8px 4px'}}>실이 없습니다 · + 실 추가</div>}
                  </div>
                </div>
              ))}

              {/* 독립 실들 */}
              {standalone.length>0 && (
                <div>
                  <div style={{fontSize:9,color:'#374151',padding:'0 8px 8px',letterSpacing:2}}>독립 실</div>
                  {standalone.map(d=><DeptBlock key={d.id} dept={d} />)}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 채팅 패널 */}
      {chat && (
        <div id="chat-panel">
          <div className="chat-panel-hdr">
            <div>
              <div style={{fontSize:11}}>💬 {chat.name}</div>
              <div style={{fontSize:8,color:'#4b5563',marginTop:3}}>{chat.label} 리더와 대화</div>
            </div>
            <div style={{display:'flex',gap:8,marginLeft:'auto',alignItems:'center'}}>
              <button title="대화 초기화" onClick={async()=>{await fetch(`/api/claude/${chat.id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reset:true})});setChatLog([]);}} style={{background:'none',border:'1px solid #1a1a30',color:'#4b5563',cursor:'pointer',fontSize:9,padding:'3px 10px',fontFamily:'inherit'}}>↺ 리셋</button>
              <button onClick={()=>{setChat(null);setChatLog([]);}} style={{background:'none',border:'none',color:'#4b5563',cursor:'pointer',fontSize:16}}>✕</button>
            </div>
          </div>
          <div className="chat-panel-log" ref={chatLogRef}>
            {chatLog.length===0 && <div style={{color:'#2a2a45',fontSize:9,textAlign:'center',padding:24}}>대화를 시작하세요</div>}
            {chatLog.map((m,i)=>(
              <div key={i} className={`claude-msg ${m.role}`} dangerouslySetInnerHTML={{__html:renderMd(m.text)}} />
            ))}
          </div>
          <div className="chat-input-row">
            <input value={chatInput} onChange={e=>setChatInput(e.target.value)}
              onKeyDown={e=>e.key==='Enter'&&!e.shiftKey&&sendChat()}
              placeholder="메시지 입력..." disabled={chatBusy}
              id="claude-input" type="text" autoComplete="off" autoFocus />
            <button id="claude-send-btn" onClick={sendChat} disabled={chatBusy}>▶</button>
          </div>
        </div>
      )}

      {/* 모달 */}
      {modal && (
        <OrgModal type={modal} ctx={mCtx} onClose={()=>setModal(null)} onDone={()=>{setModal(null);reload();}} />
      )}
      {loginModal && <LoginModal onClose={()=>setLoginModal(false)} onDone={()=>{setLoginModal(false);fetch('/api/auth').then(r=>r.json()).then(d=>setAuthStatus({loggedIn:d.loggedIn}));}} />}
    </>
  );
}

// ── 마크다운 렌더 ────────────────────────────────────────────────────
function renderMd(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/```([\s\S]*?)```/g,'<pre style="background:#050510;padding:10px;overflow-x:auto;margin:8px 0;font-size:8px;border:1px solid #1a1a30;white-space:pre-wrap">$1</pre>')
    .replace(/`([^`]+)`/g,'<code style="background:#0a0a1a;padding:2px 6px;font-size:8px">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g,'<strong style="color:#e5e7eb">$1</strong>')
    .replace(/^### (.+)$/gm,'<div style="color:#a78bfa;margin:8px 0 3px;font-size:9px">$1</div>')
    .replace(/^## (.+)$/gm,'<div style="color:#c4b5fd;margin:10px 0 4px;font-size:10px">$1</div>')
    .replace(/^# (.+)$/gm,'<div style="color:#e5e7eb;margin:12px 0 4px;font-size:11px">$1</div>')
    .replace(/^- (.+)$/gm,'<div style="padding-left:10px;margin:2px 0">· $1</div>')
    .replace(/\n/g,'<br>');
}

// ── 통합 모달 ─────────────────────────────────────────────────────────
function OrgModal({ type, ctx, onClose, onDone }: { type:ModalType; ctx:any; onClose:()=>void; onDone:()=>void }) {
  const [name,    setName]    = useState('');
  const [emoji,   setEmoji]   = useState('🤖');
  const [color,   setColor]   = useState('#6b7280');
  const [role,    setRole]    = useState('');
  const [pattern, setPattern] = useState('orchestrator');
  const [loading, setLoading] = useState(false);
  const [err,     setErr]     = useState('');

  const TITLES: Record<ModalType,string> = {
    division:    '🏛 부문 추가',
    department:  '🏢 실 추가',
    team:        '▶ 팀 추가',
    part:        '◆ 파트 추가',
    'agent-team':'팀장 추가',
    'agent-part':'파트장 추가',
    'agent-sub': '서브에이전트 추가',
  };
  const PATTERNS = [
    {v:'orchestrator',l:'오케스트레이터'},
    {v:'scatter-gather',l:'스캐터/게더'},
    {v:'pipeline',l:'파이프라인'},
    {v:'worker-pool',l:'워커 풀'},
    {v:'check-fix',l:'체크/픽스'},
    {v:'single',l:'단독'},
  ];

  const submit = async () => {
    if (!name.trim()) { setErr('이름을 입력하세요'); return; }
    setLoading(true); setErr('');
    try {
      let url='', body: any = {name,color};
      if (type==='division')   { url='/api/divisions'; }
      else if (type==='department') { url='/api/teams'; body={name,color,workspace_id:ctx.wsId,description:role}; /* 실 추가 = team의 워크스페이스 직접 생성 */ url='/api/workspaces'; body={name,division_id:ctx.divId??null}; }
      else if (type==='team')  { url='/api/teams';    body={name,color,workspace_id:ctx.wsId,description:role}; }
      else if (type==='part')  { url='/api/parts';    body={name,color,team_id:ctx.teamId}; }
      else if (type==='agent-team') { url='/api/agents'; body={name,emoji,color,role,harness_pattern:pattern,team_id:ctx.teamId}; }
      else if (type==='agent-part') { url='/api/agents'; body={name,emoji,color,role,harness_pattern:pattern,part_id:ctx.partId,team_id:ctx.teamId}; }
      else if (type==='agent-sub')  { url='/api/agents'; body={name,emoji,color,role,harness_pattern:pattern,parent_agent_id:ctx.leadId,team_id:ctx.teamId}; }
      const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const d=await r.json(); if(!d.ok) throw new Error(d.error);
      onDone();
    } catch(e:any){ setErr(e.message||'오류'); }
    setLoading(false);
  };

  const isAgent = type.startsWith('agent');
  const colorDefault = type==='division'?'#7c3aed':type==='department'?'#0891b2':type==='team'?'#059669':'#d97706';

  return (
    <div className="modal-backdrop" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="modal">
        <div className="modal-title">{TITLES[type]}</div>
        <label className="modal-label">이름
          <input className="modal-input" value={name} onChange={e=>setName(e.target.value)} autoFocus
            placeholder={type==='division'?'개발부문':type==='department'?'개발실':type==='team'?'코어팀':type==='part'?'프론트파트':'포지'} />
        </label>
        {isAgent && (
          <label className="modal-label">이모지
            <input className="modal-input" value={emoji} onChange={e=>setEmoji(e.target.value)} style={{width:60}} />
          </label>
        )}
        <label className="modal-label">역할/설명
          <input className="modal-input" value={role} onChange={e=>setRole(e.target.value)} placeholder="역할을 입력하세요" />
        </label>
        <label className="modal-label">색상
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <input type="color" value={color||colorDefault} onChange={e=>setColor(e.target.value)} style={{width:40,height:28,border:'none',background:'none',cursor:'pointer'}} />
            <span style={{fontSize:8,color:'#4b5563'}}>{color||colorDefault}</span>
          </div>
        </label>
        {isAgent && (
          <label className="modal-label">하네스 패턴
            <select className="modal-input" value={pattern} onChange={e=>setPattern(e.target.value)}>
              {PATTERNS.map(p=><option key={p.v} value={p.v}>{p.l}</option>)}
            </select>
          </label>
        )}
        {err && <div style={{color:'#ef4444',fontSize:9}}>{err}</div>}
        <div style={{display:'flex',gap:8,marginTop:8}}>
          <button className="modal-btn-cancel" onClick={onClose}>취소</button>
          <button className="modal-btn-ok" onClick={submit} disabled={loading}>{loading?'처리중...':'추가'}</button>
        </div>
      </div>
    </div>
  );
}

// ── 로그인 모달 ──────────────────────────────────────────────────────
function LoginModal({ onClose, onDone }: { onClose:()=>void; onDone:()=>void }) {
  const [apiKey,  setApiKey]  = useState('');
  const [loading, setLoading] = useState(false);
  const [err,     setErr]     = useState('');
  const [success, setSuccess] = useState(false);
  const [copied,  setCopied]  = useState(false);
  const [tab,     setTab]     = useState<'oauth'|'apikey'>('oauth');
  const CMD = 'docker exec -it ai-hub claude login';

  const save = async () => {
    if (!apiKey.startsWith('sk-')) { setErr('sk-ant-... 형태의 키를 입력하세요'); return; }
    setLoading(true);
    const r=await fetch('/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey})});
    const d=await r.json(); setLoading(false);
    if(d.ok){setSuccess(true);setTimeout(onDone,800);}else setErr(d.error||'저장 실패');
  };

  const checkAuth = async () => {
    setLoading(true);
    const r=await fetch('/api/auth'); const d=await r.json(); setLoading(false);
    if(d.loggedIn){setSuccess(true);setTimeout(onDone,800);}else setErr('아직 로그인이 확인되지 않았습니다.');
  };

  return (
    <div className="modal-backdrop" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="modal" style={{width:480}}>
        <div className="modal-title">🔐 Claude 로그인</div>
        <div style={{display:'flex',gap:0,borderBottom:'1px solid #1a1a30'}}>
          {[['oauth','☁ Claude 구독'],['apikey','🔑 API 키']].map(([v,l])=>(
            <button key={v} onClick={()=>{setTab(v as any);setErr('');}} style={{fontSize:9,padding:'8px 16px',cursor:'pointer',fontFamily:'inherit',background:'none',border:'none',color:tab===v?'#a78bfa':'#4b5563',borderBottom:tab===v?'2px solid #a78bfa':'2px solid transparent'}}>{l}</button>
          ))}
        </div>
        {tab==='oauth' && (
          <>
            <div style={{fontSize:9,color:'#6b7280',lineHeight:2.2}}>터미널에서 아래 명령어를 실행하세요:</div>
            <div style={{background:'#050510',border:'1px solid #1a1a30',padding:'10px 14px',display:'flex',alignItems:'center',gap:10}}>
              <code style={{fontSize:10,color:'#60a5fa',flex:1}}>{CMD}</code>
              <button onClick={()=>{navigator.clipboard.writeText(CMD).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),2000)});}} style={{fontSize:8,color:copied?'#34d399':'#4b5563',background:'#111',border:'1px solid #1a1a30',padding:'4px 10px',cursor:'pointer',fontFamily:'inherit'}}>{copied?'✓ 복사됨':'복사'}</button>
            </div>
            <button className="modal-btn-ok" onClick={checkAuth} disabled={loading}>{loading?'확인중...':'✓ 로그인 확인'}</button>
          </>
        )}
        {tab==='apikey' && (
          <>
            <label className="modal-label">API 키<input className="modal-input" type="password" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder="sk-ant-api03-..." autoFocus onKeyDown={e=>e.key==='Enter'&&save()} /></label>
            <button className="modal-btn-ok" onClick={save} disabled={loading||success}>{loading?'저장중...':success?'완료!':'저장'}</button>
          </>
        )}
        {err && <div style={{color:'#ef4444',fontSize:9}}>{err}</div>}
        {success && <div style={{color:'#34d399',fontSize:10}}>✓ 연결 완료!</div>}
        <button className="modal-btn-cancel" onClick={onClose}>닫기</button>
      </div>
    </div>
  );
}
