/**
 * Whether a freshly-named issue is one the room is already discussing.
 *
 * Exact-match then substring-match was the first attempt, and it held for the
 * obvious repeats ("Workload" vs "Workload distribution"). It does not hold for
 * the way the model actually re-names things as a conversation grows: a session
 * produced "Workload and Decision-Making" and then "Workload, Decision-Making,
 * and Time Management" — plainly the same dispute, neither a substring of the
 * other, so both were filed. The final report is built from these rows, so a
 * duplicate is not cosmetic; it reports one argument as two unresolved issues.
 *
 * Token overlap rather than string distance, because the failure is additive
 * (the same nouns plus a new one) rather than a typo. Edit distance scores those
 * two titles as far apart, which is exactly wrong here.
 */

/** Words that carry no topical meaning and would inflate every comparison. */
const STOPWORDS = new Set([
  'and', 'or', 'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'with', 'about',
  'issue', 'issues', 'problem', 'problems', 'dispute', 'disagreement', 'topic',
  'ka', 'ki', 'ke', 'aur', 'hai', 'ho', 'mein', 'par',
])

export function issueTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  )
}

/**
 * Overlap relative to the SMALLER title, not to the union.
 *
 * "Workload" against "Workload, Decision-Making, and Time Management" is a
 * complete match of everything the shorter title claims to be about, and should
 * score 1 — a union-based score would call it 0.25 and file a duplicate, which
 * is the bug this exists to prevent.
 */
export function issueSimilarity(a: string, b: string): number {
  const ta = issueTokens(a)
  const tb = issueTokens(b)
  if (ta.size === 0 || tb.size === 0) return 0

  let shared = 0
  for (const t of ta) if (tb.has(t)) shared++
  return shared / Math.min(ta.size, tb.size)
}

/**
 * Tuned to merge readily. Filing a second row for one dispute corrupts the
 * report and has actually happened repeatedly; attaching a genuinely new issue
 * to an existing row is recoverable, and the room will say so out loud.
 */
export const ISSUE_MATCH_THRESHOLD = 0.6

/**
 * A much lower bar for the issue the room is CURRENTLY on.
 *
 * 0.6 could not catch the real sequence, which was one dispute renamed as its
 * scope grew: "Workload Split" then "Workload and Time Management" then "Time
 * Management and Workload Imbalance". A two-token title sharing one token with a
 * three-token title scores exactly 0.5 and can never reach 0.6, so all three
 * were filed and one argument appeared in the report as three unresolved
 * issues.
 *
 * Lowering the GLOBAL threshold to catch it would merge genuinely different
 * disputes that happen to share a word ("holiday scheduling" and "workload
 * scheduling" also score 0.5). The asymmetry is the point: a room discusses one
 * thing at a time, so a new title that overlaps the issue already open is far
 * more likely to be that issue under a longer name than a second dispute
 * appearing in the same breath.
 */
export const CURRENT_ISSUE_MATCH_THRESHOLD = 0.34

export interface MatchableIssue {
  id: string
  title: string
}

/**
 * The issue this title refers to, or null if it is genuinely new.
 *
 * `currentIssueId` is the issue the room is already discussing, which is held to
 * the lower bar above.
 */
export function findMatchingIssue<T extends MatchableIssue>(
  title: string,
  existing: readonly T[],
  currentIssueId?: string | null
): T | null {
  const normalized = title.trim().toLowerCase()
  if (!normalized) return null

  let best: T | null = null
  let bestScore = 0

  for (const candidate of existing) {
    const other = String(candidate.title).trim().toLowerCase()
    if (other === normalized || other.includes(normalized) || normalized.includes(other)) {
      return candidate
    }

    const score = issueSimilarity(normalized, other)
    const threshold = candidate.id === currentIssueId
      ? CURRENT_ISSUE_MATCH_THRESHOLD
      : ISSUE_MATCH_THRESHOLD

    // Compared against its own threshold rather than picking the highest scorer
    // and testing afterwards, so a weak match on the open issue still wins over
    // a slightly stronger one on an issue the room has moved past.
    if (score >= threshold && score > bestScore) {
      bestScore = score
      best = candidate
    }
  }

  return best
}
