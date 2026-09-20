import { LegalPage, legalMetadata } from '../legal-page'

/** `/privacidade` — rendered from `docs/legal/politica-de-privacidade.md`. */

export const generateMetadata = legalMetadata('politica-de-privacidade', '/privacidade')

export const dynamic = 'force-static'

export default function Privacidade() {
  return <LegalPage id="politica-de-privacidade" />
}
