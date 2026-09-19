import { z } from 'zod'

// ─── Relationship enum ─────────────────────────────────────────────────────────
export const RELATIONSHIP_OPTIONS = [
  'partner_or_spouse',
  'family_member',
  'friend',
  'colleague',
  'business_partner',
  'manager_or_employee',
  'other',
] as const

export type RelationshipType = typeof RELATIONSHIP_OPTIONS[number]

export const RELATIONSHIP_LABELS: Record<RelationshipType, string> = {
  partner_or_spouse: 'Partner or spouse',
  family_member: 'Family member',
  friend: 'Friend',
  colleague: 'Colleague',
  business_partner: 'Business partner',
  manager_or_employee: 'Manager or employee',
  other: 'Other',
}

// ─── Conversation settings (shared by every mode) ─────────────────────────────
// The runtime types and normalizer live in src/lib/conversation/settings.ts; this
// is the request-boundary schema. Both enforce the same profanity/personality
// invariant, deliberately — a request that slips past one is still caught by the
// other, and normalizeConversationSettings() remains the last word before any of
// this reaches prompt construction.
export const CONVERSATION_LANGUAGE_OPTIONS = ['english', 'hindi', 'hinglish'] as const
export const MEDIATOR_PERSONALITY_OPTIONS = ['diplomat', 'straight_shooter', 'deal_maker'] as const
export const TEXT_SCRIPT_OPTIONS = ['devanagari', 'roman'] as const

export const ConversationSettingsSchema = z.object({
  language: z.enum(CONVERSATION_LANGUAGE_OPTIONS).default('english'),
  personality: z.enum(MEDIATOR_PERSONALITY_OPTIONS).default('diplomat'),
  allowProfanity: z.boolean().default(false),
  textScript: z.enum(TEXT_SCRIPT_OPTIONS).optional(),
}).refine(
  (v) => !v.allowProfanity || v.personality === 'straight_shooter',
  { message: 'Strong language is only available with The Straight Shooter.', path: ['allowProfanity'] },
)
export type ConversationSettingsInput = z.infer<typeof ConversationSettingsSchema>

/**
 * Partial form, for changing one setting mid-conversation. Separate from
 * ConversationSettingsSchema because that one carries a .refine() and is
 * therefore a ZodEffects, which has no .partial(). The profanity invariant is
 * re-checked here, and again in normalizeConversationSettings().
 */
export const ConversationSettingsPatchSchema = z.object({
  language: z.enum(CONVERSATION_LANGUAGE_OPTIONS).optional(),
  personality: z.enum(MEDIATOR_PERSONALITY_OPTIONS).optional(),
  allowProfanity: z.boolean().optional(),
  textScript: z.enum(TEXT_SCRIPT_OPTIONS).optional(),
}).refine(
  (v) => !v.allowProfanity || v.personality === undefined || v.personality === 'straight_shooter',
  { message: 'Strong language is only available with The Straight Shooter.', path: ['allowProfanity'] },
)
export type ConversationSettingsPatchInput = z.infer<typeof ConversationSettingsPatchSchema>

/** Accepting (or declining) a specific version of the proposed settings. */
export const AcceptConversationSettingsSchema = z.object({
  settingsVersion: z.number().int().positive(),
  // Agreeing to the style is not agreeing to the swearing, so this is answered
  // separately rather than folded into `accepted`.
  acceptProfanity: z.boolean().default(false),
  decline: z.boolean().default(false),
})
export type AcceptConversationSettingsInput = z.infer<typeof AcceptConversationSettingsSchema>

// ─── Case creation ─────────────────────────────────────────────────────────────
export const CreateCaseSchema = z.object({
  recipientName: z
    .string()
    .trim()
    .min(1, "The other person's name is required.")
    .max(80),
  relationship: z.enum(RELATIONSHIP_OPTIONS).optional(),
  topic: z
    .string()
    .trim()
    .min(5, 'Please describe the topic in at least 5 characters.')
    .max(120, 'Topic must be 120 characters or fewer.'),
  consentVersion: z.string().optional().default('1.0'),
})

export type CreateCaseInput = z.infer<typeof CreateCaseSchema>

// ─── Intake message ────────────────────────────────────────────────────────────
export const IntakeMessageSchema = z.object({
  content: z.string().min(1).max(4000, 'Message is too long.'),
})

export type IntakeMessageInput = z.infer<typeof IntakeMessageSchema>

// ─── Intake complete ───────────────────────────────────────────────────────────
export const IntakeCompleteSchema = z.object({
  summary: z.string().min(10, 'Summary is too short.').max(16000),
  consented: z.literal(true, {
    errorMap: () => ({ message: 'You must consent to continue.' }),
  }),
})

export type IntakeCompleteInput = z.infer<typeof IntakeCompleteSchema>

// ─── Invitation acceptance ─────────────────────────────────────────────────────
export const AcceptInvitationSchema = z.object({
  recipientName: z.string().min(1, 'Please enter your name.').max(80).optional(),
})

export type AcceptInvitationInput = z.infer<typeof AcceptInvitationSchema>

// ─── Agreement response ────────────────────────────────────────────────────────
export const AgreementResponseSchema = z.object({
  agreementId: z.string().uuid(),
  response: z.enum(['agreed', 'needs_modification', 'not_agreed']),
  note: z.string().max(1000).optional(),
})

export type AgreementResponseInput = z.infer<typeof AgreementResponseSchema>

// ─── Together Mode ────────────────────────────────────────────────────────────
export const CreateTogetherSessionSchema = z.object({
  personAName: z.string().trim().min(1, 'Person A name is required.').max(80),
  personBName: z.string().trim().min(1, 'Person B name is required.').max(80),
  topic: z
    .string()
    .trim()
    .min(5, 'Please describe the topic in at least 5 characters.')
    .max(120, 'Topic must be 120 characters or fewer.'),
  relationship: z.enum(RELATIONSHIP_OPTIONS).optional(),
  deviceMode: z.enum(['shared', 'separate']).default('shared'),
})
export type CreateTogetherSessionInput = z.infer<typeof CreateTogetherSessionSchema>

export const TogetherConsentSchema = z.object({
  confirmedSafety: z.literal(true, {
    errorMap: () => ({ message: 'All participants must feel safe to continue.' }),
  }),
})
export type TogetherConsentInput = z.infer<typeof TogetherConsentSchema>

export const TogetherMessageSchema = z.object({
  content: z.string().min(1).max(4000, 'Message is too long.'),
  speaker: z.enum(['person_a', 'person_b']),
  replyToId: z.string().uuid().optional(),
  useReframe: z.boolean().optional(),
})
export type TogetherMessageInput = z.infer<typeof TogetherMessageSchema>

export const TogetherSummaryApprovalSchema = z.object({
  approvedSummary: z.string().min(1).max(4000),
})
export type TogetherSummaryApprovalInput = z.infer<typeof TogetherSummaryApprovalSchema>

export const TogetherReadinessSchema = z.object({
  speaker: z.enum(['person_a', 'person_b']),
})
export type TogetherReadinessInput = z.infer<typeof TogetherReadinessSchema>

export const TogetherIssueUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  status: z.enum(['pending', 'discussing', 'agreed', 'partial', 'unresolved', 'skipped']).optional(),
  resolution: z.string().max(2000).optional(),
})
export type TogetherIssueUpdateInput = z.infer<typeof TogetherIssueUpdateSchema>

export const TogetherOptionSchema = z.object({
  proposedBy: z.enum(['person_a', 'person_b', 'urushi']),
  description: z.string().min(1).max(2000),
})
export type TogetherOptionInput = z.infer<typeof TogetherOptionSchema>

export const TogetherOptionResponseSchema = z.object({
  speaker: z.enum(['person_a', 'person_b']),
  response: z.enum(['accept', 'accept_with_changes', 'reject', 'need_info']),
  note: z.string().max(1000).optional(),
})
export type TogetherOptionResponseInput = z.infer<typeof TogetherOptionResponseSchema>

// ─── Room Mode (Live Mediation) ────────────────────────────────────────────────
export const CreateRoomSessionSchema = z.object({
  participantNames: z
    .array(z.string().trim().min(1, 'Name is required.').max(80))
    .min(2, 'At least 2 participants are required.')
    .max(3, 'Live Mediation currently supports up to 3 participants.'),
  topic: z
    .string()
    .trim()
    .min(5, 'Please describe the topic in at least 5 characters.')
    .max(120, 'Topic must be 120 characters or fewer.'),
  contextSummary: z.string().trim().max(4000).optional(),
  sourceCaseReference: z.string().trim().max(40).optional(),
})
export type CreateRoomSessionInput = z.infer<typeof CreateRoomSessionSchema>

export const RoomConsentSchema = z.object({
  confirmedVoluntary: z.literal(true, { errorMap: () => ({ message: 'All participants must confirm.' }) }),
  confirmedAiMediator: z.literal(true, { errorMap: () => ({ message: 'All participants must confirm.' }) }),
  confirmedComfortableListening: z.literal(true, { errorMap: () => ({ message: 'All participants must confirm.' }) }),
  confirmedNoIntimidation: z.literal(true, { errorMap: () => ({ message: 'All participants must confirm.' }) }),
})
export type RoomConsentInput = z.infer<typeof RoomConsentSchema>

export const RoomCalibrateSchema = z.object({
  diarizationLabel: z.string().trim().min(1).max(20),
  confidence: z.number().min(0).max(1).optional(),
})
export type RoomCalibrateInput = z.infer<typeof RoomCalibrateSchema>

export const RoomInterveneSchema = z.object({
  content: z.string().trim().min(1).max(2000),
  speakerParticipantId: z.string().uuid().optional(),
  diarizationSpeakerLabel: z.string().max(20).optional(),
  speakerConfidence: z.number().min(0).max(1).optional(),
})
export type RoomInterveneInput = z.infer<typeof RoomInterveneSchema>

export const RoomAgreementConfirmSchema = z.object({
  participantId: z.string().uuid(),
})
export type RoomAgreementConfirmInput = z.infer<typeof RoomAgreementConfirmSchema>

export const PairRoomDeviceSchema = z.object({
  label: z.string().trim().max(80).optional(),
})
export type PairRoomDeviceInput = z.infer<typeof PairRoomDeviceSchema>

// ─── Meeting Mediation (Google Meet / Zoom, via a meeting-bot provider) ────────
const GOOGLE_MEET_URL_PATTERN = /^https:\/\/meet\.google\.com\/[a-z0-9-]+(\?.*)?$/i
const ZOOM_URL_PATTERN = /^https:\/\/([a-z0-9-]+\.)?zoom\.us\/(j|my|s)\/[a-zA-Z0-9?&=._-]+$/i

export function detectMeetingPlatform(url: string): 'google_meet' | 'zoom' | null {
  const trimmed = url.trim()
  if (GOOGLE_MEET_URL_PATTERN.test(trimmed)) return 'google_meet'
  if (ZOOM_URL_PATTERN.test(trimmed)) return 'zoom'
  return null
}

export const MeetingParticipantInputSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(80),
  email: z.string().trim().email('Please enter a valid email address.').max(200),
})
export type MeetingParticipantInput = z.infer<typeof MeetingParticipantInputSchema>

/**
 * How Urushi sounds and how often it intervenes in a meeting (see
 * src/lib/meeting/agentSettings.ts). Every field is optional so existing clients
 * that don't send it keep working — omitted fields resolve to
 * DEFAULT_MEETING_ONLY_AGENT_SETTINGS server-side.
 *
 * `personality`, `language` and `languageStyle` are NOT accepted here, even
 * though the meeting settings object still carries them. They are agreed once
 * for the whole conversation and arrive in the same request as
 * `conversationSettings`; accepting them in both places is what let a meeting
 * run as the Straight Shooter and be written up as the Diplomat. A stale client
 * that still sends them is not an error — zod strips unknown keys, so the shared
 * value simply wins.
 */
export const MeetingAgentSettingsSchema = z.object({
  voiceGender: z.enum(['female', 'male']).optional(),
  region: z.enum(['american', 'singaporean', 'indian']).optional(),
  interventionLevel: z.enum(['observer', 'facilitator', 'chair']).optional(),
})
export type MeetingAgentSettingsInput = z.infer<typeof MeetingAgentSettingsSchema>

export const CreateMeetingSessionSchema = z.object({
  participants: z
    .array(MeetingParticipantInputSchema)
    .min(2, 'At least 2 participants are required.')
    .max(3, 'Meeting Mediation currently supports up to 3 participants.'),
  topic: z
    .string()
    .trim()
    .min(5, 'Please describe the topic in at least 5 characters.')
    .max(120, 'Topic must be 120 characters or fewer.'),
  contextSummary: z.string().trim().max(4000).optional(),
  agentSettings: MeetingAgentSettingsSchema.optional(),
})
export type CreateMeetingSessionInput = z.infer<typeof CreateMeetingSessionSchema>

export const UpdateMeetingDetailsSchema = z.object({
  meetingUrl: z.string().trim().max(500).refine(
    (url) => detectMeetingPlatform(url) !== null,
    { message: 'Please enter a valid Google Meet or Zoom link.' }
  ),
  scheduledStartAt: z.string().datetime().optional(),
  timezone: z.string().max(80).optional(),
  startNow: z.boolean().default(false),
})
export type UpdateMeetingDetailsInput = z.infer<typeof UpdateMeetingDetailsSchema>

export const MeetingConsentSchema = z.object({
  confirmedAiMediator: z.literal(true, { errorMap: () => ({ message: 'All participants must confirm.' }) }),
  confirmedListeningAndProcessing: z.literal(true, { errorMap: () => ({ message: 'All participants must confirm.' }) }),
  confirmedMaySpeak: z.literal(true, { errorMap: () => ({ message: 'All participants must confirm.' }) }),
  confirmedVoluntary: z.literal(true, { errorMap: () => ({ message: 'All participants must confirm.' }) }),
})
export type MeetingConsentInput = z.infer<typeof MeetingConsentSchema>

export const MeetingParticipantContextSchema = z.object({
  perspective: z.string().trim().min(1, 'Please share at least a little context.').max(8000),
})
export type MeetingParticipantContextInput = z.infer<typeof MeetingParticipantContextSchema>

export const MeetingAgreementConfirmSchema = z.object({
  participantId: z.string().uuid(),
})
export type MeetingAgreementConfirmInput = z.infer<typeof MeetingAgreementConfirmSchema>

// ─── Feedback ─────────────────────────────────────────────────────────────────
export const ReportFeedbackSchema = z.object({
  representationRating: z.enum(['accurately', 'partly', 'not']),
  freeTextCorrection: z.string().max(2000).optional(),
  mostUsefulRecommendation: z.string().max(500).optional(),
  readyToTalkDirectly: z.boolean(),
})

export type ReportFeedbackInput = z.infer<typeof ReportFeedbackSchema>
