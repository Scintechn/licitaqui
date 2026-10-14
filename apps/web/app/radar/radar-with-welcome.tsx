'use client'

import { useSession } from 'next-auth/react'
import { useCallback, useState } from 'react'
import { messages } from '@/lib/messages'
import { isJustCreated } from '@/lib/auth/first-time-user'
import { WelcomeBanner } from '@/components/welcome-banner'
import { RadarScreen } from './radar-screen'
import type { RadarScreenProps } from './radar-screen'

/**
 * RadarScreen wrapped with welcome banner logic.
 *
 * On first login, shows a 5-second welcome message encouraging the user
 * to start searching by their company CNPJ. The banner auto-dismisses or
 * can be closed manually.
 */
export function RadarWithWelcome(props: RadarScreenProps) {
  const { data: session } = useSession()
  const [dismissed, setDismissed] = useState(false)

  // Show welcome banner if user just created their account and we haven't dismissed it yet
  const showWelcome =
    !dismissed && session?.user && 'createdAt' in session.user
      ? isJustCreated(session.user.createdAt as string | Date)
      : false

  const handleDismiss = useCallback(() => {
    setDismissed(true)
  }, [])

  return (
    <div className="flex flex-col gap-4">
      {showWelcome && (
        <div className="px-4 pt-4">
          <WelcomeBanner
            message={messages.radar.welcome.message}
            autoDismissMs={5000}
            onDismiss={handleDismiss}
          />
        </div>
      )}
      <RadarScreen {...props} />
    </div>
  )
}
