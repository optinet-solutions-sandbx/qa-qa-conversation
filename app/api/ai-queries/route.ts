import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { dbGetAiQueries, dbDeleteAiQuery } from '@/lib/db';

// ── GET: list history ─────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const page    = parseInt(req.nextUrl.searchParams.get('page')    ?? '0',  10);
  const perPage = parseInt(req.nextUrl.searchParams.get('perPage') ?? '25', 10);
  try {
    const { queries, total } = await dbGetAiQueries(page, perPage);
    return NextResponse.json({ queries, total, page, perPage });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

// ── DELETE: remove one query ──────────────────────────────────────────────

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  try {
    await dbDeleteAiQuery(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
