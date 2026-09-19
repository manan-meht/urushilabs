import { describe, it, expect } from 'vitest'
import {
  SHARED_DEVICE_REF,
  activeSettingsDuringProposal,
  canStartConversation,
  disableProfanity,
  effectiveSettings,
  evaluateAcceptance,
  isSharedDeviceRef,
  proposeSettingsChange,
  type SettingsAcceptance,
} from './acceptance'
import { DEFAULT_CONVERSATION_SETTINGS, type ConversationSettings } from './settings'

const shooter: ConversationSettings = {
  ...DEFAULT_CONVERSATION_SETTINGS,
  personality: 'straight_shooter',
  allowProfanity: true,
  version: 2,
}

function accepted(ref: string, version: number, acceptedProfanity = false): SettingsAcceptance {
  return { participantRef: ref, settingsVersion: version, acceptedProfanity }
}

describe('evaluateAcceptance', () => {
  it('reports who has not responded yet', () => {
    const status = evaluateAcceptance(shooter, ['a', 'b'], [accepted('a', 2)])
    expect(status.pending).toEqual(['b'])
    expect(status.allAccepted).toBe(false)
  })

  it('ignores acceptances of a different settings version', () => {
    // The whole point of versioning: agreement to the old configuration must not
    // carry over to a changed one.
    const status = evaluateAcceptance(shooter, ['a'], [accepted('a', 1, true)])
    expect(status.allAccepted).toBe(false)
    expect(status.pending).toEqual(['a'])
    expect(status.profanityPermitted).toBe(false)
  })

  it('separates a decline from not having answered', () => {
    const status = evaluateAcceptance(shooter, ['a', 'b'], [
      { participantRef: 'a', settingsVersion: 2, acceptedProfanity: false, declinedAt: '2026-09-19T10:00:00Z' },
    ])
    expect(status.declined).toEqual(['a'])
    expect(status.pending).toEqual(['b'])
  })

  it('permits profanity only when everyone accepted it specifically', () => {
    const everyone = evaluateAcceptance(shooter, ['a', 'b'], [accepted('a', 2, true), accepted('b', 2, true)])
    expect(everyone.profanityPermitted).toBe(true)

    // Accepting the style is not accepting the swearing.
    const onlyStyle = evaluateAcceptance(shooter, ['a', 'b'], [accepted('a', 2, true), accepted('b', 2, false)])
    expect(onlyStyle.allAccepted).toBe(true)
    expect(onlyStyle.profanityPermitted).toBe(false)
  })

  it('never permits profanity that was not requested', () => {
    const clean = { ...DEFAULT_CONVERSATION_SETTINGS, version: 2 }
    const status = evaluateAcceptance(clean, ['a'], [accepted('a', 2, true)])
    expect(status.profanityPermitted).toBe(false)
  })
})

describe('effectiveSettings', () => {
  it('degrades profanity to off rather than blocking the conversation', () => {
    const status = evaluateAcceptance(shooter, ['a', 'b'], [accepted('a', 2, true), accepted('b', 2, false)])
    const effective = effectiveSettings(shooter, status)
    expect(effective.allowProfanity).toBe(false)
    // One person declining the swearing must not stop the mediation itself.
    expect(canStartConversation(status)).toBe(true)
    expect(effective.personality).toBe('straight_shooter')
  })

  it('leaves settings untouched when profanity is fully accepted', () => {
    const status = evaluateAcceptance(shooter, ['a'], [accepted('a', 2, true)])
    expect(effectiveSettings(shooter, status)).toEqual(shooter)
  })
})

describe('proposeSettingsChange', () => {
  it('bumps the version so stale acceptances stop counting', () => {
    const next = proposeSettingsChange(DEFAULT_CONVERSATION_SETTINGS, { personality: 'deal_maker' })
    expect(next.version).toBe(DEFAULT_CONVERSATION_SETTINGS.version + 1)
  })

  it('does not bump the version when nothing acceptance-relevant changed', () => {
    // Otherwise merely opening the settings panel would invalidate everyone's
    // agreement and stall the conversation.
    const hindi: ConversationSettings = { ...DEFAULT_CONVERSATION_SETTINGS, language: 'hindi', textScript: 'devanagari' }
    const next = proposeSettingsChange(hindi, { textScript: 'roman' })
    expect(next.version).toBe(hindi.version)
    expect(next.textScript).toBe('roman')
  })

  it('drops profanity when moving away from the Straight Shooter', () => {
    const next = proposeSettingsChange(shooter, { personality: 'diplomat' })
    expect(next.allowProfanity).toBe(false)
  })
})

describe('changing profanity mid-session', () => {
  it('lets anyone turn it off immediately', () => {
    // Withdrawing a permission you granted needs nobody else's agreement.
    const next = disableProfanity(shooter)
    expect(next.allowProfanity).toBe(false)
    expect(next.version).toBe(shooter.version + 1)
  })

  it('is a no-op when it is already off', () => {
    const clean = DEFAULT_CONVERSATION_SETTINGS
    expect(disableProfanity(clean)).toBe(clean)
  })

  it('requires everyone again to turn it back on', () => {
    const off = disableProfanity(shooter)
    const backOn = proposeSettingsChange(off, { allowProfanity: true })
    const status = evaluateAcceptance(backOn, ['a', 'b'], [accepted('a', backOn.version, true)])
    expect(status.profanityPermitted).toBe(false)
    expect(effectiveSettings(backOn, status).allowProfanity).toBe(false)
  })
})

describe('activeSettingsDuringProposal', () => {
  const acceptedSettings = DEFAULT_CONVERSATION_SETTINGS
  const proposed = proposeSettingsChange(acceptedSettings, { personality: 'straight_shooter' })

  it('keeps the accepted settings active while a change is pending', () => {
    // A proposal must never take effect early — otherwise proposing a change
    // would be a way to impose it.
    const status = evaluateAcceptance(proposed, ['a', 'b'], [accepted('a', proposed.version)])
    expect(activeSettingsDuringProposal(acceptedSettings, proposed, status)).toEqual(acceptedSettings)
  })

  it('switches once everyone has accepted', () => {
    const status = evaluateAcceptance(proposed, ['a', 'b'], [
      accepted('a', proposed.version),
      accepted('b', proposed.version),
    ])
    expect(activeSettingsDuringProposal(acceptedSettings, proposed, status)).toEqual(proposed)
  })
})

describe('shared-device confirmation', () => {
  it('is a single ref covering everyone present', () => {
    expect(isSharedDeviceRef(SHARED_DEVICE_REF)).toBe(true)
    expect(isSharedDeviceRef('some-participant-uuid')).toBe(false)

    const status = evaluateAcceptance(shooter, [SHARED_DEVICE_REF], [accepted(SHARED_DEVICE_REF, 2, true)])
    expect(status.allAccepted).toBe(true)
    expect(status.profanityPermitted).toBe(true)
  })
})
