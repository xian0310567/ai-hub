import path from 'path';
import fs from 'fs';

const BASE = path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw');

const LEGACY_AGENTS = [
  { id: 'cofounder',      name: '포지',  emoji: '🔨', workspace: 'workspace-cofounder' },
  { id: 'zesty_claw_bot', name: '클로',  emoji: '🐾', workspace: 'workspace-zesty' },
  { id: 'insta',          name: '유나',  emoji: '✨', workspace: 'workspace-insta' },
  { id: 'quant',          name: '퀀트',  emoji: '📈', workspace: 'workspace-quant' },
  { id: 'quant-kr',       name: '코스모', emoji: '📊', workspace: 'workspace-quant-kr' },
  { id: 'pod',            name: 'POD',  emoji: '📦', workspace: 'workspace-pod' },
];

// GET /api/agents/available — workspace 존재 여부 포함
export async function GET() {
  const result = LEGACY_AGENTS.map(a => ({
    ...a,
    available: fs.existsSync(path.join(BASE, a.workspace)),
  }));
  return Response.json({ ok: true, agents: result });
}
