'use client'

import { useEffect, useState } from 'react'
import { Icon } from './icon'

export interface WelcomeBannerProps {
  /** Message to display in the banner */
  message: string
  /** Duration in milliseconds before auto-dismissing (default: 5000ms) */
  autoDismissMs?: number
  /** Called when the banner is dismissed */
  onDismiss?: () => void
}

/**
 * A dismissible welcome banner that auto-hides after a configurable duration.
 *
 * Typically shown to first-time users after sign-in.
 * - Auto-dismisses after 5 seconds (configurable)
 * - User can click X to dismiss earlier
 * - Uses design tokens for colors and spacing
 */
export function WelcomeBanner({
  message,
  autoDismissMs = 5000,
  onDismiss,
}: WelcomeBannerProps) {
  const [isVisible, setIsVisible] = useState(true)

  useEffect(() => {
    if (!isVisible) return

    const timer = setTimeout(() => {
      setIsVisible(false)
      onDismiss?.()
    }, autoDismissMs)

    return () => clearTimeout(timer)
  }, [isVisible, autoDismissMs, onDismiss])

  if (!isVisible) {
    return null
  }

  const handleDismiss = () => {
    setIsVisible(false)
    onDismiss?.()
  }

  return (
    <div
      className="border-l-4 p-4 rounded flex items-start gap-3"
      style={{
        backgroundColor: 'var(--color-blue-soft)',
        borderLeftColor: 'var(--color-blue)',
        color: 'var(--color-ink)',
      }}
      role="status"
      aria-live="polite"
    >
      <div className="flex-1">
        <p className="text-sm font-medium">{message}</p>
      </div>
      <button
        onClick={handleDismiss}
        className="flex-shrink-0 transition-opacity hover:opacity-70"
        style={{ color: 'var(--color-ink)' }}
        aria-label="Fechar"
        type="button"
      >
        <Icon name="close" size={20} />
      </button>
    </div>
  )
}
