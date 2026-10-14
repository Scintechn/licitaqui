import { ReactNode } from 'react'

export interface LoginFormSideProps {
  /** The content to render (typically the SignInView component) */
  children: ReactNode
  /** Optional CSS class name for styling */
  className?: string
}

/**
 * Right side of the split-screen login layout.
 *
 * Wraps the sign-in form in a white card container with rounded corners and shadow,
 * set against a dark background for visual separation and elevation.
 *
 * **Layout:**
 * - Outer container: Dark background, centered flex layout
 * - Inner card: White background, rounded corners, subtle shadow, padding
 *
 * **Responsive behavior:**
 * - Mobile (<lg): Card takes full width minus gutters, dark background fills viewport
 * - Desktop (lg+): Card width constrained, centered on dark background
 *
 * On desktop (1024px+): Takes the right 50% of the screen.
 * On mobile (<640px): Takes full width and appears below the brand side.
 */
export function LoginFormSide({ children, className = '' }: LoginFormSideProps) {
  return (
    <main
      className={`flex flex-col items-center justify-center gap-4 px-gutter py-10 lg:py-0 min-h-dvh lg:min-h-auto ${className}`}
      style={{
        backgroundColor: '#1a1a1a',
        color: 'var(--color-ink)',
      }}
    >
      {/* Card container with white background, rounded corners, and shadow */}
      <div
        className="w-full lg:w-96 flex flex-col gap-4 p-10 rounded-lg shadow-md"
        style={{
          backgroundColor: 'var(--color-surface)',
        }}
      >
        {children}
      </div>
    </main>
  )
}
