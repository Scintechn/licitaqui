import { Card, SectionLabel, StateCard, Tag } from '@/components'
import {
  formatCnpj,
  formatWhatsapp,
  FOUNDERS_PAGE_LIMIT,
  type FounderRow,
} from '@/lib/admin/founders'
import { EXPORT_PATH } from './export-path'

/**
 * The founders list on screen.
 *
 * This is the only place in the product that shows someone else's name, e-mail,
 * WhatsApp number and CNPJ together, which is the whole point of `/admin` and
 * also the reason the page around it is behind Basic auth, `no-store` and
 * `noindex`. Nothing here is logged or linked: no `mailto:`, no `wa.me`, no row
 * that turns an e-mail address into a URL, because a URL ends up in a history,
 * a referrer and a proxy log.
 *
 * The export is a `POST` form rather than a link for the same reason, and
 * because downloading the personal data of every founder should be something
 * Sci does on purpose, not something a crawler or a prefetch can do by
 * following an anchor.
 */

const dateTime = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Sao_Paulo',
})

export function FoundersTable({ rows, total }: { rows: readonly FounderRow[]; total: number }) {
  const capped = total > rows.length

  return (
    <section className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <SectionLabel>Fundadores</SectionLabel>
          <span className="text-caption text-muted">
            {total.toLocaleString('pt-BR')} {total === 1 ? 'inscrito' : 'inscritos'}
            {capped ? ` · mostrando os ${rows.length} mais recentes` : ''}
          </span>
        </div>
        <ExportForm total={total} />
      </div>

      {rows.length === 0 ? (
        <StateCard
          kind="empty"
          title="Nenhuma inscrição ainda"
          description="A tabela enche sozinha quando a página de oferta receber a primeira inscrição."
        />
      ) : (
        <Card padding="none" className="overflow-x-auto">
          <table className="w-full min-w-[56rem] border-collapse text-left text-meta">
            <caption className="sr-only">
              Inscrições na lista de fundadores, da mais recente para a mais antiga
            </caption>
            <thead>
              <tr className="border-b border-line">
                <Th className="w-14">Vaga</Th>
                <Th>Nome</Th>
                <Th>E-mail</Th>
                <Th>WhatsApp</Th>
                <Th>CNPJ</Th>
                <Th>O que vende</Th>
                <Th>Origem</Th>
                <Th className="whitespace-nowrap">Inscrição</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-line last:border-0 align-top">
                  <Td>
                    {row.seat === null ? (
                      <Tag tone="muted">espera</Tag>
                    ) : (
                      <span className="font-mono tabular-nums">{row.seat}</span>
                    )}
                  </Td>
                  <Td className="font-medium text-ink">{row.name}</Td>
                  <Td className="font-mono text-caption break-all">{row.email}</Td>
                  <Td className="font-mono text-caption whitespace-nowrap">
                    {formatWhatsapp(row.whatsapp) ?? '—'}
                  </Td>
                  <Td className="font-mono text-caption whitespace-nowrap">
                    {formatCnpj(row.cnpj) ?? '—'}
                  </Td>
                  <Td className="max-w-[16rem]">{row.sells ?? '—'}</Td>
                  <Td>{row.source ?? '—'}</Td>
                  <Td className="whitespace-nowrap text-caption text-muted">
                    {dateTime.format(row.createdAt)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <p className="text-caption leading-relaxed text-muted">
        Dados pessoais (LGPD, spec §12): esta tela não é indexada, não é guardada em cache e nada
        aqui vai para log. Pedido de exclusão chega por e-mail e é feito direto no banco.
        {capped ? ` A tabela mostra no máximo ${FOUNDERS_PAGE_LIMIT}; o CSV traz a lista inteira.` : ''}
      </p>
    </section>
  )
}

/**
 * A real form, submitted by a real button: one deliberate action, no JavaScript
 * and nothing to prefetch. The browser downloads the response because the route
 * answers with `Content-Disposition: attachment`.
 */
function ExportForm({ total }: { total: number }) {
  return (
    <form method="post" action={EXPORT_PATH}>
      <button
        type="submit"
        disabled={total === 0}
        className="inline-flex h-9 items-center gap-2 rounded-control border border-line-strong bg-surface px-3 text-meta font-medium text-ink transition-colors hover:border-blue-line hover:text-blue disabled:cursor-not-allowed disabled:opacity-50"
      >
        Exportar CSV
      </button>
    </form>
  )
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`px-3 py-2 font-mono text-label font-medium tracking-[0.06em] text-muted uppercase ${className ?? ''}`}
    >
      {children}
    </th>
  )
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 ${className ?? ''}`}>{children}</td>
}
