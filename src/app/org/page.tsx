'use client';
import React, { useEffect, useState, useCallback, useRef } from 'react';

interface Agent { id:string; name:string; emoji:string; color:string; org_level:string; is_lead:number; command_name:string|null; harness_pattern:string; }
interface Part   { id:string; name:string; color:string; team_id:string; lead:Agent|null; workers:Agent[]; }
interface Team   { id:string; name:string; color:string; workspace_id:string; description:string; lead:Agent|null; workers:Agent[]; parts:Part[]; }
interface Dept   { id:string; name:string; path:string; division_id:string|null; lead:Agent|null; teams:Team[]; }
interface Div    { id:string; name:string; color:string; lead:Agent|null; departments:Dept[]; }

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
  const [divs,       setDivs]       = useState<Div[]>([]);
  const [standalone, setStandalone] = useState<Dept[]>([]);
  const [form,       setForm]       = useState<FormState>({ open:false, level:'division' });
  const [expanded,   setExpanded]   = useState<Set<string>>(new Set());
  const [confirm,    setConfirm]    = useState<{msg:string;fn:()=>void}|null>(null);
  const dragItem   = useRef<{type:'div'|'dept',id:string}|null>(null);
  const dragOverId = useRef<string|null>(null);

  const reload = useCallback(() => {
    fetch('/api/divisions').then(r=>r.json()).then(d=>{
      if (d.ok) { setDivs(d.divisions); setStandalone(d.standalone); }
    });
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // ── DnD 핸들러 ──────────────────────────────────────────────────
  const onDragStart = (type: 'div'|'dept', id: string) => {
    dragItem.current = { type, id };
  };
  const onDragOver = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    dragOverId.current = id;
  };
  const onDrop = async (type: 'div'|'dept', targetId: string, allIds: string[]) => {
    const src = dragItem.current;
    if (!src || src.id === targetId || src.type !== type) return;
    // 목록에서 src를 빼고 target 앞에 삽입
    const filtered = allIds.filter(id => id !== src.id);
    const ti = filtered.indexOf(targetId);
    filtered.splice(ti, 0, src.id);
    dragItem.current = null;
    dragOverId.current = null;
    const url = type === 'div' ? '/api/divisions/reorder' : '/api/workspaces/reorder';
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
    <div style={{display:'flex',alignItems:'center',gap:10,padding:'8px 12px',borderLeft:`3px solid ${a.color}`,marginBottom:2,background:'#060612'}}>
      <span style={{fontSize:14}}>{a.emoji}</span>
      <div>
        <div style={{fontSize:12,color:'#e5e7eb'}}>{a.name}</div>
        <div style={{fontSize:10,color:'#6b7280'}}>{LEVEL_LABEL[a.org_level]||'팀원'} · {a.harness_pattern} · /{a.command_name||'-'}</div>
      </div>
      {a.is_lead===1 && <span style={{marginLeft:'auto',fontSize:9,color:'#a78bfa',background:'#1e1b4b',padding:'2px 8px'}}>LEAD</span>}
      <button className="org-del-btn" onClick={()=>ask(`"${a.name}" 에이전트를 삭제할까요?`, ()=>del(`/api/agents?id=${a.id}`))}>🗑</button>
    </div>
  );

  const PartRow = ({ part, teamId }: { part:Part; teamId:string }) => (
    <div style={{marginLeft:32,marginBottom:6,border:'1px solid #1a1a30',background:'#07071a'}}>
      <div className="org-row" style={{borderLeft:`3px solid ${part.color}`}}>
        <button className="org-expand" onClick={()=>toggle(part.id)}>{expanded.has(part.id)?'▾':'▸'}</button>
        <span style={{fontSize:11,color:part.color}}>◆ {part.name} 파트</span>
        <div className="org-row-actions">
          <button className="org-add-mini" onClick={()=>openForm('agent', part.id, `${part.name} 파트`)}>+ 파트장</button>
          {part.lead && <button className="org-add-mini" onClick={()=>openForm('agent', part.lead!.id, `${part.name} 파트 서브`)}>+ 서브</button>}
          <button className="org-del-btn" onClick={()=>ask(`"${part.name}" 파트를 삭제할까요?`, ()=>del(`/api/parts?id=${part.id}`))}>🗑</button>
        </div>
      </div>
      {expanded.has(part.id) && (
        <div style={{padding:'4px 0 4px 8px'}}>
          {part.lead   && <AgentChip a={part.lead} />}
          {!part.lead  && <div className="org-empty-hint" onClick={()=>openForm('agent',part.id,`${part.name} 파트`)}>+ 파트장 추가</div>}
          {part.workers.map(w=><AgentChip key={w.id} a={w} />)}
        </div>
      )}
    </div>
  );

  const TeamRow = ({ team, wsId }: { team:Team; wsId:string }) => (
    <div style={{marginLeft:24,marginBottom:8,border:'1px solid #1a1a30',background:'#08081c'}}>
      <div className="org-row" style={{borderLeft:`3px solid ${team.color}`}}>
        <button className="org-expand" onClick={()=>toggle(team.id)}>{expanded.has(team.id)?'▾':'▸'}</button>
        <span style={{fontSize:12,color:team.color}}>▶ {team.name} 팀</span>
        {team.description && <span style={{fontSize:10,color:'#374151',marginLeft:8}}>{team.description}</span>}
        <div className="org-row-actions">
          <button className="org-add-mini" onClick={()=>openForm('agent',team.id,`${team.name} 팀`)}>+ 팀장</button>
          {team.lead && <button className="org-add-mini" onClick={()=>openForm('part',team.id,`${team.name} 팀`)}>+ 파트</button>}
          {team.lead && <button className="org-add-mini" onClick={()=>openForm('agent',team.lead!.id,`${team.name} 서브`)}>+ 서브</button>}
          <button className="org-del-btn" onClick={()=>ask(`"${team.name}" 팀을 삭제할까요?`, ()=>del(`/api/teams?id=${team.id}`))}>🗑</button>
        </div>
      </div>
      {expanded.has(team.id) && (
        <div style={{padding:'4px 0 4px 8px'}}>
          {team.lead   && <AgentChip a={team.lead} />}
          {!team.lead  && <div className="org-empty-hint" onClick={()=>openForm('agent',team.id,`${team.name} 팀`)}>+ 팀장 추가</div>}
          {team.workers.map(w=><AgentChip key={w.id} a={w} />)}
          {team.parts.map(p=><PartRow key={p.id} part={p} teamId={team.id} />)}
          {team.parts.length===0 && team.lead && <div className="org-empty-hint" onClick={()=>openForm('part',team.id,`${team.name} 팀`)}>+ 파트 추가</div>}
        </div>
      )}
    </div>
  );

  const DeptRow = ({ dept }: { dept:Dept }) => (
    <div style={{marginLeft:16,marginBottom:10,border:'1px solid #1a1a30',background:'#09091e'}}>
      <div className="org-row" style={{borderLeft:'3px solid #6366f1'}}>
        <button className="org-expand" onClick={()=>toggle(dept.id)}>{expanded.has(dept.id)?'▾':'▸'}</button>
        <span style={{fontSize:13,color:'#c4b5fd'}}>🏢 {dept.name} 실</span>
        <span style={{fontSize:9,color:'#374151',marginLeft:8}}>{dept.path.split('/').pop()}</span>
        <div className="org-row-actions">
          <button className="org-add-mini" onClick={()=>openForm('team',dept.id,`${dept.name} 실`)}>+ 팀 추가</button>
          <button className="org-del-btn" onClick={()=>ask(`"${dept.name}" 실을 삭제할까요?`, ()=>del(`/api/workspaces?id=${dept.id}`))}>🗑</button>
        </div>
      </div>
      {expanded.has(dept.id) && (
        <div style={{padding:'4px 0 4px 8px'}}>
          {dept.teams.map(t=><TeamRow key={t.id} team={t} wsId={dept.id} />)}
          {dept.teams.length===0 && <div className="org-empty-hint" onClick={()=>openForm('team',dept.id,`${dept.name} 실`)}>+ 팀 추가</div>}
        </div>
      )}
    </div>
  );

  const allDepts = [...divs.flatMap(d=>d.departments), ...standalone];

  return (
    <div className="org-page">
      {/* 헤더 */}
      <div className="org-page-hdr">
        <a href="/" style={{color:'#555',fontSize:9,textDecoration:'none'}}>← 대시보드</a>
        <span style={{color:'#1a1a30'}}>|</span>
        <span style={{fontSize:12,color:'#fff',letterSpacing:2}}>🏛 조직 관리</span>
        <div style={{marginLeft:'auto',display:'flex',gap:10}}>
          <button className="org-add-btn" style={{background:'#4c1d95',color:'#c4b5fd',borderColor:'#6d28d9'}} onClick={()=>openForm('division')}>+ 부문 추가</button>
          <button className="org-add-btn" style={{background:'#1e1b4b',color:'#a78bfa',borderColor:'#3730a3'}} onClick={()=>openForm('department')}>+ 실 추가</button>
        </div>
      </div>

      <div style={{padding:'24px 32px',maxWidth:900}}>

        {/* 통계 카드 */}
        <div style={{display:'flex',gap:16,marginBottom:32}}>
          {[
            { label:'부문', value:divs.length,  color:'#fff' },
            { label:'실',   value:allDepts.length, color:'#ccc' },
            { label:'팀',   value:allDepts.reduce((s,d)=>s+d.teams.length,0), color:'#0891b2' },
            { label:'파트', value:allDepts.reduce((s,d)=>s+d.teams.reduce((s2,t)=>s2+t.parts.length,0),0), color:'#d97706' },
            { label:'에이전트', value:allDepts.reduce((s,d)=>s+d.teams.reduce((s2,t)=>s2+t.parts.reduce((s3,p)=>s3+p.workers.length+(p.lead?1:0),0)+(t.lead?1:0)+t.workers.length,0),0), color:'#666' },
          ].map(c=>(
            <div key={c.label} style={{flex:1,background:'#0d0d20',border:`1px solid ${c.color}44`,padding:'14px 16px',textAlign:'center'}}>
              <div className="org-stat-val">{c.value}</div>
              <div className="org-stat-lbl">{c.label}</div>
            </div>
          ))}
        </div>

        {divs.length===0 && standalone.length===0 && (
          <div style={{textAlign:'center',padding:'60px 0',color:'#2a2a45'}}>
            <div style={{fontSize:36,marginBottom:16}}>🏗️</div>
            <div style={{fontSize:11,marginBottom:8}}>조직이 없습니다</div>
            <div style={{fontSize:9}}>상단 [+ 부문 추가] 또는 [+ 실 추가]로 시작하세요</div>
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
            style={{marginBottom:24,border:'1px solid #333',background:'#0a0a0a',cursor:'grab'}}>
            <div className="org-row" style={{padding:'12px 16px',borderBottom:'1px solid #222',background:'#111',borderLeft:'4px solid #fff'}}>
              <button className="org-expand" onClick={()=>toggle(div.id)}>{expanded.has(div.id)?'▾':'▸'}</button>
              <span style={{fontSize:14,color:'#fff',display:'flex',alignItems:'center',gap:8}}><span style={{color:'#666',fontSize:10}}>⠿</span>◉ {div.name} 부문</span>
              <div className="org-row-actions">
                <button className="org-add-mini" onClick={()=>openForm('department',div.id,`${div.name} 부문`)}>+ 실 추가</button>
                <button className="org-del-btn" onClick={()=>ask(`"${div.name}" 부문을 삭제할까요?`, ()=>del(`/api/divisions?id=${div.id}`))}>🗑</button>
              </div>
            </div>
            {expanded.has(div.id) && (
              <div style={{padding:'8px 8px 8px'}}>
                {div.departments.map(d=><DeptRow key={d.id} dept={d} />)}
                {div.departments.length===0 && <div className="org-empty-hint" onClick={()=>openForm('department',div.id,`${div.name} 부문`)}>+ 실 추가</div>}
              </div>
            )}
          </div>
        ))}

        {/* 독립 실 */}
        {standalone.length>0 && (
          <div style={{marginBottom:24}}>
            <div style={{fontSize:9,color:'#374151',marginBottom:8,letterSpacing:2}}>── 독립 실 (부문 없음)</div>
            {standalone.map(d=><DeptRow key={d.id} dept={d} />)}
          </div>
        )}
      </div>

      {/* 삭제 확인 */}
      {confirm && (
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.7)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:9000}}>
          <div style={{background:'#0d0d20',border:'1.5px solid #1a1a30',padding:28,width:360,fontFamily:"'Press Start 2P',monospace"}}>
            <div style={{fontSize:10,color:'#ef4444',marginBottom:20,lineHeight:2}}>{confirm.msg}</div>
            <div style={{display:'flex',gap:10}}>
              <button className="modal-btn-cancel" onClick={()=>setConfirm(null)} style={{flex:1}}>취소</button>
              <button className="modal-btn-ok" onClick={confirm.fn} style={{flex:1,background:'#7f1d1d',color:'#fca5a5'}}>삭제</button>
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
        body = { name, emoji, color, role, harness_pattern: pattern };
        // 부모 컨텍스트 파싱 (parentLabel로 유추)
        const lbl = form.parentLabel || '';
        if (lbl.includes('파트')) body.part_id = form.parentId;
        else if (lbl.includes('서브')) body.parent_agent_id = form.parentId;
        else body.team_id = form.parentId;
      }

      const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error);
      onDone();
    } catch (e:any) { setErr(e.message||'오류 발생'); }
    setLoading(false);
  };

  const TITLES: Record<string,string> = {
    division:'부문 추가', department:'실 추가', team:'팀 추가', part:'파트 추가', agent:'에이전트 추가'
  };

  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.75)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:9000}}>
      <div style={{background:'#0d0d20',border:'1.5px solid #1a1a30',padding:28,width:440,fontFamily:"'Press Start 2P',monospace",display:'flex',flexDirection:'column',gap:16}}>
        <div style={{fontSize:11,color:'#e94560',letterSpacing:1}}>
          {LEVEL_ICON[form.level]} {TITLES[form.level]}
          {form.parentLabel && <span style={{fontSize:8,color:'#4b5563',display:'block',marginTop:4}}>→ {form.parentLabel}</span>}
        </div>

        <label style={{fontSize:9,color:'#6b7280',display:'flex',flexDirection:'column',gap:6}}>이름
          <input value={name} onChange={e=>setName(e.target.value)} autoFocus
            onKeyDown={e=>e.key==='Enter'&&submit()}
            style={{background:'#111',border:'1px solid #1a1a30',color:'#e5e7eb',fontFamily:'inherit',fontSize:10,padding:'8px 10px'}}
            placeholder={form.level==='division'?'개발부문':form.level==='department'?'개발실':form.level==='team'?'코어팀':form.level==='part'?'프론트파트':'포지'} />
        </label>

        {isAgent && (
          <label style={{fontSize:9,color:'#6b7280',display:'flex',flexDirection:'column',gap:6}}>이모지
            <input value={emoji} onChange={e=>setEmoji(e.target.value)} style={{background:'#111',border:'1px solid #1a1a30',color:'#e5e7eb',fontFamily:'inherit',fontSize:11,padding:'8px 10px',width:70}} />
          </label>
        )}

        <label style={{fontSize:9,color:'#6b7280',display:'flex',flexDirection:'column',gap:6}}>역할/설명
          <input value={role} onChange={e=>setRole(e.target.value)}
            style={{background:'#111',border:'1px solid #1a1a30',color:'#e5e7eb',fontFamily:'inherit',fontSize:10,padding:'8px 10px'}}
            placeholder="역할을 입력하세요 (선택)" />
        </label>

        <label style={{fontSize:9,color:'#6b7280',display:'flex',alignItems:'center',gap:10}}>색상
          <input type="color" value={color||DEFAULT_COLORS[form.level]} onChange={e=>setColor(e.target.value)} style={{width:40,height:30,border:'none',background:'none',cursor:'pointer'}} />
          <span style={{fontSize:8,color:'#4b5563'}}>{color}</span>
        </label>

        {isAgent && (
          <label style={{fontSize:9,color:'#6b7280',display:'flex',flexDirection:'column',gap:6}}>하네스 패턴
            <select value={pattern} onChange={e=>setPattern(e.target.value)}
              style={{background:'#111',border:'1px solid #1a1a30',color:'#e5e7eb',fontFamily:'inherit',fontSize:9,padding:'8px 10px'}}>
              {HARNESS_OPTS.map(o=><option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          </label>
        )}

        {err && <div style={{color:'#ef4444',fontSize:9}}>{err}</div>}

        <div style={{display:'flex',gap:10,marginTop:4}}>
          <button onClick={onClose} style={{flex:1,fontSize:9,color:'#4b5563',background:'none',border:'1px solid #1a1a30',padding:'10px',cursor:'pointer',fontFamily:'inherit'}}>취소</button>
          <button onClick={submit} disabled={loading} style={{flex:2,fontSize:9,color:'#a78bfa',background:'#1e1b4b',border:'none',padding:'10px',cursor:'pointer',fontFamily:'inherit'}}>
            {loading?'처리중...':'추가'}
          </button>
        </div>
      </div>
    </div>
  );
}
