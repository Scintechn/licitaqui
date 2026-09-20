import { LegalPage, legalMetadata } from '../legal-page'

/** `/termos` — the terms of use, rendered from `docs/legal/termos-de-uso.md`. */

export const generateMetadata = legalMetadata('termos-de-uso', '/termos')

export const dynamic = 'force-static'

export default function Termos() {
  return <LegalPage id="termos-de-uso" />
}
