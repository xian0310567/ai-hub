'use client';
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';

interface Agent { id:string; name:string; emoji:string; color:string; org_level:string; is_lead:number; command_name:string|null; harness_pattern:string; }
interface Part   { id:string; name:string; color:string; team_id:string; lead:Agent|null; workers:Agent[]; }
interface Team   { id:string; name:string; color:string; workspace_id:string; description:string; harness_prompt?:string; lead:Agent|null; workers:Agent[]; parts:Part[]; }
interface Dept   { id:string; name:string; path:string; division_id:string|null; harness_prompt?:string; lead:Agent|null; teams:Team[]; }
interface Div    { id:string; name:string; color:string; harness_prompt?:string; lead:Agent|null; departments:Dept[]; }

type Level = 'division'|'department'|'team'|'part'|'agent';

interface FormState {
  open: boolean;
  level: Level;
  parentId?: string;
  parentLabel?: string;
  editId?: string;
}

const LEVEL_LABEL: Record<string,string> = { division:'부문', department:'실', team:'팀', part:'파트', agent:'에이전트' };
const LEVEL_ICON:  Record<string,string> = { division:'◉', department:'🏢', team:'▶', part:'◆', agent:'👤' };

const HARNESS_OPTS = [
  { v:'orchestrator',   l:'오케스트레이터 — 하위에 위임' },
  { v:'scatter-gather', l:'스캐터/게더 — 병렬 후 통합' },
  { v:'pipeline',       l:'파이프라인 — 순차 처리' },
  { v:'worker-pool',    l:'워커 풀 — 동적 선택' },
  { v:'check-fix',      l:'체크/픽스 — 검증 반복' },
  { v:'single',         l:'단독 — 직접 처리' },
];

export default function OrgPage() {
  const router     = useRouter();
  const [divs,       setDivs]       = useState<Div[]>([]);
  const [standalone, setStandalone] = useState<Dept[]>([]);
  const [form,       setForm]       = useState<FormState>({ open:false, level:'division' });
  const [expanded,   setExpanded]   = useState<Set<string>>(new Set());
  const [confirm,    setConfirm]    = useState<{msg:string;fn:()=>void}|null>(null);
  const [editModal,  setEditModal]  = useState<{type:'team'|'agent'|'division'|'department'; data: any}|null>(null);
  const dragItem   = useRef<{type:'div'|'dept'|'team'|'part',id:string}|null>(null);
  const dragOverId = useRef<string|null>(null);
  const [transferModal, setTransferModal] = useState<{type:'team'|'part'; data:any}|null>(null);
  const [harnessModal,  setHarnessModal]  = useState<{org_id:string; org_type:'division'|'department'|'team'; org_name:string; agents:Agent[]; prevPrompt:string}|null>(null);
  const [harnessLoading, setHarnessLoading] = useState(false);

  const reload = useCallback(() => {
    Promise.all([
      fetch('/api/divisions').then(r => r.json()).catch(() => []),
      fetch('/api/workspaces').then(r => r.json()).catch(() => []),
      fetch('/api/teams').then(r => r.json()).catch(() => []),
    ]).then(([rawDivs, rawWs, rawTeams]) => {
      if (!Array.isArray(rawDivs)) {
        if (rawDivs?.error === 'Unauthorized') { router.replace('/login'); return; }
        rawDivs = [];
      }

      // Build teams map keyed by workspace_id
      const teamsMap: Record<string, Team[]> = {};
      for (const t of (Array.isArray(rawTeams) ? rawTeams : [])) {
        const wsId = t.workspace_id;
        if (!teamsMap[wsId]) teamsMap[wsId] = [];
        teamsMap[wsId].push({ ...t, lead: null, workers: [], parts: [] });
      }

      // Build departments (workspaces), keyed by division_id
      const deptsByDiv: Record<string, Dept[]> = {};
      const standalone: Dept[] = [];
      for (const ws of (Array.isArray(rawWs) ? rawWs : [])) {
        const dept: Dept = { ...ws, lead: null, teams: teamsMap[ws.id] ?? [] };
        if (ws.division_id) {
          if (!deptsByDiv[ws.division_id]) deptsByDiv[ws.division_id] = [];
          deptsByDiv[ws.division_id].push(dept);
        } else {
          standalone.push(dept);
        }
      }

      // Build divisions with nested departments
      const divList: Div[] = (rawDivs as any[]).map((x: any) => ({
        ...x,
        lead: null,
        departments: deptsByDiv[x.id] ?? [],
      }));

      setDivs(divList);
      setStandalone(standalone);

      const ids = new Set<string>();
      for (const div of divList) {
        ids.add(div.id);
        for (const dept of div.departments) {
          ids.add(dept.id);
          for (const team of dept.teams) {
            ids.add(team.id);
            for (const part of team.parts) ids.add(part.id);
          }
        }
      }
      for (const dept of standalone) {
        ids.add(dept.id);
        for (const team of dept.teams) {
          ids.add(team.id);
          for (const part of team.parts) ids.add(part.id);
        }
      }
      setExpanded(ids);
    });
  }, [router]);

  useEffect(() => {
    fetch('/api/auth/me').then(r => {
      if (!r.ok) router.replace('/login');
      else reload();
    }).catch(() => router.replace('/login'));
  }, [reload, router]);

  // ── DnD 핸들러 ──────────────────────────────────────────────────
  const onDragStart = (type: 'div'|'dept'|'team'|'part', id: string) => {
    dragItem.current = { type, id };
  };
  const onDragOver = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    dragOverId.current = id;
  };
  const onDrop = async (type: 'div'|'dept'|'team'|'part', targetId: string, allIds: string[]) => {
    const src = dragItem.current;
    if (!src || src.id === targetId || src.type !== type) return;
    // 목록에서 src를 빼고 target 앞에 삽입
    const filtered = allIds.filter(id => id !== src.id);
    const ti = filtered.indexOf(targetId);
    filtered.splice(ti, 0, src.id);
    dragItem.current = null;
    dragOverId.current = null;
    const url = type === 'div' ? '/api/divisions/reorder'
      : type === 'dept' ? '/api/workspaces/reorder'
      : type === 'team' ? '/api/teams/reorder'
      : '/api/parts/reorder';
    await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ ids: filtered }) });
    reload();
  };

  const toggle = (id: string) => setExpanded(s => { const n=new Set(s); n.has(id)?n.delete(id):n.add(id); return n; });
  const ask = (msg: string, fn: ()=>void) => setConfirm({msg, fn});

  const del = async (url: string) => {
    await fetch(url, { method:'DELETE' });
    reload();
    setConfirm(null);
  };

  const openForm = (level: Level, parentId?: string, parentLabel?: string) => {
    setForm({ open:true, level, parentId, parentLabel });
  };

  // ── 렌더 ─────────────────────────────────────────────────────────────

  const AgentChip = ({ a }: { a:Agent }) => (
    <div style={{display:'flex',alignItems:'center',gap:10,padding:'7px 12px',borderLeft:`2px solid ${a.color}`,marginBottom:2,background:'var(--bg-canvas)',transition:'background .1s'}} onMouseOver={e=>e.currentTarget.style.background='var(--bg-hover)'} onMouseOut={e=>e.currentTarget.style.background='var(--bg-canvas)'}>
      <span style={{fontSize:14}}>{a.emoji}</span>
      <div>
        <div style={{fontSize:12,fontWeight:500,color:'var(--text-primary)'}}>{a.name}</div>
        <div style={{fontSize:11,color:'var(--text-muted)'}}>{LEVEL_LABEL[a.org_level]||'팀원'} · {a.harness_pattern} · /{a.command_name||'-'}</div>
      </div>
      {a.is_lead===1 && <span style={{marginLeft:'auto',fontSize:10,fontWeight:600,color:'var(--accent)',background:'var(--accent-dim)',padding:'2px 7px',borderRadius:3,border:'1px solid #0d99ff44'}}>LEAD</span>}
      <button className="org-del-btn" style={{marginLeft: a.is_lead===1 ? 0 : 'auto'}} onClick={()=>setEditModal({type:'agent',data:a})}>✏</button>
      <button className="org-del-btn" onClick={()=>ask(`"${a.name}" 에이전트를 삭제할까요?`, ()=>del(`/api/agents?id=${a.id}`))}>✕</button>
    </div>
  );

  const PartRow = ({ part, teamId, allPartIds }: { part:Part; teamId:string; allPartIds?: string[] }) => (
    <div
      draggable={!!allPartIds}
      onDragStart={allPartIds ? ()=>onDragStart('part', part.id) : undefined}
      onDragOver={allPartIds ? e=>onDragOver(e, part.id) : undefined}
      onDrop={allPartIds ? ()=>onDrop('part', part.id, allPartIds) : undefined}
      style={{marginLeft:28,marginBottom:5,border:`1px solid ${part.color}33`,background:'var(--bg-canvas)',borderRadius:4,overflow:'hidden',cursor:allPartIds?'grab':undefined}}>
      <div className="org-row" style={{borderLeft:`2px solid ${part.color}`}}>
        {allPartIds && <span style={{color:'var(--text-muted)',fontSize:11,marginRight:2}}>⠿</span>}
        <button className="org-expand" onClick={()=>toggle(part.id)}>{expanded.has(part.id)?'▾':'▸'}</button>
        <span style={{fontSize:12,fontWeight:600,color:part.color}}>◆ {part.name}</span>
        <div className="org-row-actions">
          <button className="org-del-btn" onClick={()=>setTransferModal({type:'part', data:part})}>↗</button>
          <button className="org-del-btn" onClick={()=>ask(`"${part.name}" 파트를 삭제할까요?`, ()=>del(`/api/parts?id=${part.id}`))}>✕</button>
        </div>
      </div>
      {expanded.has(part.id) && (
        <div style={{padding:'4px 0 4px 8px'}}>
          {part.lead   && <AgentChip a={part.lead} />}
          {part.workers.map(w=><AgentChip key={w.id} a={w} />)}
          {!part.lead && !part.workers.length && <div style={{fontSize:11,color:'var(--text-muted)',padding:'8px 12px'}}>⚙ 하네스로 에이전트를 추가하세요</div>}
        </div>
      )}
    </div>
  );

  const TeamRow = ({ team, wsId, allTeamIds }: { team:Team; wsId:string; allTeamIds?: string[] }) => (
    <div
      draggable={!!allTeamIds}
      onDragStart={allTeamIds ? ()=>onDragStart('team', team.id) : undefined}
      onDragOver={allTeamIds ? e=>onDragOver(e, team.id) : undefined}
      onDrop={allTeamIds ? ()=>onDrop('team', team.id, allTeamIds) : undefined}
      style={{marginLeft:20,marginBottom:6,border:`1px solid ${team.color}44`,background:'var(--bg-panel)',borderRadius:4,overflow:'hidden',cursor:allTeamIds?'grab':undefined}}>
      <div className="org-row" style={{borderLeft:`2px solid ${team.color}`}}>
        {allTeamIds && <span style={{color:'var(--text-muted)',fontSize:11,marginRight:2}}>⠿</span>}
        <button className="org-expand" onClick={()=>toggle(team.id)}>{expanded.has(team.id)?'▾':'▸'}</button>
        <span style={{fontSize:12,fontWeight:600,color:team.color}}>▸ {team.name}</span>
        {team.description && <span style={{fontSize:11,color:'var(--text-muted)',marginLeft:8}}>{team.description}</span>}
        <div className="org-row-actions">
          <button className="org-add-mini" style={{color:'var(--accent-purple)',borderColor:'var(--accent-purple)44'}} onClick={()=>setHarnessModal({org_id:team.id,org_type:'team',org_name:team.name, agents:[...(team.lead?[team.lead]:[]),...team.workers,...team.parts.flatMap(p=>[...(p.lead?[p.lead]:[]),...p.workers])], prevPrompt:team.harness_prompt||''})}>⚙ 하네스</button>
          <button className="org-add-mini" onClick={()=>openForm('part',team.id,`${team.name} 팀`)}>+ 파트</button>
          <button className="org-del-btn" onClick={()=>setTransferModal({type:'team', data:team})}>↗</button>
          <button className="org-del-btn" onClick={()=>setEditModal({type:'team',data:team})}>✏</button>
          <button className="org-del-btn" onClick={()=>ask(`"${team.name}" 팀을 삭제할까요?`, ()=>del(`/api/teams?id=${team.id}`))}>✕</button>
        </div>
      </div>
      {expanded.has(team.id) && (
        <div style={{padding:'4px 0 4px 8px'}}>
          {team.lead   && <AgentChip a={team.lead} />}
          {team.workers.map(w=><AgentChip key={w.id} a={w} />)}
          {!team.lead && !team.workers.length && (
            <div style={{fontSize:11,color:'var(--text-muted)',padding:'8px 12px',display:'flex',alignItems:'center',gap:6}}>
              <span style={{color:'var(--accent-purple)'}}>⚙</span> 하네스 버튼으로 에이전트를 자동 생성하세요
            </div>
          )}
          {team.parts.map(p=><PartRow key={p.id} part={p} teamId={team.id} allPartIds={team.parts.map(x=>x.id)} />)}
          {team.parts.length===0 && <div className="org-empty-hint" onClick={()=>openForm('part',team.id,`${team.name} 팀`)}>+ 파트 추가</div>}
        </div>
      )}
    </div>
  );

  const DeptRow = ({ dept, allDeptIds }: { dept:Dept; allDeptIds?: string[] }) => (
    <div
      draggable={!!allDeptIds}
      onDragStart={allDeptIds ? ()=>onDragStart('dept',dept.id) : undefined}
      onDragOver={allDeptIds ? e=>onDragOver(e,dept.id) : undefined}
      onDrop={allDeptIds ? ()=>onDrop('dept',dept.id,allDeptIds) : undefined}
      style={{marginLeft:14,marginBottom:8,border:'1px solid var(--border)',background:'var(--bg-elevated)',borderRadius:5,overflow:'hidden',cursor:allDeptIds?'grab':undefined}}>
      <div className="org-row" style={{borderLeft:'2px solid var(--accent-purple)'}}>
        {allDeptIds && <span style={{color:'var(--text-muted)',fontSize:11,marginRight:2}}>⠿</span>}
        <button className="org-expand" onClick={()=>toggle(dept.id)}>{expanded.has(dept.id)?'▾':'▸'}</button>
        <span style={{fontSize:13,fontWeight:600,color:'var(--text-primary)'}}>🏢 {dept.name}</span>
        <span style={{fontSize:11,color:'var(--text-muted)',marginLeft:8}}>{dept.path.split('/').pop()}</span>
        <div className="org-row-actions">
          <button className="org-add-mini" style={{color:'var(--accent-purple)',borderColor:'var(--accent-purple)44'}} onClick={()=>{const agents:Agent[]=[]; if(dept.lead) agents.push(dept.lead); dept.teams.forEach(t=>{if(t.lead)agents.push(t.lead); agents.push(...t.workers); t.parts.forEach(p=>{if(p.lead)agents.push(p.lead); agents.push(...p.workers);});}); setHarnessModal({org_id:dept.id,org_type:'department',org_name:dept.name,agents,prevPrompt:dept.harness_prompt||''});}}>⚙ 하네스</button>
          <button className="org-add-mini" onClick={()=>openForm('team',dept.id,`${dept.name} 실`)}>+ 팀 추가</button>
          <button className="org-del-btn" onClick={()=>setEditModal({type:'department',data:dept})}>✏</button>
          <button className="org-del-btn" onClick={()=>ask(`"${dept.name}" 실을 삭제할까요?`, ()=>del(`/api/workspaces?id=${dept.id}`))}>✕</button>
        </div>
      </div>
      {expanded.has(dept.id) && (
        <div style={{padding:'4px 0 4px 8px'}}>
          {dept.teams.map(t=><TeamRow key={t.id} team={t} wsId={dept.id} allTeamIds={dept.teams.map(x=>x.id)} />)}
          {dept.teams.length===0 && <div className="org-empty-hint" onClick={()=>openForm('team',dept.id,`${dept.name} 실`)}>+ 팀 추가</div>}
        </div>
      )}
    </div>
  );

  const allDepts = [...divs.flatMap(d=>d.departments), ...standalone];

  return (
    <div className="org-page" style={{pointerEvents: harnessLoading ? 'none' : 'auto'}}>
      {/* 헤더 */}
      <div className="org-page-hdr">
        <a href="/" style={{fontSize:12,fontWeight:500,color:'var(--text-muted)',textDecoration:'none',transition:'color .12s'}} onMouseOver={e=>e.currentTarget.style.color='var(--text-primary)'} onMouseOut={e=>e.currentTarget.style.color='var(--text-muted)'}>← 대시보드</a>
        <span style={{color:'var(--border)'}}>|</span>
        <span style={{fontSize:14,fontWeight:700,color:'var(--text-primary)'}}>조직 관리</span>
        <div style={{marginLeft:'auto',display:'flex',gap:8}}>
          <button
            onClick={async () => {
              if (window.confirm('로그아웃하시겠습니까?')) {
                try {
                  await fetch('/api/auth/signout', { method: 'POST' });
                  router.push('/login');
                } catch (e) {
                  alert('로그아웃 실패');
                }
              }
            }}
            style={{fontSize:12,fontWeight:500,color:'var(--text-secondary)',border:'1px solid var(--border)',padding:'5px 14px',borderRadius:4,cursor:'pointer',background:'transparent',fontFamily:'inherit',transition:'all .12s'}}
            onMouseOver={e=>{e.currentTarget.style.color='var(--danger)';e.currentTarget.style.borderColor='var(--danger)';}}
            onMouseOut={e=>{e.currentTarget.style.color='var(--text-secondary)';e.currentTarget.style.borderColor='var(--border)';}}
          >
            로그아웃
          </button>
          <button className="nav-btn purple" onClick={()=>openForm('division')}>+ 부문</button>
          <button className="nav-btn" style={{color:'var(--accent)',borderColor:'var(--accent-dim)'}} onClick={()=>openForm('department')}>+ 실</button>
        </div>
      </div>

      <div style={{padding:'24px 32px',maxWidth:900}}>

        {/* 통계 카드 */}
        <div style={{display:'flex',gap:12,marginBottom:28}}>
          {[
            { label:'부문', value:divs.length },
            { label:'실',   value:allDepts.length },
            { label:'팀',   value:allDepts.reduce((s,d)=>s+d.teams.length,0) },
            { label:'파트', value:allDepts.reduce((s,d)=>s+d.teams.reduce((s2,t)=>s2+t.parts.length,0),0) },
            { label:'에이전트', value:allDepts.reduce((s,d)=>s+d.teams.reduce((s2,t)=>s2+t.parts.reduce((s3,p)=>s3+p.workers.length+(p.lead?1:0),0)+(t.lead?1:0)+t.workers.length,0),0) },
          ].map(c=>(
            <div key={c.label} className="org-stat-card">
              <div className="org-stat-val">{c.value}</div>
              <div className="org-stat-lbl">{c.label}</div>
            </div>
          ))}
        </div>

        {divs.length===0 && standalone.length===0 && (
          <div style={{textAlign:'center',padding:'60px 0',color:'var(--text-muted)'}}>
            <div style={{fontSize:36,marginBottom:16}}>🏗️</div>
            <div style={{fontSize:14,fontWeight:600,color:'var(--text-secondary)',marginBottom:6}}>조직이 없습니다</div>
            <div style={{fontSize:12}}>상단 [+ 부문] 또는 [+ 실]로 시작하세요</div>
          </div>
        )}

        {/* 부문들 */}
        {divs.map(div=>(
          <div key={div.id}
            draggable
            onDragStart={()=>onDragStart('div',div.id)}
            onDragOver={e=>onDragOver(e,div.id)}
            onDrop={()=>onDrop('div',div.id,divs.map(d=>d.id))}
            className={`org-dnd-item${dragOverId.current===div.id?' drag-over':''}`}
            style={{marginBottom:16,border:'1px solid var(--border)',background:'var(--bg-panel)',borderRadius:6,overflow:'hidden',cursor:'grab'}}>
            <div className="org-row" style={{padding:'10px 14px',borderBottom:'1px solid var(--border)',background:'var(--bg-elevated)',borderLeft:'3px solid var(--text-secondary)'}}>
              <button className="org-expand" onClick={()=>toggle(div.id)}>{expanded.has(div.id)?'▾':'▸'}</button>
              <span style={{fontSize:13,fontWeight:700,color:'var(--text-primary)',display:'flex',alignItems:'center',gap:8}}><span style={{color:'var(--text-muted)',fontSize:11}}>⠿</span>◉ {div.name}</span>
              <div className="org-row-actions">
                <button className="org-add-mini" style={{color:'var(--accent-purple)',borderColor:'var(--accent-purple)44'}} onClick={()=>setHarnessModal({org_id:div.id,org_type:'division',org_name:div.name,agents:div.lead?[div.lead]:[],prevPrompt:div.harness_prompt||''})}>⚙ 하네스</button>
                <button className="org-add-mini" onClick={()=>openForm('department',div.id,`${div.name} 부문`)}>+ 실 추가</button>
                <button className="org-del-btn" onClick={()=>setEditModal({type:'division',data:div})}>✏</button>
                <button className="org-del-btn" onClick={()=>ask(`"${div.name}" 부문을 삭제할까요?`, ()=>del(`/api/divisions?id=${div.id}`))}>✕</button>
              </div>
            </div>
            {expanded.has(div.id) && (
              <div style={{padding:'8px'}}>
                {div.departments.map(d=><DeptRow key={d.id} dept={d} allDeptIds={div.departments.map(x=>x.id)} />)}
                {div.departments.length===0 && <div className="org-empty-hint" onClick={()=>openForm('department',div.id,`${div.name} 부문`)}>+ 실 추가</div>}
              </div>
            )}
          </div>
        ))}

        {/* 독립 실 */}
        {standalone.length>0 && (
          <div style={{marginBottom:16}}>
            <div style={{fontSize:11,fontWeight:600,color:'var(--text-muted)',marginBottom:8,letterSpacing:'0.08em',textTransform:'uppercase'}}>독립 실</div>
            {standalone.map(d=><DeptRow key={d.id} dept={d} allDeptIds={standalone.map(x=>x.id)} />)}
          </div>
        )}
      </div>

      {/* 편집 모달 */}
      {editModal && (
        <EditForm
          type={editModal.type}
          data={editModal.data}
          onClose={()=>setEditModal(null)}
          onDone={()=>{ setEditModal(null); reload(); }}
        />
      )}

      {/* 하네스 설계 모달 */}
      {harnessModal && (
        <HarnessModal
          org_id={harnessModal.org_id}
          org_type={harnessModal.org_type}
          org_name={harnessModal.org_name}
          currentAgents={harnessModal.agents}
          prevPrompt={harnessModal.prevPrompt}
          onClose={()=>setHarnessModal(null)}
          onDone={()=>{ setHarnessModal(null); reload(); }}
          onLoadingChange={setHarnessLoading}
        />
      )}

      {/* 이동 모달 */}
      {transferModal && (
        <TransferModal
          type={transferModal.type}
          data={transferModal.data}
          divs={divs}
          standalone={standalone}
          onClose={()=>setTransferModal(null)}
          onDone={()=>{ setTransferModal(null); reload(); }}
        />
      )}

      {/* 삭제 확인 */}
      {confirm && (
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.6)',backdropFilter:'blur(2px)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:9000}}>
          <div style={{background:'var(--bg-panel)',border:'1px solid var(--border)',borderRadius:8,padding:24,width:360,boxShadow:'0 16px 48px rgba(0,0,0,.5)'}}>
            <div style={{fontSize:13,fontWeight:600,color:'var(--danger)',marginBottom:16}}>{confirm.msg}</div>
            <div style={{display:'flex',gap:8}}>
              <button className="modal-btn-cancel" onClick={()=>setConfirm(null)} style={{flex:1}}>취소</button>
              <button onClick={confirm.fn} style={{flex:1,fontSize:12,fontWeight:600,color:'#fff',background:'var(--danger)',border:'none',padding:'8px 16px',cursor:'pointer',borderRadius:4,fontFamily:'inherit'}}>삭제</button>
            </div>
          </div>
        </div>
      )}

      {/* 추가 폼 모달 */}
      {form.open && (
        <AddForm form={form} onClose={()=>setForm({open:false,level:'division'})} onDone={()=>{ setForm({open:false,level:'division'}); reload(); }} />
      )}
    </div>
  );
}

// ── 추가 폼 ───────────────────────────────────────────────────────────
function AddForm({ form, onClose, onDone }: { form:FormState; onClose:()=>void; onDone:()=>void }) {
  const [name,    setName]    = useState('');
  const [emoji,   setEmoji]   = useState('🤖');
  const [color,   setColor]   = useState('#6b7280');
  const [role,    setRole]    = useState('');
  const [pattern, setPattern] = useState('orchestrator');
  const [model,   setModel]   = useState('claude-sonnet-4-5');
  const [loading, setLoading] = useState(false);
  const [err,     setErr]     = useState('');

  const isAgent = form.level === 'agent';

  const DEFAULT_COLORS: Record<string,string> = {
    division:'#7c3aed', department:'#4f46e5', team:'#0891b2', part:'#d97706', agent:'#6b7280'
  };

  const submit = async () => {
    if (!name.trim()) { setErr('이름을 입력하세요'); return; }
    setLoading(true); setErr('');
    try {
      let url='', body: any = { name, color: color||DEFAULT_COLORS[form.level] };

      if (form.level === 'division') {
        url = '/api/divisions';
      } else if (form.level === 'department') {
        url = '/api/workspaces';
        body = { name, division_id: form.parentId || null };
      } else if (form.level === 'team') {
        url = '/api/teams';
        body = { name, color, description: role, workspace_id: form.parentId };
      } else if (form.level === 'part') {
        url = '/api/parts';
        body = { name, color, team_id: form.parentId };
      } else if (form.level === 'agent') {
        url = '/api/agents';
        // parentId는 team_id, part_id, 또는 parent_agent_id
        // 부모 타입은 서버에서 판단하게 넘길 것 — 여기서는 team_id 우선
        body = { name, emoji, color, role, harness_pattern: pattern, model };
        // 부모 컨텍스트 파싱 (parentLabel로 유추)
        const lbl = form.parentLabel || '';
        if (lbl.includes('파트')) body.part_id = form.parentId;
        else if (lbl.includes('서브')) body.parent_agent_id = form.parentId;
        else body.team_id = form.parentId;
      }

      const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
      const d = await r.json();
      if (!d.ok && !d.id) throw new Error(d.error || '오류 발생');
      onDone();
    } catch (e:any) { setErr(e.message||'오류 발생'); }
    setLoading(false);
  };

  const TITLES: Record<string,string> = {
    division:'부문 추가', department:'실 추가', team:'팀 추가', part:'파트 추가', agent:'에이전트 추가'
  };

  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.6)',backdropFilter:'blur(2px)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:9000}}>
      <div style={{background:'var(--bg-panel)',border:'1px solid var(--border)',borderRadius:8,padding:24,width:440,display:'flex',flexDirection:'column',gap:14,boxShadow:'0 16px 48px rgba(0,0,0,.5)'}}>
        <div style={{fontSize:14,fontWeight:700,color:'var(--text-primary)',paddingBottom:12,borderBottom:'1px solid var(--border)'}}>
          {LEVEL_ICON[form.level]} {TITLES[form.level]}
          {form.parentLabel && <span style={{fontSize:11,fontWeight:400,color:'var(--text-muted)',display:'block',marginTop:3}}>→ {form.parentLabel}</span>}
        </div>

        <label className="modal-label">이름
          <input className="modal-input" value={name} onChange={e=>setName(e.target.value)} autoFocus
            onKeyDown={e=>e.key==='Enter'&&submit()}
            placeholder={form.level==='division'?'개발부문':form.level==='department'?'개발실':form.level==='team'?'코어팀':form.level==='part'?'프론트파트':'포지'} />
        </label>

        {isAgent && (
          <label className="modal-label">이모지
            <input className="modal-input" value={emoji} onChange={e=>setEmoji(e.target.value)} style={{width:70}} />
          </label>
        )}

        <label className="modal-label">역할/설명
          <input className="modal-input" value={role} onChange={e=>setRole(e.target.value)} placeholder="역할을 입력하세요 (선택)" />
        </label>

        <label className="modal-label" style={{flexDirection:'row',alignItems:'center',gap:10}}>색상
          <input type="color" value={color||DEFAULT_COLORS[form.level]} onChange={e=>setColor(e.target.value)} style={{width:36,height:28,border:'none',background:'none',cursor:'pointer'}} />
          <span style={{fontSize:11,color:'var(--text-muted)'}}>{color}</span>
        </label>

        {isAgent && (
          <label className="modal-label">하네스 패턴
            <select className="modal-input" value={pattern} onChange={e=>setPattern(e.target.value)}>
              {HARNESS_OPTS.map(o=><option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          </label>
        )}

        {isAgent && (
          <label className="modal-label">모델
            <select className="modal-input" value={model} onChange={e=>setModel(e.target.value)}>
              <option value="claude-opus-4-5">Claude Opus 4.5 — 최고 성능</option>
              <option value="claude-sonnet-4-5">Claude Sonnet 4.5 — 균형 (기본)</option>
              <option value="claude-haiku-4-5">Claude Haiku 4.5 — 빠름·저비용</option>
              <option value="claude-opus-4">Claude Opus 4</option>
              <option value="claude-sonnet-4">Claude Sonnet 4</option>
            </select>
          </label>
        )}

        {err && <div style={{color:'var(--danger)',fontSize:11,padding:'6px 10px',background:'var(--danger-dim)',borderRadius:4,border:'1px solid #f2482233'}}>{err}</div>}

        <div style={{display:'flex',gap:8,marginTop:4}}>
          <button className="modal-btn-cancel" onClick={onClose} style={{flex:1}}>취소</button>
          <button className="modal-btn-ok" onClick={submit} disabled={loading} style={{flex:2}}>
            {loading?'처리중...':'추가'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 편집 폼 ───────────────────────────────────────────────────────────
function EditForm({ type, data, onClose, onDone }: {
  type: 'team' | 'agent' | 'division' | 'department';
  data: any;
  onClose: () => void;
  onDone: () => void;
}) {
  const [tab,     setTab]     = useState<'info'|'soul'>('info');
  const [name,    setName]    = useState(data.name || '');
  const [emoji,   setEmoji]   = useState(data.emoji || '🤖');
  const [color,   setColor]   = useState(data.color || '#6b7280');
  const [desc,    setDesc]    = useState(data.description || '');
  const [cmdName, setCmdName] = useState(data.command_name || '');
  const [pattern, setPattern] = useState(data.harness_pattern || 'orchestrator');
  const [model,   setModel]   = useState(data.model || 'claude-sonnet-4-5');
  const [soul,    setSoul]    = useState('');
  const [soulLoaded, setSoulLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err,     setErr]     = useState('');

  // 소울 탭 선택 시 로드
  React.useEffect(() => {
    if (tab === 'soul' && !soulLoaded && type === 'agent') {
      fetch(`/api/agents/soul?id=${data.id}`).then(r=>r.json()).then(d=>{ if(d.ok){ setSoul(d.soul); setSoulLoaded(true); }});
    }
  }, [tab, soulLoaded, data.id, type]);

  const HARNESS_OPTS = [
    { v:'orchestrator',   l:'오케스트레이터' },
    { v:'scatter-gather', l:'스캐터/게더' },
    { v:'pipeline',       l:'파이프라인' },
    { v:'worker-pool',    l:'워커 풀' },
    { v:'check-fix',      l:'체크/픽스' },
    { v:'single',         l:'단독' },
  ];

  const submit = async () => {
    if (!name.trim()) { setErr('이름을 입력하세요'); return; }
    setLoading(true); setErr('');
    try {
      if (tab === 'soul' && type === 'agent') {
        // 소울 저장
        const r = await fetch('/api/agents/soul', { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id: data.id, soul }) });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error);
        onDone(); return;
      }
      let url: string, body: any;
      if (type === 'division') {
        url = '/api/divisions'; body = { id: data.id, name, color };
      } else if (type === 'department') {
        url = '/api/workspaces'; body = { id: data.id, name };
      } else if (type === 'team') {
        url = '/api/teams'; body = { id: data.id, name, color, description: desc };
      } else {
        url = '/api/agents'; body = { id: data.id, name, emoji, color, command_name: cmdName, harness_pattern: pattern, model };
      }
      const r = await fetch(url, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      const d = await r.json();
      if (!d.ok && !d.id) throw new Error(d.error || '오류 발생');
      onDone();
    } catch(e:any) { setErr(e.message || '오류'); }
    setLoading(false);
  };

  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.6)',backdropFilter:'blur(2px)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:9000}}>
      <div style={{background:'var(--bg-panel)',border:'1px solid var(--border)',borderRadius:8,padding:24,width:440,display:'flex',flexDirection:'column',gap:14,boxShadow:'0 16px 48px rgba(0,0,0,.5)'}}>
        <div style={{fontSize:14,fontWeight:700,color:'var(--text-primary)',paddingBottom:12,borderBottom:'1px solid var(--border)',display:'flex',alignItems:'center',gap:12}}>
          <span>✏ {{ division:'부문 수정', department:'실 수정', team:'팀 수정', agent:'에이전트 수정' }[type]}</span>
          {type === 'agent' && (
            <div style={{display:'flex',gap:0,marginLeft:'auto',border:'1px solid var(--border)',borderRadius:4,overflow:'hidden'}}>
              {(['info','soul'] as const).map(t=>(
                <button key={t} onClick={()=>setTab(t)} style={{fontSize:11,fontWeight:600,padding:'3px 12px',background:tab===t?'var(--bg-canvas)':'transparent',color:tab===t?'var(--text-primary)':'var(--text-muted)',border:'none',cursor:'pointer',fontFamily:'inherit'}}>
                  {t==='info'?'정보':'소울'}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 소울 탭 */}
        {tab === 'soul' && type === 'agent' && (
          <label className="modal-label">SOUL.md
            <textarea className="modal-input" value={soul} onChange={e=>setSoul(e.target.value)}
              rows={14} style={{resize:'vertical',fontFamily:'monospace',fontSize:11,lineHeight:1.7}}
              placeholder="에이전트의 역할, 성격, 처리 원칙 등을 자유롭게 작성하세요..." />
          </label>
        )}

        {tab === 'info' && <>
        <label className="modal-label">이름
          <input className="modal-input" value={name} onChange={e=>setName(e.target.value)} autoFocus onKeyDown={e=>e.key==='Enter'&&submit()} />
        </label>

        {type === 'agent' && (
          <label className="modal-label">이모지
            <input className="modal-input" value={emoji} onChange={e=>setEmoji(e.target.value)} style={{width:70}} />
          </label>
        )}

        {type === 'team' && (
          <label className="modal-label">설명
            <input className="modal-input" value={desc} onChange={e=>setDesc(e.target.value)} placeholder="팀 설명 (선택)" />
          </label>
        )}

        {type === 'agent' && (
          <label className="modal-label">슬래시 커맨드
            <input className="modal-input" value={cmdName} onChange={e=>setCmdName(e.target.value)} placeholder="예: forge (선택)" />
          </label>
        )}

        {type !== 'department' && (
          <label className="modal-label" style={{flexDirection:'row',alignItems:'center',gap:10}}>색상
            <input type="color" value={color} onChange={e=>setColor(e.target.value)} style={{width:36,height:28,border:'none',background:'none',cursor:'pointer'}} />
            <span style={{fontSize:11,color:'var(--text-muted)'}}>{color}</span>
          </label>
        )}

        {type === 'agent' && (
          <label className="modal-label">하네스 패턴
            <select className="modal-input" value={pattern} onChange={e=>setPattern(e.target.value)}>
              {HARNESS_OPTS.map(o=><option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          </label>
        )}

        {type === 'agent' && (
          <label className="modal-label">모델
            <select className="modal-input" value={model} onChange={e=>setModel(e.target.value)}>
              <option value="claude-opus-4-5">Claude Opus 4.5 — 최고 성능</option>
              <option value="claude-sonnet-4-5">Claude Sonnet 4.5 — 균형 (기본)</option>
              <option value="claude-haiku-4-5">Claude Haiku 4.5 — 빠름·저비용</option>
              <option value="claude-opus-4">Claude Opus 4</option>
              <option value="claude-sonnet-4">Claude Sonnet 4</option>
            </select>
          </label>
        )}
        </>}

        {err && <div style={{color:'var(--danger)',fontSize:11,padding:'6px 10px',background:'var(--danger-dim)',borderRadius:4,border:'1px solid #f2482233'}}>{err}</div>}

        <div style={{display:'flex',gap:8,marginTop:4}}>
          <button className="modal-btn-cancel" onClick={onClose} style={{flex:1}}>취소</button>
          <button className="modal-btn-ok" onClick={submit} disabled={loading} style={{flex:2}}>
            {loading ? '저장중...' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 하네스 설계 모달 ──────────────────────────────────────────────────
function HarnessModal({ org_id, org_type, org_name, currentAgents, prevPrompt, onClose, onDone, onLoadingChange }: {
  org_id: string;
  org_type: 'division' | 'department' | 'team';
  org_name: string;
  prevPrompt: string;
  currentAgents: Agent[];
  onClose: () => void;
  onDone: () => void;
  onLoadingChange: (v: boolean) => void;
}) {
  const [task,    setTask]    = useState(prevPrompt);
  const [step,    setStep]    = useState<'input'|'preview'|'done'>('input');
  const [design,  setDesign]  = useState<any>(null);
  const [mode,    setMode]    = useState<'leader'|'team'|null>(null);
  const [loading, setLoading] = useState(false);
  const [applying,setApplying]= useState(false);
  const [err,     setErr]     = useState('');

  useEffect(() => { onLoadingChange(loading || applying); }, [loading, applying, onLoadingChange]);

  const isLeaderMode = org_type === 'division' || org_type === 'department';
  const LEVEL_KO = org_type === 'division' ? '부문장' : org_type === 'department' ? '실장' : '팀장';

  const PATTERN_COLOR: Record<string,string> = {
    orchestrator: '#7c3aed', pipeline: '#0891b2', 'scatter-gather': '#d97706',
    'worker-pool': '#059669', 'check-fix': '#dc2626', single: '#6b7280',
  };
  const PATTERN_KO: Record<string,string> = {
    orchestrator: '오케스트레이터', pipeline: '파이프라인', 'scatter-gather': '스캐터/게더',
    'worker-pool': '워커 풀', 'check-fix': '체크/픽스', single: '단독',
  };
  const ORG_KO = { division: '부문', department: '실', team: '팀' };

  const design_ = async () => {
    if (!task.trim()) { setErr(isLeaderMode ? '역할 설명을 입력하세요' : '업무 설명을 입력하세요'); return; }
    setLoading(true); setErr('');
    try {
      const r = await fetch('/api/harness', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, org_id, org_type, org_name }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || '설계 실패');
      setDesign(d.design);
      setMode(d.mode || (isLeaderMode ? 'leader' : 'team'));
      setStep('preview');
    } catch (e: any) { setErr(e.message || '오류'); }
    setLoading(false);
  };

  const apply = async () => {
    setApplying(true); setErr('');
    try {
      const r = await fetch('/api/harness', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id, org_type, org_name, task, design, mode: mode || (isLeaderMode ? 'leader' : 'team') }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || '적용 실패');
      setStep('done');
      setTimeout(onDone, 1200);
    } catch (e: any) { setErr(e.message || '오류'); }
    setApplying(false);
  };

  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.65)',backdropFilter:'blur(3px)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:9100,pointerEvents:'all'}}>
      <div style={{background:'var(--bg-panel)',border:'1px solid var(--border)',borderRadius:10,padding:28,width:560,maxHeight:'85vh',overflowY:'auto',display:'flex',flexDirection:'column',gap:16,boxShadow:'0 24px 64px rgba(0,0,0,.6)'}}>

        {/* 헤더 */}
        <div style={{display:'flex',alignItems:'center',gap:10,paddingBottom:14,borderBottom:'1px solid var(--border)'}}>
          <span style={{fontSize:18}}>{isLeaderMode ? '👔' : '⚙'}</span>
          <div>
            <div style={{fontSize:14,fontWeight:700,color:'var(--text-primary)'}}>{isLeaderMode ? `${LEVEL_KO} 역할 설정` : '하네스 팀 설계'}</div>
            <div style={{fontSize:11,color:'var(--text-muted)',marginTop:2}}>{ORG_KO[org_type]} · {org_name}</div>
          </div>
          <button onClick={loading||applying ? undefined : onClose} disabled={loading||applying} style={{marginLeft:'auto',background:'none',border:'none',color:loading||applying?'var(--border)':'var(--text-muted)',cursor:loading||applying?'not-allowed':'pointer',fontSize:16,lineHeight:1}}>✕</button>
        </div>

        {/* step: input */}
        {step === 'input' && (
          <>
            {/* 현재 리더 상태 (부문/실) */}
            {isLeaderMode && currentAgents.filter(a=>a.is_lead===1).length > 0 && (
              <div style={{background:'var(--bg-elevated)',borderRadius:6,padding:12,border:'1px solid var(--border)'}}>
                <div style={{fontSize:11,fontWeight:600,color:'var(--text-muted)',marginBottom:6,letterSpacing:'0.05em'}}>현재 {LEVEL_KO}</div>
                {currentAgents.filter(a=>a.is_lead===1).map(a=>(
                  <div key={a.id} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 8px',borderRadius:4,background:'var(--bg-canvas)'}}>
                    <span style={{fontSize:16}}>{a.emoji}</span>
                    <div style={{flex:1}}>
                      <div style={{fontSize:12,fontWeight:600,color:'var(--text-primary)'}}>{a.name}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 현재 에이전트 (팀) */}
            {!isLeaderMode && currentAgents.length > 0 && (
              <div style={{background:'var(--bg-elevated)',borderRadius:6,padding:12,border:'1px solid var(--border)'}}>
                <div style={{fontSize:11,fontWeight:600,color:'var(--text-muted)',marginBottom:8,letterSpacing:'0.05em'}}>현재 에이전트 ({currentAgents.length}명)</div>
                <div style={{display:'flex',flexDirection:'column',gap:4}}>
                  {currentAgents.map(a=>(
                    <div key={a.id} style={{display:'flex',alignItems:'center',gap:8,padding:'4px 8px',borderRadius:4,background:'var(--bg-canvas)'}}>
                      <span style={{fontSize:13}}>{a.emoji}</span>
                      <span style={{fontSize:11,fontWeight:500,color:'var(--text-primary)',flex:1}}>{a.name}</span>
                      {a.is_lead===1 && <span style={{fontSize:9,fontWeight:600,color:'var(--accent)',background:'var(--accent-dim)',padding:'1px 6px',borderRadius:3}}>LEAD</span>}
                      <span style={{fontSize:10,color:PATTERN_COLOR[a.harness_pattern]||'var(--text-muted)',background:(PATTERN_COLOR[a.harness_pattern]||'var(--text-muted)')+'18',padding:'1px 6px',borderRadius:10}}>{PATTERN_KO[a.harness_pattern]||a.harness_pattern}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 이전 설정값 안내 */}
            {prevPrompt && (
              <div style={{padding:'8px 12px',background:'var(--accent-dim)',borderRadius:6,border:'1px solid #0d99ff33',fontSize:11,color:'var(--accent)'}}>
                이전 설정값이 불러와졌습니다. 수정 후 다시 설계할 수 있습니다.
              </div>
            )}

            <div style={{fontSize:12,color:'var(--text-secondary)',lineHeight:1.6}}>
              {isLeaderMode
                ? `이 ${ORG_KO[org_type]}이 어떤 역할을 하는지 설명해주세요. AI가 ${LEVEL_KO}의 역할을 정의합니다.`
                : currentAgents.length > 0
                  ? '에이전트를 추가하거나 구조를 재설계하려면 업무를 설명하세요.'
                  : '이 팀이 어떤 업무를 할지 설명해주세요. AI가 팀 구조를 설계합니다.'}
            </div>
            <label style={{display:'flex',flexDirection:'column',gap:6,fontSize:11,fontWeight:600,color:'var(--text-secondary)'}}>{isLeaderMode ? '역할 설명' : '업무 설명'}
              <textarea
                className="modal-input"
                value={task}
                onChange={e=>setTask(e.target.value)}
                rows={5}
                autoFocus
                style={{resize:'vertical',lineHeight:1.7,fontSize:12}}
                placeholder={isLeaderMode
                  ? `예: 이 ${ORG_KO[org_type]}은 사내 서비스 개발을 총괄합니다. AI Hub, 사내 포털, 관리 시스템 등의 개발을 관리하고 하위 조직에 업무를 배분합니다.`
                  : '예: 백엔드 API 개발, 코드 리뷰, QA 테스트까지 진행하는 개발팀이 필요해. BE 개발자 2명, FE 1명, QA 1명 정도로 구성해줘.'}
              />
            </label>
            {err && <div style={{color:'var(--danger)',fontSize:11,padding:'6px 10px',background:'var(--danger-dim)',borderRadius:4,border:'1px solid #f2482233'}}>{err}</div>}
            {loading && (
              <div style={{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',background:'var(--accent-purple)11',border:'1px solid var(--accent-purple)33',borderRadius:6}}>
                <span style={{fontSize:14,animation:'spin 1.2s linear infinite',display:'inline-block'}}>⏳</span>
                <span style={{fontSize:12,color:'var(--accent-purple)',fontWeight:500}}>
                  {isLeaderMode ? `AI가 ${LEVEL_KO} 역할을 정의하는 중... (약 30초)` : 'AI가 팀 구조를 설계하는 중... (약 30초)'}
                </span>
              </div>
            )}
            <div style={{display:'flex',gap:8,marginTop:4}}>
              <button className="modal-btn-cancel" onClick={onClose} disabled={loading} style={{flex:1,opacity:loading?0.4:1,cursor:loading?'not-allowed':'pointer'}}>취소</button>
              <button className="modal-btn-ok" onClick={design_} disabled={loading} style={{flex:2,background:'var(--accent-purple)',borderColor:'var(--accent-purple)',opacity:loading?0.7:1,cursor:loading?'not-allowed':'pointer'}}>
                {loading ? '설계 중...' : isLeaderMode ? '👔 역할 정의하기' : '✨ 설계하기'}
              </button>
            </div>
          </>
        )}

        {/* step: preview — 리더 모드 */}
        {step === 'preview' && design && mode === 'leader' && (
          <>
            <div style={{background:'var(--bg-elevated)',borderRadius:6,padding:16,border:'1px solid var(--border)'}}>
              <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
                <span style={{fontSize:24}}>{design.emoji || '👔'}</span>
                <div>
                  <div style={{fontSize:14,fontWeight:700,color:'var(--text-primary)'}}>{design.name}</div>
                  <div style={{fontSize:11,color:'var(--text-secondary)',marginTop:2}}>{design.role_summary}</div>
                </div>
              </div>
              <div style={{fontSize:12,color:'var(--text-secondary)',lineHeight:1.8,whiteSpace:'pre-wrap',background:'var(--bg-canvas)',padding:12,borderRadius:6,border:'1px solid var(--border)',maxHeight:300,overflowY:'auto'}}>
                {design.soul}
              </div>
            </div>

            {err && <div style={{color:'var(--danger)',fontSize:11,padding:'6px 10px',background:'var(--danger-dim)',borderRadius:4,border:'1px solid #f2482233'}}>{err}</div>}

            <div style={{display:'flex',gap:8,marginTop:4}}>
              <button className="modal-btn-cancel" onClick={()=>{ setStep('input'); setDesign(null); setMode(null); setErr(''); }} style={{flex:1}}>← 다시 설계</button>
              <button className="modal-btn-ok" onClick={apply} disabled={applying} style={{flex:2,background:'var(--accent-purple)',borderColor:'var(--accent-purple)'}}>
                {applying ? '⏳ 적용 중...' : '✅ 적용하기'}
              </button>
            </div>
          </>
        )}

        {/* step: preview — 팀 모드 */}
        {step === 'preview' && design && mode === 'team' && (
          <>
            {/* 패턴 배지 + reasoning */}
            <div style={{background:'var(--bg-elevated)',borderRadius:6,padding:14,border:'1px solid var(--border)'}}>
              <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
                <span style={{fontSize:11,fontWeight:700,color:PATTERN_COLOR[design.pattern]||'var(--accent)',background:(PATTERN_COLOR[design.pattern]||'var(--accent)')+'22',padding:'3px 10px',borderRadius:20,border:`1px solid ${(PATTERN_COLOR[design.pattern]||'var(--accent)')}44`}}>
                  {PATTERN_KO[design.pattern] || design.pattern}
                </span>
                <span style={{fontSize:11,color:'var(--text-muted)'}}>팀 구조 패턴</span>
              </div>
              <div style={{fontSize:12,color:'var(--text-secondary)',lineHeight:1.7}}>{design.reasoning}</div>
            </div>

            {/* 에이전트 카드들 */}
            <div style={{fontSize:11,fontWeight:600,color:'var(--text-muted)',letterSpacing:'0.07em',textTransform:'uppercase'}}>에이전트 구성 ({design.agents?.length}명)</div>
            <div style={{display:'flex',flexDirection:'column',gap:8}}>
              {design.agents?.map((a: any, i: number) => (
                <div key={i} style={{background:'var(--bg-elevated)',borderRadius:6,padding:12,border:`1px solid ${a.color||'var(--border)'}44`,borderLeft:`3px solid ${a.color||'#6b7280'}`}}>
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
                    <span style={{fontSize:18}}>{a.emoji}</span>
                    <span style={{fontSize:13,fontWeight:700,color:'var(--text-primary)'}}>{a.name}</span>
                    {a.is_lead && <span style={{fontSize:10,fontWeight:600,color:'var(--accent)',background:'var(--accent-dim)',padding:'2px 7px',borderRadius:3,border:'1px solid #0d99ff44'}}>LEAD</span>}
                    <span style={{marginLeft:'auto',fontSize:10,color:PATTERN_COLOR[a.harness_pattern]||'var(--text-muted)',background:(PATTERN_COLOR[a.harness_pattern]||'var(--text-muted)')+'18',padding:'2px 8px',borderRadius:12}}>{PATTERN_KO[a.harness_pattern]||a.harness_pattern}</span>
                  </div>
                  <div style={{fontSize:11,color:'var(--text-secondary)',lineHeight:1.6,paddingLeft:26}}>{a.role}</div>
                </div>
              ))}
            </div>

            {err && <div style={{color:'var(--danger)',fontSize:11,padding:'6px 10px',background:'var(--danger-dim)',borderRadius:4,border:'1px solid #f2482233'}}>{err}</div>}

            <div style={{display:'flex',gap:8,marginTop:4}}>
              <button className="modal-btn-cancel" onClick={()=>{ setStep('input'); setDesign(null); setMode(null); setErr(''); }} style={{flex:1}}>← 다시 설계</button>
              <button className="modal-btn-ok" onClick={apply} disabled={applying} style={{flex:2,background:'var(--accent-purple)',borderColor:'var(--accent-purple)'}}>
                {applying ? '⏳ 적용 중...' : '✅ 적용하기'}
              </button>
            </div>
          </>
        )}

        {/* step: done */}
        {step === 'done' && (
          <div style={{textAlign:'center',padding:'20px 0',color:'var(--text-secondary)'}}>
            <div style={{fontSize:36,marginBottom:12}}>{isLeaderMode ? '👔' : '🎉'}</div>
            <div style={{fontSize:14,fontWeight:600,color:'var(--text-primary)',marginBottom:4}}>
              {isLeaderMode ? `${LEVEL_KO} 역할 설정 완료!` : '에이전트 생성 완료!'}
            </div>
            <div style={{fontSize:12,color:'var(--text-muted)'}}>
              {isLeaderMode ? '역할이 업데이트되었습니다' : '소울은 백그라운드에서 자동 개선됩니다'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 이동 모달 ─────────────────────────────────────────────────────────
function TransferModal({ type, data, divs, standalone, onClose, onDone }: {
  type: 'team' | 'part';
  data: any;
  divs: Div[];
  standalone: Dept[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [targetId, setTargetId] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const allDepts = [...divs.flatMap(d => d.departments), ...standalone];

  const options = type === 'team'
    ? allDepts.map(dept => ({
        id: dept.id, label: dept.name,
        group: divs.find(d => d.departments.some(dep => dep.id === dept.id))?.name || '독립 실'
      }))
    : allDepts.flatMap(dept =>
        dept.teams.map(t => ({
          id: t.id, label: t.name,
          group: dept.name
        }))
      );

  const submit = async () => {
    if (!targetId) { setErr('대상을 선택하세요'); return; }
    setLoading(true);
    try {
      const body = type === 'team'
        ? { id: data.id, workspace_id: targetId }
        : { id: data.id, team_id: targetId };
      const url = type === 'team' ? '/api/teams' : '/api/parts';
      const r = await fetch(url, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error);
      onDone();
    } catch(e: any) { setErr(e.message || '오류'); }
    setLoading(false);
  };

  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.6)',backdropFilter:'blur(2px)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:9000}}>
      <div style={{background:'var(--bg-panel)',border:'1px solid var(--border)',borderRadius:8,padding:24,width:400,display:'flex',flexDirection:'column',gap:14,boxShadow:'0 16px 48px rgba(0,0,0,.5)'}}>
        <div style={{fontSize:14,fontWeight:700,color:'var(--text-primary)',paddingBottom:12,borderBottom:'1px solid var(--border)'}}>
          ↗ {type === 'team' ? '팀' : '파트'} 이동 — <span style={{color:'var(--accent)'}}>{data.name}</span>
        </div>
        <label style={{display:'flex',flexDirection:'column',gap:5,fontSize:11,fontWeight:600,color:'var(--text-secondary)'}}>
          {type === 'team' ? '이동할 실 선택' : '이동할 팀 선택'}
          <select className="modal-input" value={targetId} onChange={e=>setTargetId(e.target.value)} autoFocus>
            <option value="">— 선택 —</option>
            {options.filter(o => o.id !== (type === 'team' ? data.workspace_id : data.team_id)).map(o => (
              <option key={o.id} value={o.id}>[{o.group}] {o.label}</option>
            ))}
          </select>
        </label>
        {err && <div style={{color:'var(--danger)',fontSize:11,padding:'6px 10px',background:'var(--danger-dim)',borderRadius:4}}>{err}</div>}
        <div style={{display:'flex',gap:8}}>
          <button className="modal-btn-cancel" onClick={onClose} style={{flex:1}}>취소</button>
          <button className="modal-btn-ok" onClick={submit} disabled={loading} style={{flex:2}}>{loading?'이동중...':'이동'}</button>
        </div>
      </div>
    </div>
  );
}
