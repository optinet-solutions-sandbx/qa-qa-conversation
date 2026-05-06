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
  /** When true, the rightmost column header is rendered in an accent colour so
      "today / latest" reads at a glance. Used by the Weekly Heat Map. */
  highlightLastCol?: boolean;
  /** When true, renders a Low → High gradient strip below the grid, anchored
      with 0 and the dataset max so users can map shades to actual counts. */
  showLegend?: boolean;
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

// Pick legible text colour for a hex shade. Cyan/yellow/orange/pink shades at
// the hot end of the palettes are too light for white text; black reads better.
function fgForShade(hex: string): string {
  if (!hex.startsWith('#') || hex.length !== 7) return '#ffffff';
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return luminance > 0.6 ? '#0b0f17' : '#ffffff';
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
  highlightLastCol = false,
  showLegend = false,
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
        {cols.map((c, i) => {
          const isLast = highlightLastCol && i === cols.length - 1;
          return (
            <div
              key={c.key}
              className={`font-medium text-center pb-1 truncate ${isLast ? 'text-cyan-400 font-semibold' : 'text-slate-400'}`}
              style={isLast ? { textShadow: '0 0 8px rgba(34, 211, 238, 0.6)' } : undefined}
            >
              {c.label}
            </div>
          );
        })}
        {rows.map((r) => (
          <Fragment key={r.key}>
            <div
              className="font-medium text-slate-600 pr-2 flex items-center leading-tight"
              style={{ minHeight: cellHeight }}
              title={r.label}
            >
              {r.label}
            </div>
            {cols.map((c) => {
              const v = getValue(r.key, c.key);
              const t = v / max;
              const bg = pickShade(t, shades);
              // Pick text colour by cell luminance — the cyan palette runs into
              // bright yellow/orange/pink at the hot end where white text would
              // wash out. Empty cells don't render text so their fg is unused.
              const fg = fgForShade(bg);
              // Glow halo on hover — `--cell-color` is set inline so the box-shadow
              // picks up each cell's own gradient shade (cells share the same
              // hover class but glow in their own colour). Skipped for v=0 cells
              // so the empty grid background doesn't light up.
              const glowable = v > 0;
              return (
                <div
                  key={c.key}
                  className={`rounded-sm flex items-center justify-center transition-shadow duration-150 ${onCellClick ? 'cursor-pointer' : ''} ${glowable ? 'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] hover:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14),0_0_14px_var(--cell-color),0_0_4px_var(--cell-color)]' : ''}`}
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
      {showLegend && (
        <div
          className="mt-3 flex items-center gap-2 text-[10px] text-slate-400"
          style={{ paddingLeft: rowLabelWidth }}
        >
          <span>0</span>
          <div
            className="flex-1 h-1.5 rounded-full"
            style={{ background: `linear-gradient(to right, ${shades.join(', ')})` }}
          />
          <span className="text-slate-300">{max}</span>
        </div>
      )}
    </div>
  );
}
