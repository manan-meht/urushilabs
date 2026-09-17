# Meeting Mediation — Recall.ai setup guide

This is the checklist for connecting real Recall.ai credentials to the Meeting
Mediation feature that's already implemented in the codebase. Everything else —
setup flow, participant preparation, consent, session/state model, webhook
receiver, mediation controller, report generation, admin diagnostics — works
today without Recall credentials, in a clearly-labeled "not configured" state.

The implementation was built against Recall's public docs (docs.recall.ai) at
implementation time. A few specifics are called out below as **unconfirmed** —
verify those against your actual account/dashboard before going live, since
Recall's API can change and some behavior is account/plan-specific.

## 1. Create a Recall.ai account

Sign up at [recall.ai](https://www.recall.ai). Note **which region** your
workspace is created in — Recall's regions are fully data-isolated (separate
credentials, separate resources per region). The implementation defaults to
`us-east-1`; if your account is in a different region, you'll need to change
`RECALL_API_BASE_URL` (step 4).

## 2. What this implementation expects from Recall

- **Bot API** (`/api/v1/bot/`) — create/schedule a bot that joins a Google Meet
  or Zoom URL, and reports status changes.
- **Real-time webhooks** (`recording_config.realtime_endpoints`, set per-bot at
  creation time) — for transcript data and participant join/leave events.
- **Account-level webhook** (configured in the Recall dashboard) — for bot
  status-change events (joining, waiting room, in call, ended, error).
- **Output Audio** (`/api/v1/bot/{id}/output_audio/`) — for Urushi to speak
  into the meeting. Recall's docs describe this as clip-triggering (base64 MP3),
  not arbitrary real-time streaming; there is also an `/output_media/` endpoint
  documented for lower-latency conversational agent audio that this
  implementation has **not yet wired up** (see step 10 below — that's the main
  piece of real work left once you have a live account to test against).

## 3. API credential

In the Recall dashboard, generate an API key for your workspace/region.

## 4. Environment variables to add

Add these to your deployment's environment (Cloudflare: `wrangler secret put`
for the two secrets — **do not** put them in `wrangler.jsonc`'s plaintext
`vars` block, unlike the non-secret config below which already has placeholders
there):

| Variable | Secret? | Value |
|---|---|---|
| `RECALL_API_KEY` | **yes** — `wrangler secret put RECALL_API_KEY` | Your Recall API key |
| `RECALL_WEBHOOK_SECRET` | **yes** — `wrangler secret put RECALL_WEBHOOK_SECRET` | The signing secret shown when you create the dashboard webhook (step 5) — starts with `whsec_` |
| `RECALL_API_BASE_URL` | no | `https://us-east-1.recall.ai/api/v1` (or your account's region — see step 1) |
| `RECALL_WEBHOOK_URL` | no | `https://urushilabs.com/api/integrations/recall/webhook` |
| `RECALL_BOT_NAME` | no | `Urushi — AI Mediator` (already set — this is what participants see in the meeting, deliberately not "Recall") |
| `MEETING_MEDIATION_ENABLED` | no | `false` until you're ready to roll out; leave `MEETING_MEDIATION_ALLOWED_EMAILS` set to your own email(s) to test privately first |

`MEETING_MEDIATION_ENABLED`/`ALLOWED_EMAILS` and the non-secret Recall vars
already have entries in `wrangler.jsonc` and `.env.example` — only the two
secrets above need to be added by you.

## 5. Webhook URL to register

In the Recall dashboard, add an account-level webhook pointed at:

```
https://urushilabs.com/api/integrations/recall/webhook
```

This single endpoint (`src/app/api/integrations/recall/webhook/route.ts`)
handles both the account-level bot-status webhook and the per-bot real-time
webhook (the latter is registered automatically on every bot-creation request —
see `RecallMeetingBotProvider.createBot()` in
`src/lib/meeting/providers/recallProvider.ts`), so you only need to configure
the one dashboard webhook.

Copy the signing secret the dashboard shows you into `RECALL_WEBHOOK_SECRET`.

## 6. Webhook events required

**Account-level webhook** (dashboard) — subscribe to bot status-change events
(`bot.status_change`, covering all the sub-statuses: joining, waiting room, in
call, recording-permission, call ended, done, fatal).

**Per-bot real-time events** — already requested automatically on every
`createBot`/`scheduleBot` call:
`transcript.data`, `transcript.partial_data`, `participant_events.join`,
`participant_events.leave`, `participant_events.speech_on`,
`participant_events.speech_off`. Nothing to configure manually here.

## 7. Bot display-name configuration

Already handled — `RECALL_BOT_NAME` (default `Urushi — AI Mediator`) is passed
as `bot_name` on every bot-creation request. Participants will see this name in
the meeting, never "Recall" or "Recall.ai".

## 8. Google Meet requirements

Recall's Google Meet bots typically need no special account configuration on
your end for ad-hoc joins via a pasted link — the bot joins like any other
guest and may need to be admitted if the host has a waiting room enabled (this
shows up as Urushi's status `waiting_room` in the app). If your testing
account is a Google Workspace org with restricted guest access, you may need
to allow external participants for meetings Urushi should join.

## 9. Zoom requirements

Zoom meetings usually need **waiting room disabled or the bot pre-approved**,
or someone must manually admit the bot (same `waiting_room` status). If you
want Recall to join Zoom meetings that require a passcode, include the
passcode in the URL you paste into Meeting Mediation's meeting-link field
(Zoom's own share links normally already embed it).

## 10. Data retention / zero-retention settings (recommended)

Recall retains bot recordings/transcripts on their side by default. Since
Urushi ingests transcript segments and stores its own copy
(`meeting_transcript_segments` — plaintext, same reasoning as Live Mediation:
participants explicitly consented to Urushi processing the meeting), you
should configure Recall to **not** be a long-term system of record:

- In the Recall dashboard, look for **retention / auto-deletion settings**
  (media retention duration, or a "zero retention" / "delete after processing"
  option depending on your plan) and set it to the shortest period your plan
  allows.
- Do **not** enable Recall's video recording output unless you have a specific
  need for it — this implementation never requests video, only bot
  join/transcript/audio-output capabilities.
- Review Recall's own data processing agreement/region choice against Urushi's
  privacy policy before processing real user meetings.

## 11. How to test with a real Google Meet

1. Set `MEETING_MEDIATION_ENABLED=false` and put your own email in
   `MEETING_MEDIATION_ALLOWED_EMAILS` so only you see the feature.
2. Start a Google Meet call yourself (a solo test call works for basic
   join/leave testing).
3. Go through Meeting Mediation setup at `/start`, paste the `meet.google.com`
   link, choose "Start Urushi now".
4. Watch `/meeting/[reference]/status` for status transitions, and
   `/admin/meetings/[case-id]` (admin login required) for the raw webhook
   event log and provider bot ID.
5. Say something in the call — confirm a `meeting_transcript_segments` row
   appears (visible in the admin diagnostics view) and, for a non-trivial
   utterance, that the mediation controller ran (check
   `meeting_interventions`).

## 12. How to test with a real Zoom meeting

Same flow as above, using a `zoom.us` meeting link. Confirm the waiting-room
behavior (step 9) — Urushi's status should show `waiting_room` until admitted.

## 13. Diagnosing a bot stuck in the waiting room

- Check `/admin/meetings/[case-id]` — the webhook event log will show whether
  Recall is even sending `bot.in_waiting_room` and whether anything after that
  ever arrives.
- Someone with host permissions in the actual Google Meet/Zoom call needs to
  manually admit the bot from the participants list — same as any guest.
- If it's stuck with **no** webhook events at all arriving, first check
  `RECALL_WEBHOOK_URL` is publicly reachable (not `localhost`) and that the
  Recall dashboard webhook is enabled and pointed at the right URL.

## 14. Where to inspect logs / admin diagnostics

- **`/admin/meetings/[case-id]`** (requires admin login) — session status,
  provider bot ID, participants, recent interventions, recent transcript
  segments, and the raw webhook event log with any processing errors. This is
  the primary tool for debugging a live integration issue.
- **Cloudflare Workers logs** (`wrangler tail`, or the dashboard) — server-side
  `console.error` calls throughout `src/lib/meeting/` and
  `src/app/api/integrations/recall/webhook/` are prefixed for easy filtering
  (e.g. `[recall webhook]`, `[meeting pipeline]`).
- **`meeting_provider_events` table** — every webhook delivery is logged here
  raw, including any `error_message`, before/regardless of whether it's fully
  processed — useful for replaying/inspecting a payload directly in Supabase.

## 15. What still needs real-account work (not completable from the codebase alone)

- **Confirm exact API field names.** A few request/response shapes in
  `src/lib/meeting/providers/recallProvider.ts` are marked in a comment at the
  top of that file as "not independently confirmed" — specifically the
  `Authorization` header format, the leave-call endpoint, and the participants
  endpoint. Test against your live account and adjust if Recall's actual
  responses differ from what's implemented.
- **Real-time output audio.** `sendAudio()` currently calls the clip-trigger
  `/output_audio/` endpoint per intervention. For lower-latency, more natural
  barge-in-capable audio (spec: Urushi should be interruptible), evaluate
  Recall's `/output_media/` "AI Agent" endpoint once you can test against a
  live call — this is real, scoped follow-up work, not something fakeable
  without credentials.
- **Text-to-speech generation.** The pipeline (`src/lib/meeting/pipeline.ts`,
  `speakInMeeting()`) currently sends Urushi's intervention text via Recall's
  chat-message API as an interim/fallback delivery path, not spoken audio.
  Wire OpenAI TTS (or the Realtime API, matching Live Mediation's existing
  voice infrastructure in `src/lib/ai/realtime/`) into `sendAudio()`/
  `sendChatMessage()` once you're testing against real calls.
- **Speaker mapping accuracy.** Participant-to-provider mapping
  (`provider_participant_id`) is matched heuristically by display name on
  `participant_events.join` — verify this works reliably with real Google
  Meet/Zoom display names, especially when they don't exactly match the names
  entered at setup.
