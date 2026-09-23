/**
 * Server-side environment variable validation.
 * Call validateEnv() once at startup to surface missing vars clearly.
 * Never import this file from client components.
 */

export interface EnvConfig {
  NEXT_PUBLIC_APP_URL: string
  NEXT_PUBLIC_SUPABASE_URL: string
  NEXT_PUBLIC_SUPABASE_ANON_KEY: string
  SUPABASE_SERVICE_ROLE_KEY: string
  OPENAI_API_KEY: string
  OPENAI_MODEL: string
  SUBMISSION_ENCRYPTION_KEY: string
  SESSION_SECRET: string
  CRON_SECRET: string
  DEMO_MODE: boolean
  WHATSAPP_ACCESS_TOKEN?: string
  WHATSAPP_PHONE_NUMBER_ID?: string
  WHATSAPP_API_VERSION?: string
  RESEND_API_KEY?: string
  EMAIL_FROM?: string
  LIVE_MEDIATION_ENABLED: boolean
  LIVE_MEDIATION_ALLOWED_EMAILS: string
  OPENAI_REALTIME_MODEL: string
  OPENAI_REALTIME_TRANSCRIBE_MODEL: string
  OPENAI_REALTIME_VOICE: string
  OPENAI_REALTIME_TRANSCRIBE_LANGUAGES: string
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  RAZORPAY_KEY_ID?: string
  RAZORPAY_KEY_SECRET?: string
  MEETING_MEDIATION_ENABLED: boolean
  MEETING_MEDIATION_ALLOWED_EMAILS: string
  RECALL_API_KEY?: string
  RECALL_API_BASE_URL: string
  RECALL_WEBHOOK_SECRET?: string
  RECALL_WEBHOOK_URL?: string
  RECALL_BOT_NAME: string
}

const REQUIRED_VARS = [
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUBMISSION_ENCRYPTION_KEY',
  'SESSION_SECRET',
  'CRON_SECRET',
] as const

export function validateEnv(): void {
  const demoMode = process.env['DEMO_MODE'] === 'true'

  const missing: string[] = []

  for (const key of REQUIRED_VARS) {
    if (!process.env[key]) {
      missing.push(key)
    }
  }

  if (!demoMode && !process.env['OPENAI_API_KEY']) {
    missing.push('OPENAI_API_KEY')
  }

  if (missing.length > 0) {
    console.error('\n❌ Missing required environment variables:\n')
    missing.forEach((v) => console.error(`  • ${v}`))
    console.error('\nCopy .env.example to .env.local and fill in the values.\n')
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
    }
  }

  const encKey = process.env['SUBMISSION_ENCRYPTION_KEY']
  if (encKey && !/^[0-9a-f]{64}$/i.test(encKey)) {
    throw new Error('SUBMISSION_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).')
  }
}

export function getEnv(): EnvConfig {
  return {
    NEXT_PUBLIC_APP_URL: process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000',
    NEXT_PUBLIC_SUPABASE_URL: process.env['SUPABASE_URL'] ?? process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ?? '',
    SUPABASE_SERVICE_ROLE_KEY: process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '',
    OPENAI_API_KEY: process.env['OPENAI_API_KEY'] ?? '',
    OPENAI_MODEL: process.env['OPENAI_MODEL'] ?? 'gpt-4o',
    SUBMISSION_ENCRYPTION_KEY: process.env['SUBMISSION_ENCRYPTION_KEY'] ?? '',
    SESSION_SECRET: process.env['SESSION_SECRET'] ?? '',
    CRON_SECRET: process.env['CRON_SECRET'] ?? '',
    DEMO_MODE: process.env['DEMO_MODE'] === 'true',
    WHATSAPP_ACCESS_TOKEN: process.env['WHATSAPP_ACCESS_TOKEN'],
    WHATSAPP_PHONE_NUMBER_ID: process.env['WHATSAPP_PHONE_NUMBER_ID'],
    WHATSAPP_API_VERSION: process.env['WHATSAPP_API_VERSION'] ?? 'v21.0',
    RESEND_API_KEY: process.env['RESEND_API_KEY'],
    EMAIL_FROM: process.env['EMAIL_FROM'],
    STRIPE_SECRET_KEY: process.env['STRIPE_SECRET_KEY'],
    STRIPE_WEBHOOK_SECRET: process.env['STRIPE_WEBHOOK_SECRET'],
    RAZORPAY_KEY_ID: process.env['RAZORPAY_KEY_ID'],
    RAZORPAY_KEY_SECRET: process.env['RAZORPAY_KEY_SECRET'],
    LIVE_MEDIATION_ENABLED: process.env['LIVE_MEDIATION_ENABLED'] === 'true',
    LIVE_MEDIATION_ALLOWED_EMAILS: process.env['LIVE_MEDIATION_ALLOWED_EMAILS'] ?? '',
    OPENAI_REALTIME_MODEL: process.env['OPENAI_REALTIME_MODEL'] ?? 'gpt-realtime-2.1',
    // Defaults to the broadly-available transcription model, not the diarization
    // variant — confirmed against a real account that 'gpt-4o-transcribe-diarize'
    // access is not universal ("Your organization does not have access to this
    // transcription model"). Diarization is already designed as best-effort
    // throughout Room Mode (see roomPrompt.ts's calibration step) — set this env
    // var explicitly to 'gpt-4o-transcribe-diarize' for accounts that do have access.
    OPENAI_REALTIME_TRANSCRIBE_MODEL: process.env['OPENAI_REALTIME_TRANSCRIBE_MODEL'] ?? 'gpt-4o-transcribe',
    OPENAI_REALTIME_VOICE: process.env['OPENAI_REALTIME_VOICE'] ?? process.env['OPENAI_TTS_VOICE'] ?? 'marin',
    // Comma-separated ISO-639-1 codes the transcriber may pick between. Defaults to
    // English + Hindi: Room Mode is used bilingually, and leaving this unconstrained
    // made real room audio get transcribed as Icelandic/Japanese. Set to a single
    // code to pin one language, or empty to leave it fully unconstrained.
    OPENAI_REALTIME_TRANSCRIBE_LANGUAGES: process.env['OPENAI_REALTIME_TRANSCRIBE_LANGUAGES'] ?? 'en,hi',
    MEETING_MEDIATION_ENABLED: process.env['MEETING_MEDIATION_ENABLED'] === 'true',
    MEETING_MEDIATION_ALLOWED_EMAILS: process.env['MEETING_MEDIATION_ALLOWED_EMAILS'] ?? '',
    RECALL_API_KEY: process.env['RECALL_API_KEY'],
    RECALL_API_BASE_URL: process.env['RECALL_API_BASE_URL'] ?? 'https://us-east-1.recall.ai/api/v1',
    RECALL_WEBHOOK_SECRET: process.env['RECALL_WEBHOOK_SECRET'],
    RECALL_WEBHOOK_URL: process.env['RECALL_WEBHOOK_URL'],
    RECALL_BOT_NAME: process.env['RECALL_BOT_NAME'] ?? 'Urushi — AI Mediator',
  }
}
