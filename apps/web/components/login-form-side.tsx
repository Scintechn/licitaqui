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
 * Wraps the sign-in form and manages its responsive layout within the
 * split-screen structure. Handles spacing and alignment for both desktop
 * and mobile layouts.
 *
 * On desktop (1024px+): Takes the right 50% of the screen.
 * On mobile (<640px): Takes full width and appears below the brand side.
 */
export function LoginFormSide({ children, className = '' }: LoginFormSideProps) {
  return (
    <main
      className={`flex flex-col items-stretch justify-center gap-4 px-gutter py-10 ${className}`}
      style={{
        backgroundColor: 'var(--color-ivory)',
        color: 'var(--color-ink)',
      }}
    >
      {children}
    </main>
  )
}
