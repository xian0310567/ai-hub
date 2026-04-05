import { NextResponse } from 'next/server';
import { Api } from 'telegram';

export async function GET(_req: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const getTgClient = (global as any).__tgClient as () => any;
  const botUsernames = (global as any).__botUsernames as Record<string, string>;

  if (!getTgClient || !getTgClient()) return NextResponse.json({ ok: false, messages: [] });
  const client = getTgClient();
  const username = botUsernames[agentId];
  if (!username) return NextResponse.json({ ok: false, messages: [] });

  try {
    const result = await client.getMessages(username, { limit: 50 }) as any[];
    const messages = result.map((m: any) => ({
      id: m.id,
      text: m.message || '',
      date: m.date,
      out: m.out || false,
    })).reverse();
    return NextResponse.json({ ok: true, messages });
  } catch (e) {
    return NextResponse.json({ ok: false, messages: [], error: String(e) });
  }
}
