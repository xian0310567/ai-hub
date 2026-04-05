import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pipelineBase = (global as any).__pipelineBase as string;
  const prompts = (global as any).__subagentPrompts as Record<string, string>;

  if (!pipelineBase || !prompts) return NextResponse.json({ ok: false, error: 'server not ready' });
  const filename = prompts[id];
  if (!filename) return NextResponse.json({ ok: false, error: 'unknown prompt id' });

  try {
    const content = fs.readFileSync(path.join(pipelineBase, filename), 'utf8');
    return NextResponse.json({ ok: true, filename, content });
  } catch {
    return NextResponse.json({ ok: false, error: 'file not found' });
  }
}
