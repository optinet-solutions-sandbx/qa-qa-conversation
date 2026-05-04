// Escalation rule table — decides whether an analysed conversation should be
// pushed into Asana for the responsible Account Manager.
//
// Source of truth: "Player Dissatisfaction Categories — Escalation Rules"
// spreadsheet (see docs/Escalations - Player Dissatisfaction Categories -
// Escalation Rules.pdf). The matrix is keyed on (segment, severity, category):
//
//                         Severity 1 or 2          Severity 3
//                      SoftSwiss NON-VIP VIP   SoftSwiss NON-VIP VIP
//   1. Account Closure    NO       YES   YES     NO       YES   YES
//   2. Payments           NO       YES   YES     NO       YES   YES
//   3. Withdrawal Disp.   NO       YES   YES     NO       YES   YES
//   4. Player Experience  NO       YES   YES     NO       YES   YES
//   5. Verification       NO       YES   YES     NO       YES   YES
//   6. Bonus Codes        NO       NO    YES     NO       YES   YES
//   7. Technical          NO       NO    YES     NO       YES   YES
//   8. Sportsbook         NO       NO    YES     NO       YES   YES
//
// Distilled rules:
//   - SoftSwiss → never escalate.
//   - VIP       → always escalate (any category, any severity).
//   - NON-VIP   → severity 3 always escalates; severity 1/2 only escalates
//                 categories 1-5.
//
// Severity-3 special case (per product owner): if the AI returns a Level 3
// severity but no category/issue, escalate anyway — segment alone decides.
// Severity 1/2 without a category number cannot be matrix-checked so it does
// not escalate; this is intentional and erring on the side of fewer false-
// positives to AMs while we tighten the prompt.

import type { Segment } from './utils';
import { categoryNumPrefix, normalizeCategoryLabel } from './analyticsFilters';

export type SeverityLevel = 1 | 2 | 3;

const NONVIP_LEVEL12_CATEGORIES = new Set([1, 2, 3, 4, 5]);

export interface EscalationDecision {
  escalate: boolean;
  reason: string;
}

export function evaluateEscalation(
  segment: Segment | null,
  severity: SeverityLevel | null,
  categoryNumbers: number[],
): EscalationDecision {
  if (segment === 'SoftSwiss') {
    return { escalate: false, reason: 'softswiss-never-escalates' };
  }
  if (segment !== 'VIP' && segment !== 'NON-VIP') {
    return { escalate: false, reason: `unknown-segment:${segment ?? 'null'}` };
  }
  if (severity == null) {
    return { escalate: false, reason: 'no-severity-detected' };
  }

  if (severity === 3) {
    // Both VIP and NON-VIP escalate every category at severity 3, so the
    // category list does not gate the decision — including the case where the
    // AI didn't emit a category at all.
    return { escalate: true, reason: `${segment.toLowerCase()}-severity-3` };
  }

  // Severity 1 or 2 from here on.
  if (segment === 'VIP') {
    return { escalate: true, reason: 'vip-severity-12' };
  }

  // NON-VIP severity 1/2 — needs a recognised category in 1..5.
  if (categoryNumbers.length === 0) {
    return { escalate: false, reason: 'nonvip-severity-12-no-category' };
  }
  const matched = categoryNumbers.find((n) => NONVIP_LEVEL12_CATEGORIES.has(n));
  if (matched != null) {
    return { escalate: true, reason: `nonvip-severity-12-category-${matched}` };
  }
  return {
    escalate: false,
    reason: `nonvip-severity-12-categories-out-of-scope:${categoryNumbers.join(',')}`,
  };
}

export function severityToNumber(s: string | null | undefined): SeverityLevel | null {
  if (s == null) return null;
  const m = String(s).match(/[123]/);
  if (!m) return null;
  return parseInt(m[0], 10) as SeverityLevel;
}

// Maps a list of AI-emitted category labels (e.g. "1. Account Closure & Self-
// Exclusion Requests", "Category 6: Bonus Codes...") to their numeric prefixes
// 1-8. Labels without a recognisable "N." prefix are dropped — those can't be
// looked up in the matrix.
export function extractCategoryNumbers(rawCategories: string[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const c of rawCategories) {
    const n = categoryNumPrefix(normalizeCategoryLabel(c));
    if (n != null && n >= 1 && n <= 8 && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}
