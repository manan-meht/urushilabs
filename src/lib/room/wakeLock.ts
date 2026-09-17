/**
 * Wraps the Web Screen Wake Lock API so the phone doesn't sleep during a live
 * mediation. No-ops gracefully where unsupported (e.g. some iOS Safari versions) —
 * callers should still tell users to keep the device plugged in for long sessions.
 * Reacquires automatically when the tab becomes visible again, since the OS
 * releases the lock whenever the page is backgrounded.
 */

export class WakeLockController {
  private sentinel: WakeLockSentinel | null = null
  private active = false
  private visibilityHandler = () => {
    if (this.active && document.visibilityState === 'visible' && !this.sentinel) {
      void this.acquire()
    }
  }

  get isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator
  }

  async acquire(): Promise<boolean> {
    this.active = true
    if (typeof navigator === 'undefined' || !navigator.wakeLock) return false

    try {
      this.sentinel = await navigator.wakeLock.request('screen')
      this.sentinel.addEventListener('release', () => {
        this.sentinel = null
      })
      document.addEventListener('visibilitychange', this.visibilityHandler)
      return true
    } catch (err) {
      console.warn('[WakeLockController] Failed to acquire wake lock:', err)
      return false
    }
  }

  async release(): Promise<void> {
    this.active = false
    document.removeEventListener('visibilitychange', this.visibilityHandler)
    if (this.sentinel && !this.sentinel.released) {
      try {
        await this.sentinel.release()
      } catch {
        // Already released — nothing to do.
      }
    }
    this.sentinel = null
  }
}
