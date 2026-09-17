import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { AppBar, Card, Logo, StateCard } from '@/components'
import { authorizeAdmin } from '@/lib/admin/auth'
import { countFounders, listFounders, type FounderRow } from '@/lib/admin/founders'
import { readGates, type Gate } from '@/lib/admin/gates'
import { readNeonUsage, type NeonUsage } from '@/lib/admin/neon'
import { FoundersTable } from './founders-table'
import { GateCards } from './gate-cards'
import { UsageCard } from './usage-card'

/**
 * `/admin` — the internal board (task O1; plan gap G11 lists it as a screen
 * with no canvas, to be built from the design system).
 *
 * Three things, in the order Sci needs them: the Phase 0 gate numbers (§14),
 * how close the Neon Free plan is to its limits (§5.1), and the founders list
 * with its CSV export.
 *
 * ## Access
 *
 * `proxy.ts` challenges every request under `/admin` with HTTP Basic and
 * answers 401/403 itself. This page checks **again** through the same
 * `authorizeAdmin()`, and 404s when the answer is no: a page that shows the
 * personal data of every founder must not depend on a `matcher` glob being
 * right. Both layers fail closed when `ADMIN_EMAILS` or `ADMIN_PASSWORD` is
 * missing.
 *
 * ## Copy
 *
 * Hardcoded pt-BR, following `/dev/components`: this is an internal tool, not a
 * product screen, and `messages/pt-BR.json` is the catalogue of copy shown to
 * customers (task E0 owns it).
 */

export const dynamic = 'force-dynamic'
export const revalidate = 0

export const metadata: Metadata = {
  title: 'Admin · LicitaQui',
  robots: { index: false, follow: false, nocache: true, noarchive: true },
}

/** Phase 0 gate review (plan §5, spec §14). */
const GATE_DATE = '06/11/2026'

const FULL_DATE = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Sao_Paulo',
})

type Board = {
  gates: Gate[]
  usage: NeonUsage
  founders: FounderRow[]
  total: number
}

/**
 * One failure must not blank the board: if the database is unreachable the page
 * still renders, says so, and keeps the parts that do not need it.
 */
async function readBoard(): Promise<Board | { error: string }> {
  try {
    const [gates, usage, founders, total] = await Promise.all([
      readGates(),
      readNeonUsage(),
      listFounders(),
      countFounders(),
    ])
    return { gates, usage, founders, total }
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? 'unknown'
    // A code, never the connection string and never a row (§12).
    console.error(`/admin could not read the database (${code})`)
    return { error: code }
  }
}

export default async function AdminPage() {
  const auth = authorizeAdmin(await headers())
  if (!auth.ok) notFound()

  const board = await readBoard()

  return (
    <div className="min-h-dvh bg-ivory">
      <AppBar
        leading={<Logo size={22} />}
        title={<span className="font-mono text-label tracking-[0.08em] uppercase">Admin</span>}
        actions={
          <span className="font-mono text-caption text-muted">{FULL_DATE.format(new Date())}</span>
        }
      />

      <main className="mx-auto flex max-w-6xl flex-col gap-8 px-gutter py-6">
        {'error' in board ? (
          <StateCard
            kind="limit"
            title="Sem acesso ao banco"
            description={`A consulta falhou (${board.error}). Nenhum número desta tela pode ser mostrado — recarregue depois de conferir DATABASE_URL.`}
          />
        ) : (
          <>
            <GateCards gates={board.gates} gateDate={GATE_DATE} />
            <UsageCard usage={board.usage} />
            <FoundersTable rows={board.founders} total={board.total} />
          </>
        )}

        <Card className="text-caption leading-relaxed text-muted">
          Sessão por HTTP Basic sobre TLS enquanto a task U1 (Auth.js) não chega: o e-mail precisa
          estar em <code className="font-mono">ADMIN_EMAILS</code> e a senha é{' '}
          <code className="font-mono">ADMIN_PASSWORD</code>. Sem as duas variáveis a página não abre
          para ninguém. Página nunca indexada e nunca guardada em cache (spec §3.3).
        </Card>
      </main>
    </div>
  )
}
