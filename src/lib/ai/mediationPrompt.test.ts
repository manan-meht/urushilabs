import { describe, it, expect } from 'vitest'
import { SharedReportSchema, SAFETY_CATEGORIES, buildMediationSystemPrompt } from './mediationPrompt'
import { MOCK_REPORT } from './mockReport'
import { normalizeConversationSettings } from '@/lib/conversation/settings'

describe('SharedReportSchema', () => {
  it('validates the mock report without errors', () => {
    const result = SharedReportSchema.safeParse(MOCK_REPORT)
    expect(result.success).toBe(true)
  })

  it('requires reportTitle', () => {
    const bad = { ...MOCK_REPORT, reportTitle: '' }
    const result = SharedReportSchema.safeParse(bad)
    expect(result.success).toBe(false)
  })

  it('rejects invalid safety category', () => {
    const bad = { ...MOCK_REPORT, safetyCategory: 'made_up_category' }
    const result = SharedReportSchema.safeParse(bad)
    expect(result.success).toBe(false)
  })

  it('requires valid initiatorPerspective shape', () => {
    const bad = { ...MOCK_REPORT, initiatorPerspective: { wrong: 'field' } }
    const result = SharedReportSchema.safeParse(bad)
    expect(result.success).toBe(false)
  })

  it('accepts null for professionalSupportSuggestion', () => {
    const ok = { ...MOCK_REPORT, professionalSupportSuggestion: null }
    const result = SharedReportSchema.safeParse(ok)
    expect(result.success).toBe(true)
  })
})

describe('buildMediationSystemPrompt — Top-Line Summary requirements', () => {
  const prompt = buildMediationSystemPrompt(normalizeConversationSettings({}))

  it('requests a detailed explanation of the central problem', () => {
    expect(prompt).toMatch(/Central Problem/i)
    expect(prompt).toMatch(/deeper issue/i)
  })

  it('requests identification of key unresolved issues', () => {
    expect(prompt).toMatch(/Key Issues/i)
    expect(prompt).toMatch(/unresolved/i)
  })

  it('requests a proposed resolution path for each issue', () => {
    expect(prompt).toMatch(/How the Issues Should Be Resolved/i)
    expect(prompt).toMatch(/path forward/i)
  })

  it('requests participant-specific next actions', () => {
    expect(prompt).toMatch(/Recommended Next Steps/i)
    expect(prompt).toMatch(/Participant A/i)
    expect(prompt).toMatch(/Participant B/i)
  })

  it('specifies 500 to 900 words as the target length', () => {
    expect(prompt).toMatch(/500.{1,10}900 words/i)
  })

  it('prohibits vague recommendations', () => {
    expect(prompt).toMatch(/communicate better/i)
    expect(prompt).toMatch(/listen to each other/i)
  })

  it('requires explanation of why the conflict remains unresolved', () => {
    expect(prompt).toMatch(/Why the Conflict Remains Unresolved/i)
  })

  it('requires the bottomLine field to carry the Top-Line Summary', () => {
    expect(prompt.toLowerCase()).toContain('bottomline')
    expect(prompt).toMatch(/Top-Line Summary/i)
  })
})

describe('safety category classification', () => {
  const SAFE = ['ordinary_conflict', 'high_conflict']
  const SAFETY_SENSITIVE = [
    'possible_coercion_or_abuse',
    'possible_self_harm_or_violence',
    'possible_child_safety_issue',
    'legal_or_professional_support_needed',
  ]

  it('all expected categories are present in SAFETY_CATEGORIES', () => {
    expect(SAFETY_CATEGORIES).toContain('ordinary_conflict')
    expect(SAFETY_CATEGORIES).toContain('possible_coercion_or_abuse')
    expect(SAFETY_CATEGORIES).toContain('possible_self_harm_or_violence')
    expect(SAFETY_CATEGORIES).toContain('possible_child_safety_issue')
    expect(SAFETY_CATEGORIES).toContain('legal_or_professional_support_needed')
  })

  it('can distinguish ordinary from safety-sensitive categories', () => {
    const isSafetySensitive = (cat: string) => SAFETY_SENSITIVE.includes(cat)
    SAFE.forEach((cat) => expect(isSafetySensitive(cat)).toBe(false))
    SAFETY_SENSITIVE.forEach((cat) => expect(isSafetySensitive(cat)).toBe(true))
  })
})
