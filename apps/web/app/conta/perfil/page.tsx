import { redirect } from 'next/navigation'

/**
 * Redirect to unified /conta dashboard on perfil tab.
 * This route is deprecated in favor of /conta?tab=perfil
 */
export default function ProfileRedirectPage() {
  redirect('/conta?tab=perfil')
}
