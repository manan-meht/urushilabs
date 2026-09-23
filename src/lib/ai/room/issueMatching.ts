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
 * Deliberately low, and the same for every issue in the session.
 *
 * This started at 0.6 with a lower bar for the issue currently open, on the
 * theory that a title overlapping the OPEN issue is probably a rename while one
 * overlapping a closed issue might be a genuine second dispute. Two rounds of
 * replay evidence say otherwise. 0.6 never once prevented a bad merge, and it
 * twice failed to prevent duplicates — "Missed deadline and date agreement"
 * against "Missed deadline and communication breakdown" scores 0.5, and
 * "Workload imbalance and decision-making" against "Workload and Time
 * Management" scores 0.33. Both are plainly the same argument.
 *
 * The two-tier version also had a hole that only showed up live:
 * MOVE_TO_NEXT_ISSUE sets current_issue_id to NULL, so after the room moved on
 * once, nothing was "current" and every subsequent title was compared at the
 * strict threshold. One replay produced three rows for one dispute.
 *
 * The cost is asymmetric. A duplicate corrupts the final report, which is the
 * artefact participants actually keep; over-merging loses a distinction the room
 * will restate out loud anyway. Every multi-row case observed so far has been a
 * rename, never two genuine disputes named in the same breath.
 */
export const ISSUE_MATCH_THRESHOLD = 0.3

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
/**
 * Kept as a named export for callers, but now equal to the general threshold.
 *
 * 0.3, not 0.34: two three-token titles sharing one token score exactly 1/3 —
 * "Workload and Time Management" against "Workload and Decision-Making", a real
 * pair this system produced — and a threshold of 0.34 excluded it by seven
 * thousandths.
 */
export const CURRENT_ISSUE_MATCH_THRESHOLD = ISSUE_MATCH_THRESHOLD

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

/** What to do with the issue title a decision carried. */
export type IssueOutcome =
  | { kind: 'reuse'; id: string }
  | { kind: 'create' }
  | { kind: 'none' }

export interface IssueDecisionInput {
  action: string
  title?: string
  existing: readonly MatchableIssue[]
  currentIssueId?: string | null
}

/**
 * Whether a decision's issue title should open an issue, attach to one, or be
 * ignored.
 *
 * Extracted from the route because the previous version of this rule was a
 * single `action === 'IDENTIFY_ISSUE'` check that silently discarded the title
 * on every other action — and being one clause inside a long handler, nothing
 * tested it and nothing noticed. Across 16 replays a session ended up with an
 * issue row if and only if the model happened to choose that one action.
 *
 * Recognising is deliberately wider than creating. Any spoken turn may attach to
 * an issue already open, but only IDENTIFY_ISSUE may open a SECOND one: a
 * passing label on a verdict is not a new dispute, and treating it as one
 * re-creates the duplicate rows this module exists to prevent.
 */
export function decideIssueOutcome(input: IssueDecisionInput): IssueOutcome {
  const { action, title, existing, currentIssueId } = input

  if (action === 'LISTEN' || !title || !title.trim()) return { kind: 'none' }

  const match = findMatchingIssue(title, existing, currentIssueId)
  if (match) return { kind: 'reuse', id: match.id }

  // `existing.length === 0`, not `!currentIssueId`. MOVE_TO_NEXT_ISSUE nulls
  // current_issue_id, so "nothing is open" is true again every time the room
  // moves on — and any passing label then opened another row. One replay
  // produced three rows for one dispute that way.
  if (action === 'IDENTIFY_ISSUE' || existing.length === 0) return { kind: 'create' }

  return { kind: 'none' }
}
