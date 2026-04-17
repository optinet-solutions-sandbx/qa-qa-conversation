import { NextResponse } from 'next/server';
import { getConversationById } from '@/lib/db';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const conversation = await getConversationById(id);
    if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ conversation });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
