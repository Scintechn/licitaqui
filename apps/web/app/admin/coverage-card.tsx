import { Card, SectionLabel, Status, Tag } from '@/components'
import type { Coverage, CoverageQuery, CoverageReading } from '@/lib/admin/coverage'

/**
 * Whether the Radar still holds the open editais it promises — card **B17**,
 * watched the way **B37** watches the price feeds, and built in that file's
 * shape rather than a second idiom.
 *
 * **Alarm on absence of success, never on an empty queue.** B32's lesson: a
 * feed that stops enqueuing also stops failing, so 916 broken jobs looked like
 * silence for two days. Nothing here reads `jobs` — a measurement that was
 * never taken and one that failed on every keyword leave the same absence, and
 * that absence is the alarm.
 *
 * ## The four bad states, and why none of them may read like another
 *
 * `short` — measured, recently, and the weakest keyword is under target: the
 * gap B17 closed has come back. A fact about the Radar, and the loudest thing
 * on the card.
 *
 * `stale` — nothing measured inside the threshold: we do **not know**. The
 * last reading is printed with its age, because *"97% há 9 dias"* and *"97%"*
 * are different sentences and collapsing them is how a dead feed reads as
 * healthy. A fact about the watchdog, not about the coverage.
 *
 * `incomplete` — every keyword that answered is above target, and one of the
 * standing set did not answer at all. One segment can go dark while the
 * aggregate stays green, and an empty walk is never recorded — not even as
 * 0% — so the only trace of it is a missing row.
 *
 * `adhoc_only` — the recent readings are somebody's one-off `--q` runs and the
 * standing set is not among them. It cannot be called in order.
 *
 * ## Why the weakest keyword is the headline, and the oldest age
 *
 * `coverage_check` asks seven keywords, one per segment in
 * `sync_awards.DEFAULT_SEGMENTS` plus B17's own baseline. The sentence is
 * addressed to *each* company, so an average can sit above target while the
 * segment a founder works in holds nothing; the worst keyword decides. And the
 * age printed is the **oldest** of the current readings, not the newest —
 * otherwise one keyword that keeps answering while six are refused every night
 * would print *"medido há 0 h, em 7 palavras-chave"*. Both of those were found
 * by this card's review.
 *
 * ## Breakpoints
 *
 * `sm:`/`xl:` viewport queries are correct **here** and would not be inside
 * the app shell: `/admin` renders under `AppBar` in a `max-w-6xl` column with
 * no collapsible rail, so there is no 264px the window cannot see. See
 * `CLAUDE.md` on why the same classes are wrong in `app-shell.tsx`'s column.
 */

const PT = new Intl.NumberFormat('pt-BR')
/**
 * One decimal, always, and **rounded down**.
 *
 * The review found 0,9496 rendering as "95%" beside *"meta 95%"* under a badge
 * reading *"abaixo da meta"* — the card contradicting itself on the one screen
 * whose job is to be believed. A decimal alone does not fix it: 94,96% still
 * rounds to "95,0%", and 0,94996 would still round to "95,00%" at two. Only
 * flooring does, and it is the honest direction anyway: a coverage figure
 * should never be displayed higher than it is, so a ratio under target can
 * never print as the target.
 */
const PCT = new Intl.NumberFormat('pt-BR', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  roundingMode: 'floor',
})

/** Hours while hours are still readable, days after. */
function age(hours: number): string {
  const whole = Math.floor(hours)
  if (whole < 96) return `${PT.format(whole)} h`
  return `${PT.format(Math.floor(whole / 24))} dias`
}

export function CoverageCard({ coverage }: { coverage: Coverage }) {
  const { reading } = coverage
  return (
    <section className="flex flex-col gap-3.5">
      <div className="flex items-baseline gap-2">
        <SectionLabel>Cobertura dos editais abertos</SectionLabel>
        <span className="text-caption text-muted">
          a frase &ldquo;os editais abertos que combinam&rdquo;, como número
        </span>
      </div>

      <Card className="flex flex-col gap-3" accent={reading.state === 'fresh'}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="text-lead font-semibold text-ink">
            Parcela dos editais abertos que o Radar tem
          </div>
          <CoverageBadge reading={reading} />
        </div>

        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-stat tabular-nums text-ink">{headline(reading)}</span>
          <span className="text-meta text-muted">{beside(coverage)}</span>
        </div>

        <CoverageNote reading={reading} />

        {'summary' in reading ? (
          <QueryList queries={reading.summary.queries} missing={reading.summary.missing} />
        ) : null}

        <div className="mt-auto pt-1 font-mono text-caption text-muted">{coverage.source}</div>
      </Card>
    </section>
  )
}

/**
 * The worst keyword's ratio, not the average — see the module comment. An em
 * dash when there is no measurement, never a zero: a zero here would read as
 * "we hold nothing", and the worker refuses to record one from a walk that
 * answered nothing. (A real 0% from a real walk is possible and is `short`.)
 */
function headline(reading: CoverageReading): string {
  switch (reading.state) {
    case 'fresh':
    case 'short':
    case 'incomplete':
    case 'adhoc_only':
      return PCT.format(reading.summary.worst.ratio)
    case 'stale':
      return PCT.format(reading.last.ratio)
    case 'never':
    case 'error':
      return '—'
  }
}

/** What the headline is, in words, so the number is never ambiguous. */
function beside(coverage: Coverage): string {
  const { reading } = coverage
  const alarm = `alerta depois de ${PT.format(coverage.thresholdHours)} h`
  switch (reading.state) {
    case 'fresh':
    case 'short':
    case 'incomplete':
    case 'adhoc_only': {
      const { worst, target, ratio, held, collected } = reading.summary
      const goal = target === null ? '' : ` · meta ${PCT.format(target)}`
      const where = worst.segment ? ` · ${worst.segment}` : ''
      const whole = `no conjunto ${PCT.format(ratio)} (${PT.format(held)} de ${PT.format(collected)})`
      return `pior consulta: ${worst.q}${where}${goal} · ${whole}`
    }
    case 'stale':
      // Hours against hours: "há 3 dias · alerta depois de 3 dias" read as a
      // contradiction of itself at 73 h. The review caught it.
      return `última medição: ${reading.last.q} · há ${age(reading.hours)} · ${alarm}`
    case 'never':
    case 'error':
      return `${alarm} sem medição`
  }
}

function CoverageBadge({ reading }: { reading: CoverageReading }) {
  switch (reading.state) {
    case 'fresh':
      return <Status kind="positive">em dia</Status>
    case 'short':
      return <Tag tone="attention">abaixo da meta</Tag>
    case 'incomplete':
      return <Tag tone="attention">medição incompleta</Tag>
    case 'adhoc_only':
      return <Tag tone="attention">sem medição padrão</Tag>
    case 'stale':
      return <Tag tone="attention">sem medição recente</Tag>
    case 'never':
      return <Tag tone="muted">nunca mediu</Tag>
    case 'error':
      return <Tag tone="attention">erro</Tag>
  }
}

function CoverageNote({ reading }: { reading: CoverageReading }) {
  switch (reading.state) {
    case 'fresh':
      return (
        <p className="text-meta text-muted">
          A medição mais antiga em uso tem {age(reading.hours)}, em{' '}
          {PT.format(reading.summary.queries.length)} palavras-chave — todas na meta.
        </p>
      )
    case 'short':
      return (
        <p className="text-meta leading-relaxed text-attention">
          A lacuna do B17 voltou em <span className="font-mono">{reading.summary.worst.q}</span>:{' '}
          {PT.format(reading.summary.worst.held)} de {PT.format(reading.summary.worst.collected)}{' '}
          editais abertos. A frase diz <em>os</em> editais abertos, e esta é a medida dela.
        </p>
      )
    case 'incomplete':
      return (
        <p className="text-meta leading-relaxed text-attention">
          Tudo que respondeu está na meta, mas {PT.format(reading.summary.missing.length)} de{' '}
          {PT.format(reading.summary.expected.length)} palavras-chave não foram medidas. Uma busca
          vazia nunca é gravada — nem como 0% — então a única marca dela é a linha que falta.
        </p>
      )
    case 'adhoc_only':
      return (
        <p className="text-meta leading-relaxed text-attention">
          As medições recentes são consultas pontuais, não o conjunto diário. Nada aqui autoriza
          dizer que a cobertura está em dia: o conjunto padrão não foi medido.
        </p>
      )
    case 'stale':
      return (
        <p className="text-meta leading-relaxed text-attention">
          Nenhuma medição dentro do prazo. A última dizia{' '}
          <span className="font-mono">{PCT.format(reading.last.ratio)}</span>, e isso deixou de ser
          prova. Não é o mesmo que estar abaixo da meta: aqui não sabemos.
        </p>
      )
    case 'never':
      return <p className="text-meta leading-relaxed text-muted">{reading.note}</p>
    case 'error':
      return (
        <p className="text-meta text-attention">
          A consulta falhou ({reading.reason}). O silêncio não é prova de saúde.
        </p>
      )
  }
}

/** One line per keyword, weakest first, plus the ones that did not answer. */
function QueryList({ queries, missing }: { queries: CoverageQuery[]; missing: string[] }) {
  return (
    <dl className="m-0 flex flex-col gap-1.5 border-t border-line pt-3">
      {queries.map((query) => (
        <div key={query.q} className="flex flex-wrap items-baseline justify-between gap-x-3">
          <dt className="text-body text-muted">
            <span className="font-mono text-ink">{query.q}</span>
            {query.segment ? ` · ${query.segment}` : ''}
          </dt>
          <dd className="m-0 flex flex-wrap items-baseline gap-2">
            <span
              className={`font-mono text-lead tabular-nums ${query.met ? 'text-ink' : 'text-attention'}`}
            >
              {PCT.format(query.ratio)}
            </span>
            <span className="text-caption text-muted">
              {PT.format(query.held)} de {PT.format(query.collected)}
              {/* The only place the gap B41 describes is visible: PNCP's own
                  count beside what the walk actually reached. Printed on a
                  truncated row because that is the row where the two differ
                  for a reason the reader needs. */}
              {query.truncated
                ? ` · mais recentes${query.pncpTotal === null ? '' : ` de ${PT.format(query.pncpTotal)} no PNCP`}`
                : ''}
            </span>
          </dd>
        </div>
      ))}
      {missing.map((q) => (
        <div key={q} className="flex flex-wrap items-baseline justify-between gap-x-3">
          <dt className="text-body text-muted">
            <span className="font-mono text-ink">{q}</span>
          </dt>
          <dd className="m-0">
            <Tag tone="attention">sem medição</Tag>
          </dd>
        </div>
      ))}
    </dl>
  )
}
