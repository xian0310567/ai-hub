import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  const { agentId, text } = await req.json();
  const getTgClient = (global as any).__tgClient as () => any;
  const botUsernames = (global as any).__botUsernames as Record<string, string>;

  if (!getTgClient || !getTgClient()) return NextResponse.json({ ok: false, error: 'TG not connected' });
  const client = getTgClient();
  const username = botUsernames[agentId];
  if (!username) return NextResponse.json({ ok: false, error: 'unknown agent' });

  try {
    const result = await client.sendMessage(username, { message: text }) as any;
    return NextResponse.json({
      ok: true,
      message: { id: result.id, text, date: result.date, out: true },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) });
  }
}
