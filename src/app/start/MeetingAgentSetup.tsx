'use client'

/**
 * Agent configuration step of the Meeting Mediation setup flow (spec §18).
 *
 * Deliberately lightweight: two personality cards, then compact pill groups. The
 * Language row only appears for the Indian region, and Language style only for
 * Straight Shooter, so the page never shows more than the current choice implies.
 */

import type {
  AgentLanguage,
  InterventionLevel,
  LanguageStyle,
  MeetingAgentSettings,
  MeetingPersonality,
  VoiceGender,
  VoiceRegion,
} from '@/lib/meeting/agentSettings'

interface Props {
  settings: MeetingAgentSettings
  onChange: (next: MeetingAgentSettings) => void
}

const PERSONALITY_CARDS: Array<{
  value: MeetingPersonality
  title: string
  description: string
  icon: string
  preview: string
}> = [
  {
    value: 'chair',
    title: 'Chair',
    description: 'Confident, composed and decisive. Keeps conversations structured, surfaces tensions and pushes the group toward decisions.',
    icon: 'gavel',
    preview: '“Let’s separate the two issues before we decide.”',
  },
  {
    value: 'straight_shooter',
    title: 'Straight Shooter',
    description: 'Blunt, fast and hard to bullshit. Calls out dodging, contradictions and unnecessary drama so you can resolve things quickly.',
    icon: 'bolt',
    preview: '“You’re arguing around the issue. Let’s get to what you actually disagree about.”',
  },
]

const INTERVENTION_OPTIONS: Array<{
  value: InterventionLevel
  title: string
  description: string
  recommended?: boolean
}> = [
  { value: 'observer', title: 'Observer', description: 'Mostly listens. Speaks when invited or when something important needs attention.' },
  { value: 'facilitator', title: 'Facilitator', description: 'Naturally joins the conversation, redirects discussions and intervenes when useful.', recommended: true },
  { value: 'chair', title: 'Chair the meeting', description: 'Actively controls the discussion, interrupts when necessary and drives the group toward decisions.' },
]

const LANGUAGE_OPTIONS: Array<{ value: AgentLanguage; label: string; hint: string; recommended?: boolean }> = [
  { value: 'english', label: 'English', hint: 'Urushi speaks English.' },
  { value: 'hindi', label: 'Hindi', hint: 'Conversational Hindi, not textbook Hindi.' },
  { value: 'hinglish', label: 'Hinglish', hint: 'The Hindi/English mix urban professionals actually use.' },
  { value: 'auto', label: 'Auto-switch', hint: 'Follows whichever language the room is speaking.', recommended: true },
]

const PROFANITY_OPTIONS: Array<{ value: LanguageStyle; label: string; hint: string; recommended?: boolean }> = [
  { value: 'clean', label: 'Off', hint: 'Urushi never swears — even if participants do.' },
  { value: 'direct', label: 'Mild', hint: 'Will say “bullshit” or “crap” when calling something out.', recommended: true },
  { value: 'unfiltered', label: 'Strong', hint: 'Stronger language too, aimed at arguments — never at people.' },
]

function Pill<T extends string>({
  active, onClick, children, ariaLabel,
}: { active: boolean; onClick: () => void; children: React.ReactNode; ariaLabel?: string; value?: T }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
      className={`px-4 h-11 rounded-full border-2 font-label-md transition-all ${
        active
          ? 'border-primary bg-primary-container/30 text-primary font-semibold'
          : 'border-outline-variant bg-surface-container-lowest text-on-surface-variant hover:border-primary/40'
      }`}
    >
      {children}
    </button>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="font-label-sm text-outline uppercase tracking-widest mb-2 ml-1">{children}</p>
}

export function MeetingAgentSetup({ settings, onChange }: Props) {
  function update<K extends keyof MeetingAgentSettings>(key: K, value: MeetingAgentSettings[K]) {
    const next = { ...settings, [key]: value }
    // Chair has no profanity control — keep the stored value coherent with the UI.
    if (key === 'personality' && value === 'chair') next.languageStyle = 'clean'
    onChange(next)
  }

  const activePreview = PERSONALITY_CARDS.find((c) => c.value === settings.personality)?.preview

  return (
    <div className="space-y-6">
      <div>
        <SectionLabel>How should Urushi run this meeting?</SectionLabel>
        <div className="space-y-3">
          {PERSONALITY_CARDS.map((card) => {
            const active = settings.personality === card.value
            return (
              <button
                key={card.value}
                type="button"
                onClick={() => update('personality', card.value)}
                aria-pressed={active}
                className={`w-full text-left rounded-2xl border-2 p-5 transition-all ${
                  active
                    ? 'border-primary bg-primary-container/20'
                    : 'border-outline-variant bg-surface-container-lowest hover:border-primary/40'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${active ? 'bg-primary' : 'bg-surface-container-low'}`}>
                    <span
                      className={`material-symbols-outlined text-[20px] ${active ? 'text-white' : 'text-on-surface-variant'}`}
                      style={{ fontVariationSettings: "'FILL' 1" }}
                    >
                      {card.icon}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`font-headline-sm mb-1 ${active ? 'text-primary' : 'text-on-surface'}`}>{card.title}</p>
                    <p className="font-body-md text-on-surface-variant leading-snug">{card.description}</p>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
        {activePreview && (
          <p className="text-label-sm text-outline italic mt-3 ml-1 leading-snug">{activePreview}</p>
        )}
      </div>

      <div>
        <SectionLabel>Voice</SectionLabel>
        <div className="flex gap-2 flex-wrap">
          {(['female', 'male'] as VoiceGender[]).map((g) => (
            <Pill key={g} active={settings.voiceGender === g} onClick={() => update('voiceGender', g)}>
              {g === 'female' ? 'Female' : 'Male'}
            </Pill>
          ))}
        </div>
      </div>

      <div>
        <SectionLabel>Region</SectionLabel>
        <div className="flex gap-2 flex-wrap">
          {([
            ['american', 'American'],
            ['singaporean', 'Singaporean'],
            ['indian', 'Indian'],
          ] as Array<[VoiceRegion, string]>).map(([value, label]) => (
            <Pill key={value} active={settings.region === value} onClick={() => update('region', value)}>
              {label}
            </Pill>
          ))}
        </div>
      </div>

      {settings.region === 'indian' && (
        <div>
          <SectionLabel>Language</SectionLabel>
          <div className="flex gap-2 flex-wrap">
            {LANGUAGE_OPTIONS.map((opt) => (
              <Pill key={opt.value} active={settings.language === opt.value} onClick={() => update('language', opt.value)}>
                {opt.label}
                {opt.recommended && <span className="ml-1.5 text-[11px] opacity-70">Recommended</span>}
              </Pill>
            ))}
          </div>
          <p className="text-label-sm text-outline mt-2 ml-1 leading-snug">
            {LANGUAGE_OPTIONS.find((o) => o.value === settings.language)?.hint}
          </p>
        </div>
      )}

      <div>
        <SectionLabel>How actively should Urushi intervene?</SectionLabel>
        <div className="space-y-2">
          {INTERVENTION_OPTIONS.map((opt) => {
            const active = settings.interventionLevel === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => update('interventionLevel', opt.value)}
                aria-pressed={active}
                className={`w-full text-left rounded-xl border-2 p-4 transition-all ${
                  active
                    ? 'border-primary bg-primary-container/20'
                    : 'border-outline-variant bg-surface-container-lowest hover:border-primary/40'
                }`}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <p className={`font-label-md font-semibold ${active ? 'text-primary' : 'text-on-surface'}`}>{opt.title}</p>
                  {opt.recommended && (
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-secondary-container text-on-secondary-container">
                      Recommended
                    </span>
                  )}
                </div>
                <p className="font-label-sm text-on-surface-variant leading-snug">{opt.description}</p>
              </button>
            )
          })}
        </div>
      </div>

      {settings.personality === 'straight_shooter' && (
        <div>
          <SectionLabel>Profanity</SectionLabel>
          <div className="flex gap-2 flex-wrap">
            {PROFANITY_OPTIONS.map((opt) => (
              <Pill key={opt.value} active={settings.languageStyle === opt.value} onClick={() => update('languageStyle', opt.value)}>
                {opt.label}
                {opt.recommended && <span className="ml-1.5 text-[11px] opacity-70">Recommended</span>}
              </Pill>
            ))}
          </div>
          <p className="text-label-sm text-outline mt-2 ml-1 leading-snug">
            {PROFANITY_OPTIONS.find((o) => o.value === settings.languageStyle)?.hint}
          </p>
        </div>
      )}
    </div>
  )
}
