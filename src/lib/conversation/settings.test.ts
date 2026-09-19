import { describe, it, expect } from 'vitest'
import {
  DEFAULT_CONVERSATION_SETTINGS,
  conversationSettingsFromRow,
  conversationSettingsToRow,
  defaultScriptForLanguage,
  normalizeConversationSettings,
  requiresReacceptance,
  scriptIsRelevant,
} from './settings'

describe('normalizeConversationSettings', () => {
  it('falls back to the documented defaults for missing settings', () => {
    // Sessions created before this feature have no columns set at all and must
    // keep working: English, Diplomat, profanity off.
    const s = normalizeConversationSettings(null)
    expect(s.language).toBe('english')
    expect(s.personality).toBe('diplomat')
    expect(s.allowProfanity).toBe(false)
  })

  it('rejects unknown enum values rather than passing them through', () => {
    // These must never reach prompt construction — a stray value would be
    // interpolated straight into a system prompt.
    const s = normalizeConversationSettings({
      language: 'klingon',
      personality: 'dictator',
      textScript: 'cuneiform',
    })
    expect(s.language).toBe('english')
    expect(s.personality).toBe('diplomat')
    expect(s.textScript).toBe('roman')
  })

  it('forces profanity off for every personality except the Straight Shooter', () => {
    // The control is hidden in the UI for these, so a request carrying it is
    // either stale or hand-crafted. Either way it is not honoured.
    for (const personality of ['diplomat', 'deal_maker'] as const) {
      const s = normalizeConversationSettings({ personality, allowProfanity: true })
      expect(s.allowProfanity, personality).toBe(false)
    }
  })

  it('allows profanity only when explicitly true for the Straight Shooter', () => {
    expect(normalizeConversationSettings({ personality: 'straight_shooter', allowProfanity: true }).allowProfanity).toBe(true)
    // Truthy-but-not-true values do not count.
    expect(normalizeConversationSettings({ personality: 'straight_shooter', allowProfanity: 'yes' }).allowProfanity).toBe(false)
    expect(normalizeConversationSettings({ personality: 'straight_shooter' }).allowProfanity).toBe(false)
  })

  it('defaults the script from the language', () => {
    expect(normalizeConversationSettings({ language: 'hindi' }).textScript).toBe('devanagari')
    expect(normalizeConversationSettings({ language: 'hinglish' }).textScript).toBe('roman')
  })

  it('keeps an explicit script that differs from the language default', () => {
    // A Hindi speaker who prefers typing in Roman is a real case.
    expect(normalizeConversationSettings({ language: 'hindi', textScript: 'roman' }).textScript).toBe('roman')
  })

  it('ignores a nonsensical version', () => {
    for (const version of [0, -3, 1.5, 'two', null]) {
      expect(normalizeConversationSettings({ version }).version, String(version)).toBe(1)
    }
  })
})

describe('script relevance', () => {
  it('is only a real choice for Hindi and Hinglish', () => {
    expect(scriptIsRelevant('english')).toBe(false)
    expect(scriptIsRelevant('hindi')).toBe(true)
    expect(scriptIsRelevant('hinglish')).toBe(true)
  })

  it('defaults Hindi to Devanagari and Hinglish to Roman', () => {
    expect(defaultScriptForLanguage('hindi')).toBe('devanagari')
    expect(defaultScriptForLanguage('hinglish')).toBe('roman')
  })
})

describe('requiresReacceptance', () => {
  const base = DEFAULT_CONVERSATION_SETTINGS

  it('is true for language, personality and profanity changes', () => {
    expect(requiresReacceptance(base, { ...base, language: 'hindi' })).toBe(true)
    expect(requiresReacceptance(base, { ...base, personality: 'deal_maker' })).toBe(true)
    expect(requiresReacceptance(
      { ...base, personality: 'straight_shooter' },
      { ...base, personality: 'straight_shooter', allowProfanity: true },
    )).toBe(true)
  })

  it('is false for a script change', () => {
    // Script changes how text is rendered, not what Urushi will say or how
    // bluntly. Re-gathering everyone's agreement for it would train people to
    // click through the prompt that actually matters.
    expect(requiresReacceptance(
      { ...base, language: 'hindi', textScript: 'devanagari' },
      { ...base, language: 'hindi', textScript: 'roman' },
    )).toBe(false)
  })
})

describe('row mapping', () => {
  it('round-trips through the database shape', () => {
    const settings = normalizeConversationSettings({
      language: 'hinglish',
      personality: 'straight_shooter',
      allowProfanity: true,
      textScript: 'roman',
      version: 4,
    })
    expect(conversationSettingsFromRow(conversationSettingsToRow(settings))).toEqual(settings)
  })

  it('normalizes a legacy row with every column null', () => {
    const s = conversationSettingsFromRow({
      conversation_language: null,
      mediator_personality: null,
      allow_profanity: null,
      text_script: null,
      conversation_settings_version: null,
    })
    expect(s).toEqual(DEFAULT_CONVERSATION_SETTINGS)
  })
})
