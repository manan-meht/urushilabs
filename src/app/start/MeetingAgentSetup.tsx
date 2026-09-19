'use client'

/**
 * Agent configuration step of the Meeting Mediation setup flow (spec §18).
 *
 * Covers only what a meeting alone knows: what Urushi sounds like (voice gender,
 * accent region) and how often it steps in. Deliberately lightweight — three
 * compact groups, no cards competing with the ones on the previous screen.
 *
 * Personality, language and profanity are NOT here. They are agreed once for the
 * whole conversation in ConversationStyleFields and stored on the case, because
 * asking twice let a meeting run as one personality and be written up as another
 * — the live prompt read the meeting row, the final report read the case. The
 * props type is the meeting-only subset so this screen has nowhere to put them
 * even if someone tries.
 *
 * Note the intervention level named 'chair' is a frequency, not a personality;
 * it shares a word with nothing else here.
 */

import type {
  InterventionLevel,
  MeetingOnlyAgentSettings,
  VoiceGender,
  VoiceRegion,
} from '@/lib/meeting/agentSettings'

interface Props {
  settings: MeetingOnlyAgentSettings
  onChange: (next: MeetingOnlyAgentSettings) => void
}

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
  function update<K extends keyof MeetingOnlyAgentSettings>(key: K, value: MeetingOnlyAgentSettings[K]) {
    onChange({ ...settings, [key]: value })
  }

  return (
    <div className="space-y-6">
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
    </div>
  )
}
