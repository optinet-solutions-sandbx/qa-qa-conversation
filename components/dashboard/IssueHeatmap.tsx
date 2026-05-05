'use client';

import { Fragment } from 'react';

// Reusable 2D heatmap grid for the Weekly + Daily/Hourly issue widgets.
// Both widgets share the same shape (rows × cols of integer counts) — only the
// labels and palette differ — so this component handles both.

interface HeatmapProps {
  rows: { key: string; label: string }[];
  cols: { key: string; label: string }[];
  getValue: (rowKey: string, colKey: string) => number;
  /** When true, draws the numeric count inside every cell (used by Daily/Hourly). */
  showCounts?: boolean;
  /** Visual palette family. Picked to match the spec mockup roughly. */
  palette?: 'cyan' | 'magenta';
  /** Width reserved for the leftmost row-label column. */
  rowLabelWidth?: string;
  cellHeight?: string;
  /** Optional click handler — receives the raw row/col keys. */
  onCellClick?: (rowKey: string, colKey: string, value: number, e: React.MouseEvent) => void;
}

// Two palettes — both run from a deep cool baseline up to a hot/saturated end,
// so they read against either a white or near-black surface. The Weekly Heat
// Map uses `cyan` (cool blue → orange/yellow accent) and the Daily/Hourly map
// uses `magenta` (deep navy → magenta), matching the spec mockup.
const PALETTES: Record<NonNullable<HeatmapProps['palette']>, string[]> = {
  cyan:    ['#1e3a8a', '#1d4ed8', '#0ea5e9', '#22d3ee', '#facc15', '#fb923c', '#f472b6'],
  magenta: ['#1e1b4b', '#312e81', '#4338ca', '#6d28d9', '#a21caf', '#c026d3', '#f472b6'],
};

function pickShade(t: number, shades: string[]): string {
  // Empty cells use a CSS variable so the baseline fades against the parent
  // surface (light mode: pale slate; dark mode: nearly transparent navy).
  if (t <= 0) return 'var(--heatmap-empty, #f1f5f9)';
  const idx = Math.min(shades.length - 1, Math.floor(t * shades.length));
  return shades[idx];
}

export default function IssueHeatmap({
  rows,
  cols,
  getValue,
  showCounts = false,
  palette = 'cyan',
  rowLabelWidth = '160px',
  cellHeight = '28px',
  onCellClick,
}: HeatmapProps) {
  const shades = PALETTES[palette];
  let max = 1;
  for (const r of rows) {
    for (const c of cols) {
      const v = getValue(r.key, c.key);
      if (v > max) max = v;
    }
  }

  return (
    <div className="overflow-x-auto">
      <div
        className="grid gap-px text-[10px]"
        style={{ gridTemplateColumns: `${rowLabelWidth} repeat(${cols.length}, minmax(22px, 1fr))` }}
      >
        <div />
        {cols.map((c) => (
          <div key={c.key} className="font-medium text-slate-400 text-center pb-1 truncate">{c.label}</div>
        ))}
        {rows.map((r) => (
          <Fragment key={r.key}>
            <div
              className="font-medium text-slate-600 truncate pr-2 flex items-center"
              style={{ height: cellHeight }}
              title={r.label}
            >
              {r.label}
            </div>
            {cols.map((c) => {
              const v = getValue(r.key, c.key);
              const t = v / max;
              const bg = pickShade(t, shades);
              // White on any populated cell — the palettes start at a deep-cool
              // shade so white reads cleanly against every step. Empty cells
              // don't render text so their fg colour doesn't matter.
              const fg = '#ffffff';
              // Glow halo on hover — `--cell-color` is set inline so the box-shadow
              // picks up each cell's own gradient shade (cells share the same
              // hover class but glow in their own colour). Skipped for v=0 cells
              // so the empty grid background doesn't light up.
              const glowable = v > 0;
              return (
                <div
                  key={c.key}
                  className={`rounded-sm flex items-center justify-center transition-shadow duration-150 ${onCellClick ? 'cursor-pointer' : ''} ${glowable ? 'hover:shadow-[0_0_14px_var(--cell-color),0_0_4px_var(--cell-color)]' : ''}`}
                  style={{ background: bg, height: cellHeight, color: fg, ['--cell-color' as string]: bg } as React.CSSProperties}
                  onClick={onCellClick ? (e) => onCellClick(r.key, c.key, v, e) : undefined}
                  onMouseDown={onCellClick ? (e) => { if (e.button === 1) { e.preventDefault(); onCellClick(r.key, c.key, v, e); } } : undefined}
                  title={`${r.label} · ${c.label}: ${v}`}
                >
                  {showCounts && v > 0 ? v : ''}
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
