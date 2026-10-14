import { ReactNode } from 'react'
import { LoginBrandSide } from './login-brand-side'
import { LoginFormSide } from './login-form-side'

export interface LoginSplitScreenProps {
  /** The form content to display on the right side */
  formContent: ReactNode
}

/**
 * Split-screen login layout for `/conta/criar`.
 *
 * **Layout behavior:**
 * - Desktop (1024px+): 50/50 side-by-side with brand panel on left
 * - Tablet (640–1024px): Vertical stack with form on top
 * - Mobile (<640px): Full-width form, brand panel hidden
 *
 * **Design:**
 * - Uses Flexbox for responsive layout
 * - Brand panel: dark blue background (--color-brand-panel)
 * - Form side: ivory background (--color-ivory)
 * - No viewport queries: hidden content is removed from layout, not just
 *   visually hidden, so it does not affect responsiveness
 *
 * **Accessibility:**
 * - Semantic HTML: `<aside>` for brand, `<main>` for form
 * - Logo and headings properly marked up
 * - Focus management handled by child components
 */
export function LoginSplitScreen({ formContent }: LoginSplitScreenProps) {
  return (
    <div
      className="flex flex-col-reverse lg:flex-row min-h-dvh"
      style={{
        backgroundColor: 'var(--color-ivory)',
      }}
    >
      {/* Brand side: hidden on mobile/tablet, shown on desktop */}
      <LoginBrandSide className="flex-1 lg:flex-1" />

      {/* Form side: always visible, takes full width on mobile */}
      <LoginFormSide className="flex-1 lg:flex-1">
        {formContent}
      </LoginFormSide>
    </div>
  )
}
