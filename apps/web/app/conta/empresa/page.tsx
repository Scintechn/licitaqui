import { redirect } from 'next/navigation'

/**
 * Redirect to unified /conta dashboard on empresa tab.
 * This route is deprecated in favor of /conta?tab=empresa
 */
export default function CompanyRedirectPage() {
  redirect('/conta?tab=empresa')
}
