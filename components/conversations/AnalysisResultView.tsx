'use client';

import type { AnalysisResult } from '@/lib/types';

interface Props {
  result: AnalysisResult;
}

const severityColors: Record<string, string> = {
  Low: 'bg-green-100 text-green-700',
  Medium: 'bg-amber-100 text-amber-700',
  High: 'bg-red-100 text-red-700',
  Critical: 'bg-red-200 text-red-800 font-bold',
};

const resolutionColors: Record<string, string> = {
  Resolved: 'bg-green-100 text-green-700',
  'Partially Resolved': 'bg-amber-100 text-amber-700',
  Unresolved: 'bg-red-100 text-red-700',
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="py-2 pr-4 text-xs font-medium text-slate-500 whitespace-nowrap align-top w-40">
        {label}
      </td>
      <td className="py-2 text-sm text-slate-800">{value}</td>
    </tr>
  );
}

export default function AnalysisResultView({ result }: Props) {
  return (
    <div className="bg-slate-50 rounded-lg border border-slate-200 p-4">
      <table className="w-full">
        <tbody>
          <Row label="Language" value={result.language?.toUpperCase() || '—'} />
          <Row
            label="Severity"
            value={
              <span
                className={`inline-flex px-2 py-0.5 rounded-full text-xs ${severityColors[result.dissatisfaction_severity] || 'bg-slate-100 text-slate-600'}`}
              >
                {result.dissatisfaction_severity || '—'}
              </span>
            }
          />
          <Row label="Issue Category" value={result.issue_category || '—'} />
          <Row
            label="Resolution"
            value={
              <span
                className={`inline-flex px-2 py-0.5 rounded-full text-xs ${resolutionColors[result.resolution_status] || 'bg-slate-100 text-slate-600'}`}
              >
                {result.resolution_status || '—'}
              </span>
            }
          />
          <Row label="Summary" value={result.summary || '—'} />
          {result.key_quotes && (
            <Row
              label="Key Quotes"
              value={
                <span className="italic text-slate-600">&ldquo;{result.key_quotes}&rdquo;</span>
              }
            />
          )}
          <Row
            label="Agent Score"
            value={
              result.agent_performance_score !== null && result.agent_performance_score !== undefined
                ? `${result.agent_performance_score}/5 — ${result.agent_performance_notes}`
                : result.agent_performance_notes || '—'
            }
          />
          <Row label="Recommended Action" value={result.recommended_action || '—'} />
          <Row
            label="Alert"
            value={
              result.is_alert_worthy ? (
                <span className="text-red-600 font-medium">
                  ⚠ {result.alert_reason || 'Alert flagged'}
                </span>
              ) : (
                <span className="text-slate-400">No alert</span>
              )
            }
          />
        </tbody>
      </table>
    </div>
  );
}
