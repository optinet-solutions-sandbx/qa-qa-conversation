import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { loadConversations, getConversationById } from '@/lib/db';

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (id) {
    try {
      const conversation = await getConversationById(id);
      if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      return NextResponse.json(conversation);
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  const page = parseInt(req.nextUrl.searchParams.get('page') ?? '0', 10);
  const perPage = parseInt(req.nextUrl.searchParams.get('perPage') ?? '24', 10);
  try {
    const result = await loadConversations(page, perPage);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
