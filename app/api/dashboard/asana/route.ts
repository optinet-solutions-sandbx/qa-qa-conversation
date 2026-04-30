import { NextRequest, NextResponse } from 'next/server';
import { dbGetAsanaReportingMetrics } from '@/lib/db';
import { isAsanaConfigured } from '@/lib/asana';

// Reporting metrics for the AM action-items dashboard. Pivots are done in JS
// against the conversations table — see dbGetAsanaReportingMetrics for the
// exact shape. Optional query params (from, to, am, severity) narrow the
// row set; the report page sends these from its filter bar.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const filters = {
    from: sp.get('from'),
    to: sp.get('to'),
    am: sp.get('am'),
    severity: sp.get('severity'),
  };

  try {
    const metrics = await dbGetAsanaReportingMetrics(filters);
    return NextResponse.json({
      configured: isAsanaConfigured(),
      projectGid: process.env.ASANA_PROJECT_GID ?? null,
      ...metrics,
    });
  } catch (e) {
    return NextResponse.json(
      {
        configured: isAsanaConfigured(),
        projectGid: process.env.ASANA_PROJECT_GID ?? null,
        totalTickets: 0,
        openTickets: 0,
        closedTickets: 0,
        ticketsByAm: [],
        ticketsBySeverity: [],
        ticketsByCategory: [],
        ticketsByDate: [],
        closuresByDate: [],
        lastSyncedAt: null,
        error: (e as Error).message,
      },
      { status: 500 },
    );
  }
}
