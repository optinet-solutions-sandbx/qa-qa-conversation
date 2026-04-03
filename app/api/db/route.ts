import { NextResponse } from 'next/server';
import {
  dbInsertConversation,
  dbUpdateConversation,
  dbDeleteConversation,
  dbInsertNote,
  dbUpdateNote,
  dbDeleteNote,
  dbInsertPrompt,
  dbUpdatePrompt,
  dbDeletePrompt,
  dbActivatePrompt,
  loadFromSupabase,
} from '@/lib/db';

export async function GET() {
  const data = await loadFromSupabase();
  if (!data) return NextResponse.json(null, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: Request) {
  const { action, payload } = await req.json();

  switch (action) {
    case 'insertConversation':  await dbInsertConversation(payload); break;
    case 'updateConversation':  await dbUpdateConversation(payload); break;
    case 'deleteConversation':  await dbDeleteConversation(payload.id); break;
    case 'insertNote':          await dbInsertNote(payload.convId, payload.note); break;
    case 'updateNote':          await dbUpdateNote(payload); break;
    case 'deleteNote':          await dbDeleteNote(payload.id); break;
    case 'insertPrompt':        await dbInsertPrompt(payload); break;
    case 'updatePrompt':        await dbUpdatePrompt(payload); break;
    case 'deletePrompt':        await dbDeletePrompt(payload.id); break;
    case 'activatePrompt':      await dbActivatePrompt(payload.id); break;
    default:
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
