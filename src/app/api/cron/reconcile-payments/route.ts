import { NextRequest, NextResponse } from 'next/server'
import { liveDeps, reconcilePayments } from '@/lib/billing/reconcile'

/**
 * The reconciliation pass, on a schedule.
 *
 * Exists because a paid Stripe purchase sat `pending` for an hour granting
 * nothing — the production Worker was missing STRIPE_WEBHOOK_SECRET, so the
 * webhook refused every delivery — and the only reason anyone found out is that
 * a human was watching the screen. See src/lib/billing/reconcile.ts for what it
 * compares and why.
 *
 * Both verbs, because whichever scheduler ends up calling this may use either,
 * and a 405 at 3am would be a silent failure of the endpoint whose whole purpose
 * is to end silent failures.
 *
 * NOTE ON SCHEDULING: the `triggers.crons` entry in wrangler.jsonc only fires if
 * the deployed Worker exports a `scheduled` handler, and OpenNext's generated
 * worker currently exports `fetch` only. Until a custom entrypoint wraps it,
 * this needs an external scheduler calling the URL with the Bearer header below.
 */
async function handle(req: NextRequest) {
  // Same pattern as /api/cases/[id]/analyse, so there is one cron secret and one
  // way to rotate it. The difference: there is no fallback identity here. An
  // unset secret refuses rather than opening up, matching the rest of billing —
  // an unauthenticated endpoint that reads payment state and grants credits
  // would be a worse bug than the one this job fixes.
  const cronSecret = process.env['CRON_SECRET']
  const authHeader = req.headers.get('authorization')

  if (!cronSecret) {
    console.error('[reconcile-payments] CRON_SECRET is not set — refusing to run.')
    return NextResponse.json({ error: 'Not configured.' }, { status: 503 })
  }

  if (authHeader !== `Bearer ${cronSecret}`) {
    console.warn('[reconcile-payments] Rejected an unauthenticated request.')
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  try {
    const report = await reconcilePayments(liveDeps())

    // Logged only when there is something to say. A clean pass writes nothing,
    // so that a line in this log always means a real finding rather than
    // something to scroll past; Cloudflare's own observability already records
    // that the invocation happened.
    if (report.settled.length > 0 || report.needsHuman.length > 0 || report.errors.length > 0) {
      console.warn(`[reconcile-payments]\n${report.lines.join('\n')}`)
    }

    // `headline` and `lines` come first deliberately: this body is the report,
    // read by a person hitting the URL, not just a machine-readable result.
    return NextResponse.json(
      {
        headline: report.headline,
        lines: report.lines,
        window: report.window,
        checked: report.checked,
        truncated: report.truncated,
        settled: report.settled,
        needsHuman: report.needsHuman,
        errors: report.errors,
      },
      // A 200 with findings would let a scheduler's own failure alerting stay
      // quiet about the serious case. Anything a human must look at answers 500.
      { status: report.needsHuman.length > 0 || report.errors.length > 0 ? 500 : 200 }
    )
  } catch (err) {
    // Only reached when the pass itself could not run — loading payments failed,
    // or Supabase is unreachable. Per-payment failures are collected in the
    // report instead, so one bad row cannot hide the others.
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[reconcile-payments] Pass failed to run: ${message}`)
    return NextResponse.json({ error: 'Reconciliation failed to run.', detail: message }, { status: 500 })
  }
}

export const GET = handle
export const POST = handle
