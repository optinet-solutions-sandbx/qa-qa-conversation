'use client';

import type { AnalysisResult } from '@/lib/types';

interface Props {
  result: AnalysisResult;
  // ISO timestamp from our DB (intercom_created_at). When provided, it overrides
  // the AI's `conversation_date` field — the model never sees the real date in
  // its prompt, so any value it emits there is fabricated from transcript
  // content or training data and shouldn't be trusted as factual metadata.
  conversationDate?: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Try to parse a string as a date; return formatted string or null
function tryFormatDate(value: string): string | null {
  if (!/\d{4}/.test(value)) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
}

// Strip markdown code fences if present
function stripCodeFences(text: string): string {
  return text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
}

// ── Value renderers ───────────────────────────────────────────────────────────

function PrimitiveValue({ value }: { value: string | number | boolean | null }) {
  if (value === null || value === undefined) {
    return <span className="text-slate-300">—</span>;
  }
  if (typeof value === 'boolean') {
    return (
      <span className={`font-medium ${value ? 'text-emerald-600' : 'text-slate-400'}`}>
        {value ? 'Yes' : 'No'}
      </span>
    );
  }
  if (typeof value === 'string') {
    const formatted = tryFormatDate(value);
    if (formatted) return <span>{formatted}</span>;
  }
  return <span>{String(value)}</span>;
}

function ArrayValue({ items }: { items: unknown[] }) {
  if (items.length === 0) return <span className="text-slate-300">—</span>;

  // Array of objects → sub-table
  if (typeof items[0] === 'object' && items[0] !== null && !Array.isArray(items[0])) {
    const rows = items as Record<string, unknown>[];
    const keys = Object.keys(rows[0]);
    return (
      <div className="mt-1 rounded-lg border border-slate-200 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              {keys.map((k) => (
                <th key={k} className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-widest text-slate-400">
                  {formatKey(k)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row, i) => (
              <tr key={`row-${i}`}>
                {keys.map((k) => (
                  <td key={k} className="px-3 py-2 text-slate-700 break-words min-w-0 max-w-[200px]">
                    <PrimitiveValue value={row[k] as string | number | boolean | null} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // Array of primitives → numbered list
  return (
    <ol className="space-y-1 mt-0.5 list-none">
      {items.map((item, i) => (
        <li key={`item-${i}`} className="flex gap-2.5 items-start">
          <span className="shrink-0 w-4 h-4 rounded-full bg-slate-100 text-slate-400 text-[10px] flex items-center justify-center mt-0.5 font-medium">
            {i + 1}
          </span>
          <span className="text-slate-700 leading-snug">{String(item)}</span>
        </li>
      ))}
    </ol>
  );
}

function AnyValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) return <ArrayValue items={value} />;
  if (value !== null && typeof value === 'object') {
    // Nested object — render as indented sub-rows
    return (
      <div className="mt-1 pl-3 border-l-2 border-slate-100 space-y-2">
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <div key={k}>
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-0.5">{formatKey(k)}</div>
            <AnyValue value={v} />
          </div>
        ))}
      </div>
    );
  }
  return <PrimitiveValue value={value as string | number | boolean | null} />;
}

// ── Main table ────────────────────────────────────────────────────────────────

function JsonTable({ data }: { data: Record<string, unknown> }) {
  return (
    <table className="w-full">
      <tbody>
        {Object.entries(data).map(([key, value], i) => {
          const isComplex = Array.isArray(value) || (typeof value === 'object' && value !== null);
          return (
            <tr key={key} className={`${i < Object.keys(data).length - 1 ? 'border-b border-slate-100' : ''}`}>
              <td className="py-3 pr-6 text-[11px] font-semibold text-slate-400 uppercase tracking-wide align-top whitespace-nowrap w-36">
                {formatKey(key)}
              </td>
              <td className={`py-3 text-sm text-slate-800 ${isComplex ? 'align-top' : 'align-middle'}`}>
                <AnyValue value={value} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Root component ────────────────────────────────────────────────────────────

export default function AnalysisResultView({ result, conversationDate }: Props) {
  const cleaned = stripCodeFences(result.analysisText.trim());

  let parsed: Record<string, unknown> | null = null;
  try {
    const raw = JSON.parse(cleaned);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      parsed = raw as Record<string, unknown>;
    }
  } catch {
    // not JSON
  }

  if (parsed) {
    // The AI fabricates a conversation date because it isn't given the real
    // one in its prompt. Strip every variant it might emit (snake_case,
    // camelCase, "Conversation Date" with a space, "date", "chat date"…)
    // and substitute the real intercom_created_at from our DB when we have it.
    const norm = (k: string) => k.toLowerCase().replace(/[\s_-]/g, '');
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const n = norm(k);
      if (n === 'conversationdate' || n === 'chatdate' || n === 'date') continue;
      next[k] = v;
    }
    if (conversationDate) next.conversation_date = conversationDate;
    parsed = next;
    return (
      <div className="bg-white rounded-xl border border-slate-200 px-4 py-1 overflow-hidden min-w-0">
        <JsonTable data={parsed} />
      </div>
    );
  }

  // Plain text fallback
  return (
    <div className="bg-slate-50 rounded-xl border border-slate-200 p-4">
      <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
        {cleaned}
      </p>
    </div>
  );
}
