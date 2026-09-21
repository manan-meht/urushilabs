/**
 * Replays a scripted conversation through the REAL mediation endpoint and prints
 * what Urushi would say.
 *
 * Exists because the feedback loop was minutes per data point: create a session
 * in the browser, pair a device, sit in a room, speak, wait, read a log. That is
 * an unaffordable price for "does it still ask the same question three times?",
 * and it is why behaviour changes kept being verified once and then assumed.
 *
 * Deliberately drives POST /intervene over HTTP rather than calling the prompt
 * builder directly. Most of the defects found in live testing were NOT in the
 * prompt — the cooldown measuring from the wrong row, issues being filed twice,
 * moving on being recorded as agreement, a pause claiming the turn. A harness
 * that stopped at the prompt would have reproduced none of them.
 *
 * Usage:
 *   npx vite-node scripts/replay.mts scripts/conversations/workload.txt
 *   npx vite-node scripts/replay.mts <file> --personality diplomat
 *   npx vite-node scripts/replay.mts <file> --pace 20     # slower conversation
 *   npx vite-node scripts/replay.mts <file> --delay 9000  # stay under the TPM limit
 *   npx vite-node scripts/replay.mts <file> --profanity --base https://urushilabs.com
 *
 * Script format — one line per event, read like a transcript:
 *   Manan: Maine Friday bola tha.        a participant utterance
 *   [pause 8]                            the room goes quiet for 8s
 *   [wait 45]                            45s pass on top of the usual pacing
 *   # anything                           comment
 *
 * The cast comes from the names in the file, so a script is self-contained.
 * Creates a scratch case per run and deletes it at the end, so nothing
 * accumulates and no real session is touched.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { generatePublicReference, generateSecureToken, hashToken } from '../src/lib/tokens'
import { SHARED_DEVICE_REF } from '../src/lib/conversation/acceptance'
import {
  conversationSettingsToRow,
  normalizeConversationSettings,
  type MediatorPersonality,
  type ConversationLanguage,
} from '../src/lib/conversation/settings'

// ─── args ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const scriptPath = argv.find((a) => !a.startsWith('--') && !isFlagValue(a))

function isFlagValue(arg: string): boolean {
  const i = argv.indexOf(arg)
  return i > 0 && argv[i - 1]!.startsWith('--')
}
function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

if (!scriptPath) {
  console.error('usage: vite-node scripts/replay.mts <conversation-file> [--personality X] [--language X] [--profanity] [--pace N] [--delay MS] [--base URL] [--keep]')
  process.exit(2)
}

const BASE = flag('base') ?? 'http://localhost:3000'
const PERSONALITY = (flag('personality') ?? 'straight_shooter') as MediatorPersonality
const LANGUAGE = (flag('language') ?? 'hinglish') as ConversationLanguage
const ALLOW_PROFANITY = argv.includes('--profanity')
/**
 * Seconds of conversation time one spoken line consumes.
 *
 * Without this every line lands milliseconds after the last, the cooldown swallows
 * the whole script, and the run tells you nothing except that the cooldown works.
 * The first run of this harness produced eight cooldown-LISTENs out of ten steps —
 * a result that looks exactly like a mediator bug and is purely an artefact of
 * replaying an eight-minute conversation in thirty seconds.
 */
const PACE = Number(flag('pace') ?? 12)
const KEEP = argv.includes('--keep')
/**
 * Milliseconds to wait between calls, to stay under the OpenAI tokens-per-minute
 * ceiling.
 *
 * Separate from --pace, which moves the cooldown clock and costs no real time.
 * The system prompt runs 4-6k tokens, so at a 30k TPM limit roughly five calls
 * per minute get through and the rest come back 429 — which the endpoint used to
 * turn into a lost turn, and which makes a replay look like a mediator that went
 * quiet. Throttling here keeps a test measuring the mediator rather than the
 * rate limiter.
 */
const DELAY_MS = Number(flag('delay') ?? 0)

// ─── env ─────────────────────────────────────────────────────────────────────

const env = Object.fromEntries(
  fs.readFileSync(path.resolve('.env.local'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!)

// ─── script parsing ──────────────────────────────────────────────────────────

interface Step {
  kind: 'say' | 'pause' | 'wait'
  speaker?: string
  text?: string
  seconds?: number
}

function parseScript(raw: string): Step[] {
  const steps: Step[] = []
  for (const [n, line] of raw.split('\n').entries()) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue

    const pause = t.match(/^\[pause\s+(\d+)\]$/i)
    if (pause) { steps.push({ kind: 'pause', seconds: Number(pause[1]) }); continue }

    const wait = t.match(/^\[wait\s+(\d+)\]$/i)
    if (wait) { steps.push({ kind: 'wait', seconds: Number(wait[1]) }); continue }

    const said = t.match(/^([^:]{1,30}):\s*(.+)$/)
    if (said) { steps.push({ kind: 'say', speaker: said[1]!.trim(), text: said[2]!.trim() }); continue }

    // Silently attributing a malformed line to someone would corrupt exactly the
    // attribution behaviour this harness is meant to check.
    throw new Error(`line ${n + 1}: expected "Name: text", [pause N] or [wait N] — got ${JSON.stringify(t)}`)
  }
  return steps
}

/** The cast, in order of first appearance. Room Mode allows 2 or 3. */
function castFrom(steps: Step[]): string[] {
  const names = [...new Set(steps.filter((s) => s.kind === 'say').map((s) => s.speaker!))]
  if (names.length < 2 || names.length > 3) {
    throw new Error(`room mode needs 2 or 3 speakers; this script has ${names.length}: ${names.join(', ') || '(none)'}`)
  }
  return names
}

// ─── scratch session ─────────────────────────────────────────────────────────

async function createScratchSession(names: string[], topic: string, context: string) {
  // Borrow an existing owner: cases.user_id is NOT NULL, and the owner only
  // matters for browser auth, which this harness does not use.
  const { data: owner, error: ownerErr } = await db
    .from('cases').select('user_id').not('user_id', 'is', null).limit(1).single()
  if (ownerErr || !owner) throw new Error('no existing case to borrow a user_id from')

  const settings = normalizeConversationSettings({
    personality: PERSONALITY,
    language: LANGUAGE,
    allowProfanity: ALLOW_PROFANITY,
  })

  const { data: caseRow, error: caseErr } = await db.from('cases').insert({
    public_reference: generatePublicReference(),
    topic,
    status: 'awaiting_initiator',
    initiator_name: names[0],
    recipient_name: names[1],
    recipient_phone: '',
    consent_version: '1.0',
    conversation_mode: 'room',
    user_id: owner.user_id,
    ...conversationSettingsToRow(settings),
  }).select('id').single()
  if (caseErr) throw new Error(`case: ${caseErr.message}`)

  const { data: sessionRow, error: sessErr } = await db.from('room_sessions').insert({
    case_id: caseRow!.id,
    // Straight to 'live': consent is a human step this harness is not testing.
    stage: 'live',
    participant_count: names.length,
    topic,
    context_summary: context,
    started_at: new Date().toISOString(),
  }).select('id').single()
  if (sessErr) throw new Error(`session: ${sessErr.message}`)

  const { data: participants, error: partErr } = await db.from('room_participants').insert(
    names.map((name, i) => ({
      session_id: sessionRow!.id,
      case_id: caseRow!.id,
      participant_index: i + 1,
      name,
    }))
  ).select('id, name')
  if (partErr) throw new Error(`participants: ${partErr.message}`)

  // The shared-device acceptance, so profanity is actually PERMITTED rather than
  // merely configured — the distinction the acceptance layer exists for, and one
  // that silently degrades to "off" if skipped.
  if (ALLOW_PROFANITY) {
    const { error: acceptErr } = await db.from('conversation_settings_acceptances').insert({
      case_id: caseRow!.id,
      participant_ref: SHARED_DEVICE_REF,
      settings_version: settings.version,
      accepted_profanity: true,
    })
    if (acceptErr) throw new Error(`acceptance: ${acceptErr.message}`)
  }

  const token = generateSecureToken()
  const { error: devErr } = await db.from('room_devices').insert({
    user_id: owner.user_id,
    session_id: sessionRow!.id,
    case_id: caseRow!.id,
    device_token_hash: hashToken(token),
    label: 'replay-harness',
  })
  if (devErr) throw new Error(`device: ${devErr.message}`)

  const idByName = new Map((participants ?? []).map((p) => [p.name as string, p.id as string]))
  return { caseId: caseRow!.id, sessionId: sessionRow!.id, token, settings, idByName }
}

/**
 * Moves the cooldown clock without actually waiting. The cooldown is measured
 * from triggered_at, so backdating past interventions is equivalent to time
 * passing — and keeps a whole conversation replayable in seconds.
 */
async function advanceClock(sessionId: string, seconds: number) {
  const { data: rows } = await db.from('room_interventions')
    .select('id, triggered_at').eq('session_id', sessionId)
  for (const r of rows ?? []) {
    const moved = new Date(new Date(r.triggered_at as string).getTime() - seconds * 1000).toISOString()
    await db.from('room_interventions').update({ triggered_at: moved }).eq('id', r.id)
  }
}

// ─── run ─────────────────────────────────────────────────────────────────────

const DIM = '\x1b[2m', RESET = '\x1b[0m', BOLD = '\x1b[1m', CYAN = '\x1b[36m', RED = '\x1b[31m'

async function main() {
  const raw = fs.readFileSync(path.resolve(scriptPath!), 'utf8')
  const steps = parseScript(raw)
  const names = castFrom(steps)

  // A "Topic:" / "Context:" header line, if the script provides one.
  const topic = raw.match(/^#\s*topic:\s*(.+)$/im)?.[1]?.trim() ?? 'REPLAY — scripted test conversation'
  const context = raw.match(/^#\s*context:\s*(.+)$/im)?.[1]?.trim() ?? ''

  const { caseId, sessionId, token, settings, idByName } =
    await createScratchSession(names, topic, context)

  console.log(`${DIM}${settings.personality} · ${settings.language} · profanity=${settings.allowProfanity} · ${names.join(', ')}${RESET}`)
  console.log(`${DIM}${BASE} · session ${sessionId}${RESET}\n`)

  let spoken = 0, listened = 0, failed = 0

  for (const step of steps) {
    if (step.kind === 'wait') {
      await advanceClock(sessionId, step.seconds!)
      console.log(`${DIM}    … ${step.seconds}s pass${RESET}`)
      continue
    }

    if (step.kind === 'say') {
      console.log(`${BOLD}${step.speaker}:${RESET} ${step.text}`)
    } else {
      console.log(`${DIM}    … room quiet for ${step.seconds}s${RESET}`)
    }

    // Time passes while someone speaks or the room sits quiet. Applied BEFORE the
    // call so the cooldown this utterance is judged against is the one it would
    // have faced live.
    await advanceClock(sessionId, step.kind === 'pause' ? step.seconds! : PACE)

    const body = step.kind === 'pause'
      ? { content: '', trigger: 'pause', silenceSeconds: step.seconds }
      : { content: step.text, trigger: 'utterance', speakerParticipantId: idByName.get(step.speaker!) }

    if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS))

    const res = await fetch(`${BASE}/api/room/sessions/${sessionId}/intervene`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      failed++
      console.log(`    ${RED}HTTP ${res.status}${RESET} ${DIM}${(await res.text()).slice(0, 200)}${RESET}`)
      continue
    }

    const { decision } = await res.json() as {
      decision: { action: string; reasoning: string; spokenText?: string }
    }

    if (decision.action === 'LISTEN') {
      listened++
      console.log(`    ${DIM}[listen] ${decision.reasoning}${RESET}`)
    } else {
      spoken++
      console.log(`    ${CYAN}Urushi${RESET} ${DIM}[${decision.action}]${RESET} ${decision.spokenText}`)
    }
  }

  const { data: issues } = await db.from('room_issues')
    .select('title, status').eq('session_id', sessionId)

  console.log(`\n${DIM}spoke ${spoken}× · listened ${listened}×${failed ? ` · ${failed} failed` : ''}${RESET}`)
  for (const i of issues ?? []) console.log(`${DIM}  issue: ${i.title} [${i.status}]${RESET}`)

  if (KEEP) {
    console.log(`\n${DIM}kept — ${BASE.replace(/\/$/, '')}/room/${sessionId}${RESET}`)
  } else {
    // Cascades to the session, participants, issues, interventions and segments.
    await db.from('cases').delete().eq('id', caseId)
  }

  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error(`${RED}${e.message}${RESET}`); process.exit(1) })
