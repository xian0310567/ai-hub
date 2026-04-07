'use client';
import React, { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';

interface Agent { id:string; name:string; emoji:string; color:string; org_level:string; is_lead:number; }
interface Task {
  id:string; agent_id:string|null; agent_name:string|null;
  title:string; description:string; status:string; result:string;
  created_at:number; updated_at:number;
}

const STATUS_LABEL: Record<string,string> = { pending:'대기', running:'실행중', done:'완료', failed:'실패' };
const STATUS_COLOR: Record<string,string> = { pending:'var(--text-muted)', running:'var(--accent)', done:'var(--success)', failed:'var(--danger)' };
const STATUS_BG:    Record<string,string> = { pending:'#ffffff11', running:'var(--accent-dim)', done:'#14ae5c18', failed:'var(--danger-dim)' };

export default function TasksPage() {
  const router = useRouter();
  const [tasks,  setTasks]  = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [form,   setForm]   = useState(false);
  const [filter, setFilter] = useState<string>('all');
  const [detail, setDetail] = useState<Task|null>(null);

  // 태스크 실행 상태
  const [running, setRunning] = useState<Record<string,boolean>>({});

  const reload = useCallback(async () => {
    const [tr, ar] = await Promise.all([
      fetch('/api/tasks').then(r=>r.json()),
      fetch('/api/agents').then(r=>r.json()),
    ]);
    if (tr.ok) setTasks(tr.tasks);
    if (ar.ok) setAgents(ar.agents.filter((a:Agent)=>a.is_lead));
  }, []);

  useEffect(() => {
    fetch('/api/auth/me').then(r=>{ if(!r.ok) router.replace('/login'); else reload(); })
      .catch(()=>router.replace('/login'));
  }, [reload, router]);

  // 실행중인 태스크가 있으면 3초마다 자동 갱신
  useEffect(() => {
    const hasRunning = tasks.some(t => t.status === 'running');
    if (!hasRunning) return;
    const iv = setInterval(reload, 3000);
    return () => clearInterval(iv);
  }, [tasks, reload]);

  const filtered = filter === 'all' ? tasks : tasks.filter(t=>t.status===filter);

  const del = async (id: string) => {
    if (!confirm('태스크를 삭제할까요?')) return;
    await fetch(`/api/tasks?id=${id}`, { method:'DELETE' });
    reload();
  };

  const runTask = async (task: Task) => {
    if (!task.agent_id || running[task.id]) return;
    setRunning(r=>({...r,[task.id]:true}));
    await fetch(`/api/tasks`, { method:'PATCH', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ id: task.id, status: 'running', result: '' }) });
    reload();

    const prompt = task.description ? `${task.title}\n\n${task.description}` : task.title;
    let full = '';
    try {
      const resp = await fetch(`/api/claude/${task.agent_id}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ message: prompt }) });
      const reader = resp.body!.getReader(); const dec = new TextDecoder();
      while (true) { const {done,value} = await reader.read(); if (done) break; full += dec.decode(value,{stream:true}); }
      await fetch(`/api/tasks`, { method:'PATCH', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ id: task.id, status: 'done', result: full.trim() }) });
    } catch(e) {
      await fetch(`/api/tasks`, { method:'PATCH', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ id: task.id, status: 'failed', result: String(e) }) });
    }
    setRunning(r=>({...r,[task.id]:false}));
    reload();
  };

  const fmt = (ts: number) => new Date(ts*1000).toLocaleString('ko-KR',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});

  return (
    <div style={{minHeight:'100vh',background:'var(--bg-canvas)'}}>
      {/* 헤더 */}
      <div style={{height:44,display:'flex',alignItems:'center',gap:12,padding:'0 24px',borderBottom:'1px solid var(--border)',background:'var(--bg-panel)',position:'sticky',top:0,zIndex:100}}>
        <a href="/" style={{fontSize:12,fontWeight:500,color:'var(--text-muted)',textDecoration:'none'}} onMouseOver={e=>e.currentTarget.style.color='var(--text-primary)'} onMouseOut={e=>e.currentTarget.style.color='var(--text-muted)'}>← 대시보드</a>
        <span style={{color:'var(--border)'}}>|</span>
        <span style={{fontSize:14,fontWeight:700,color:'var(--text-primary)'}}>태스크</span>
        <div style={{marginLeft:'auto',display:'flex',gap:8}}>
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
            style={{fontSize:12,fontWeight:500,color:'var(--text-secondary)',border:'1px solid var(--border)',padding:'5px 14px',borderRadius:4,cursor:'pointer',background:'transparent',fontFamily:'inherit',transition:'all .12s'}}
            onMouseOver={e=>{e.currentTarget.style.color='var(--danger)';e.currentTarget.style.borderColor='var(--danger)';}}
            onMouseOut={e=>{e.currentTarget.style.color='var(--text-secondary)';e.currentTarget.style.borderColor='var(--border)';}}
          >
            로그아웃
          </button>
          <button onClick={()=>setForm(true)} style={{fontSize:12,fontWeight:600,color:'#fff',background:'var(--accent)',border:'none',padding:'5px 14px',borderRadius:4,cursor:'pointer',fontFamily:'inherit'}}>+ 새 태스크</button>
        </div>
      </div>

      <div style={{padding:'24px 32px',maxWidth:960,margin:'0 auto'}}>
        {/* 상태 필터 */}
        <div style={{display:'flex',gap:6,marginBottom:20}}>
          {['all','pending','running','done','failed'].map(s=>(
            <button key={s} onClick={()=>setFilter(s)} style={{fontSize:11,fontWeight:600,padding:'4px 12px',borderRadius:4,border:'1px solid',cursor:'pointer',fontFamily:'inherit',
              borderColor: filter===s ? 'var(--accent)' : 'var(--border)',
              background: filter===s ? 'var(--accent-dim)' : 'transparent',
              color: filter===s ? 'var(--accent)' : 'var(--text-muted)'}}>
              {s==='all' ? '전체' : STATUS_LABEL[s]} {s!=='all' && <span style={{opacity:.7}}>({tasks.filter(t=>t.status===s).length})</span>}
            </button>
          ))}
        </div>

        {/* 태스크 목록 */}
        {filtered.length===0 && (
          <div style={{textAlign:'center',padding:'60px 0',color:'var(--text-muted)'}}>
            <div style={{fontSize:32,marginBottom:12}}>📋</div>
            <div style={{fontSize:13,fontWeight:600,color:'var(--text-secondary)',marginBottom:4}}>태스크가 없습니다</div>
            <div style={{fontSize:11}}>새 태스크를 만들어 에이전트에게 업무를 부여하세요</div>
          </div>
        )}

        <div style={{display:'flex',flexDirection:'column',gap:8}}>
          {filtered.map(task=>{
            const agent = agents.find(a=>a.id===task.agent_id);
            const isMission = task.description?.startsWith('[미션]');
            const missionSource = isMission ? task.description.slice(4).trim() : null;
            return (
              <div key={task.id} style={{background:'var(--bg-panel)',border:'1px solid var(--border)',borderRadius:6,overflow:'hidden',borderLeft:`3px solid ${STATUS_COLOR[task.status]}`}}>
                <div style={{display:'flex',alignItems:'center',padding:'12px 16px',gap:10}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:3}}>
                      {isMission && <span style={{fontSize:9,fontWeight:700,padding:'1px 6px',borderRadius:3,background:'#7c3aed22',color:'#a78bfa',border:'1px solid #7c3aed44',flexShrink:0}}>미션</span>}
                      <div style={{fontSize:13,fontWeight:600,color:'var(--text-primary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{task.title}</div>
                    </div>
                    {missionSource && <div style={{fontSize:10,color:'var(--text-muted)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginBottom:2}}>↳ {missionSource}</div>}
                    {!isMission && task.description && <div style={{fontSize:11,color:'var(--text-secondary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{task.description}</div>}
                    <div style={{display:'flex',alignItems:'center',gap:8,marginTop:5}}>
                      <span style={{fontSize:10,fontWeight:600,padding:'2px 7px',borderRadius:3,background:STATUS_BG[task.status],color:STATUS_COLOR[task.status],border:`1px solid ${STATUS_COLOR[task.status]}44`}}>
                        {running[task.id] ? '⟳ 실행중' : STATUS_LABEL[task.status]}
                      </span>
                      {task.agent_name && <span style={{fontSize:11,color:'var(--text-muted)'}}>{task.agent_name}</span>}
                      {!task.agent_name && agent && <span style={{fontSize:11,color:'var(--text-muted)'}}>{agent.emoji} {agent.name}</span>}
                      <span style={{fontSize:10,color:'var(--text-muted)'}}>{fmt(task.created_at)}</span>
                    </div>
                  </div>
                  <div style={{display:'flex',gap:6,flexShrink:0}}>
                    {task.result && <button onClick={()=>setDetail(task)} style={{fontSize:11,fontWeight:500,color:'var(--accent)',background:'var(--accent-dim)',border:'1px solid var(--accent)44',padding:'4px 10px',borderRadius:4,cursor:'pointer',fontFamily:'inherit'}}>결과 보기</button>}
                    {task.agent_id && task.status!=='running' && !running[task.id] && !isMission && (
                      <button onClick={()=>runTask(task)} style={{fontSize:11,fontWeight:600,color:'#fff',background:'var(--success)',border:'none',padding:'4px 12px',borderRadius:4,cursor:'pointer',fontFamily:'inherit'}}>▶ 실행</button>
                    )}
                    <button onClick={()=>del(task.id)} style={{fontSize:11,color:'var(--text-muted)',background:'none',border:'1px solid var(--border)',padding:'4px 8px',borderRadius:4,cursor:'pointer',fontFamily:'inherit'}} onMouseOver={e=>e.currentTarget.style.color='var(--danger)'} onMouseOut={e=>e.currentTarget.style.color='var(--text-muted)'}>✕</button>
                  </div>
                </div>
                {/* 실행 결과 인라인 미리보기 */}
                {task.result && task.status==='done' && (
                  <div style={{padding:'8px 16px 12px',borderTop:'1px solid var(--border-subtle)',background:'var(--bg-elevated)'}}>
                    <div style={{fontSize:11,color:'var(--text-secondary)',whiteSpace:'pre-wrap',lineHeight:1.6,maxHeight:80,overflow:'hidden',maskImage:'linear-gradient(to bottom, black 60%, transparent 100%)'}}>{task.result.slice(0,300)}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 새 태스크 모달 */}
      {form && <AddTaskModal agents={agents} onClose={()=>setForm(false)} onDone={()=>{setForm(false);reload();}} />}

      {/* 결과 상세 */}
      {detail && (
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.7)',backdropFilter:'blur(3px)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:9000}} onClick={()=>setDetail(null)}>
          <div style={{background:'var(--bg-panel)',border:'1px solid var(--border)',borderRadius:8,padding:24,width:'min(700px,90vw)',maxHeight:'80vh',display:'flex',flexDirection:'column',boxShadow:'0 24px 80px rgba(0,0,0,.6)'}} onClick={e=>e.stopPropagation()}>
            <div style={{fontSize:14,fontWeight:700,color:'var(--text-primary)',marginBottom:4}}>{detail.title}</div>
            <div style={{fontSize:11,color:'var(--text-muted)',marginBottom:16}}>{fmt(detail.updated_at)} · {STATUS_LABEL[detail.status]}</div>
            <div style={{flex:1,overflow:'auto',fontSize:12,color:'var(--text-secondary)',whiteSpace:'pre-wrap',lineHeight:1.8,background:'var(--bg-elevated)',borderRadius:4,padding:16,border:'1px solid var(--border-subtle)'}}>{detail.result}</div>
            <button onClick={()=>setDetail(null)} style={{marginTop:16,fontSize:12,fontWeight:600,color:'var(--text-secondary)',background:'none',border:'1px solid var(--border)',padding:'7px 0',borderRadius:4,cursor:'pointer',fontFamily:'inherit'}}>닫기</button>
          </div>
        </div>
      )}
    </div>
  );
}

function AddTaskModal({ agents, onClose, onDone }: { agents:Agent[]; onClose:()=>void; onDone:()=>void }) {
  const [title, setTitle]   = useState('');
  const [desc,  setDesc]    = useState('');
  const [agentId, setAgentId] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState('');

  const submit = async () => {
    if (!title.trim()) { setErr('제목을 입력하세요'); return; }
    setLoading(true); setErr('');
    try {
      const agent = agents.find(a=>a.id===agentId);
      const r = await fetch('/api/tasks', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ title, description: desc, agent_id: agentId||null, agent_name: agent?.name||null }) });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error);
      onDone();
    } catch(e:any) { setErr(e.message||'오류'); }
    setLoading(false);
  };

  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.6)',backdropFilter:'blur(2px)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:9000}}>
      <div style={{background:'var(--bg-panel)',border:'1px solid var(--border)',borderRadius:8,padding:24,width:480,display:'flex',flexDirection:'column',gap:14,boxShadow:'0 16px 48px rgba(0,0,0,.5)'}}>
        <div style={{fontSize:14,fontWeight:700,color:'var(--text-primary)',paddingBottom:12,borderBottom:'1px solid var(--border)'}}>📋 새 태스크</div>

        <label style={{display:'flex',flexDirection:'column',gap:5,fontSize:11,fontWeight:600,color:'var(--text-secondary)'}}>제목
          <input className="modal-input" value={title} onChange={e=>setTitle(e.target.value)} autoFocus onKeyDown={e=>e.key==='Enter'&&submit()} placeholder="에이전트에게 시킬 작업" />
        </label>

        <label style={{display:'flex',flexDirection:'column',gap:5,fontSize:11,fontWeight:600,color:'var(--text-secondary)'}}>상세 설명 (선택)
          <textarea className="modal-input" value={desc} onChange={e=>setDesc(e.target.value)} placeholder="구체적인 지시사항..." rows={4} style={{resize:'vertical',lineHeight:1.6}} />
        </label>

        <label style={{display:'flex',flexDirection:'column',gap:5,fontSize:11,fontWeight:600,color:'var(--text-secondary)'}}>담당 에이전트 (선택)
          <select className="modal-input" value={agentId} onChange={e=>setAgentId(e.target.value)}>
            <option value="">— 에이전트 없이 저장 —</option>
            {agents.map(a=><option key={a.id} value={a.id}>{a.emoji} {a.name}</option>)}
          </select>
        </label>

        {err && <div style={{color:'var(--danger)',fontSize:11,padding:'6px 10px',background:'var(--danger-dim)',borderRadius:4}}>{err}</div>}

        <div style={{display:'flex',gap:8,marginTop:4}}>
          <button onClick={onClose} style={{flex:1,fontSize:12,fontWeight:600,color:'var(--text-secondary)',background:'none',border:'1px solid var(--border)',padding:'8px',borderRadius:4,cursor:'pointer',fontFamily:'inherit'}}>취소</button>
          <button onClick={submit} disabled={loading} style={{flex:2,fontSize:12,fontWeight:600,color:'#fff',background:'var(--accent)',border:'none',padding:'8px',borderRadius:4,cursor:'pointer',fontFamily:'inherit',opacity:loading?.7:1}}>{loading?'저장중...':'저장'}</button>
        </div>
      </div>
    </div>
  );
}
