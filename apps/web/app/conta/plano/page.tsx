import { redirect } from 'next/navigation'

/**
 * Redirect to unified /conta dashboard on plano tab.
 * This route is deprecated in favor of /conta?tab=plano
 */
export default function PlanRedirectPage() {
  redirect('/conta?tab=plano')
}
