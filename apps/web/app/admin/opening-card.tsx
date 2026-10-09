import { Card, SectionLabel, Status, Tag } from '@/components'
import type { Opening, OpeningReading, OpeningWatch } from '@/lib/admin/opening'

/**
 * Whether the dated founders-opening broadcast is still queued — card **E20**,
 * built in `CoverageCard`'s shape rather than as a third idiom.
 *
 * **It has already happened, which is why this card exists.** On 2026-10-03 the
 * single `jobs` row the whole opening depends on was deleted, and two days
 * passed with nothing scheduled and nothing noticing; the 2026-10-05 audit found
 * it by querying `jobs` by hand. The WhatsApp already in founders' hands says
 * *"No dia 17 de outubro de 2026 eu mando aqui o link de acesso"*.
 *
 * ## Seven states and a staleness, and none may read like another
 *
 * `missing` — we looked, recently, and the row is not there. The loudest thing
 * on this screen, and the one the card is named for.
 *
 * `misdated` — a live row exists for a different instant than the one this
 * build computes. The near miss: *a row exists* is not the question.
 *
 * `late` — the instant has passed by more than the grace window and the row is
 * still claimable. No consumer, or a wedged one.
 *
 * `fired_early` — `done` before the instant it was queued for. Every seated
 * founder has an access link to a product that is not open.
 *
 * `failed` — the newest row under the key is `failed` and nothing live replaced
 * it.
 *
 * `queued` / `sent` — the only two that are not alarms, and `sent` is **not**
 * per-recipient proof: `docs/CLAIMS.md` is explicit that a `jobs` status said
 * the founders welcome had been sent for days while the kill switch was off
 * (E4). The card says so rather than letting a green badge imply it.
 *
 * `stale` — nothing looked inside the threshold. A fact about the watchdog, not
 * about the queue, and printing it as `queued` is how B32 lasted two days.
 *
 * ## The date the worker is dated by, printed because it was unverifiable
 *
 * E5 recorded that whether the deployed container sets `FOUNDERS_OPENING_DATE`
 * is **unverifiable from a laptop**. The reading carries both the effective date
 * and `product.OPENING_DATE`, so this card is where that stops being true. It is
 * the quietest possible failure: the scheduling script and the check read the
 * same variable, agree perfectly, and everything looks healthy over a broadcast
 * dated for a day the product has moved off.
 *
 * ## Breakpoints
 *
 * `sm:` viewport queries are correct **here** and would not be inside the app
 * shell: `/admin` renders under `AppBar` in a `max-w-6xl` column with no
 * collapsible rail, so there is no 264px the window cannot see. See `CLAUDE.md`
 * on why the same classes are wrong in `app-shell.tsx`'s column.
 */

const PT = new Intl.NumberFormat('pt-BR')

/**
 * Both clocks in one string, always labelled.
 *
 * CLAUDE.md's clocks table: the product is BRT, the database is UTC, and mixing
 * the two has produced a wrong answer in this repo — a worker declared stalled
 * for an hour on exactly that mistake. Nothing on this card prints a time
 * without saying which clock it is in.
 */
const BRT = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Sao_Paulo',
})
const UTC = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'UTC',
})

function bothClocks(at: Date): string {
  return `${BRT.format(at)} BRT · ${UTC.format(at)} UTC`
}

/** Hours while hours are still readable, days after. Mirrors `CoverageCard`. */
function age(hours: number): string {
  const whole = Math.floor(Math.abs(hours))
  if (whole < 96) return `${PT.format(whole)} h`
  return `${PT.format(Math.floor(whole / 24))} dias`
}

/** How long until the broadcast, or how long since. Never an unsigned number. */
function countdown(hours: number): string {
  if (hours >= 0) return `faltam ${age(hours)}`
  return `passou há ${age(hours)}`
}

export function OpeningCard({ opening }: { opening: OpeningWatch }) {
  const { watch } = opening
  // **Two dimensions, both required.** The row being queued and a message
  // being able to leave the process are different facts with different fixes,
  // and a green accent over a dead switch is the failure E20's card names:
  // nothing happening on the day while every signal stays green.
  const healthy = watch.kind === 'current' && !watch.reading.alarm && watch.reading.deliveryReady
  return (
    <section className="flex flex-col gap-3.5">
      <div className="flex items-baseline gap-2">
        <SectionLabel>Disparo da abertura</SectionLabel>
        <span className="text-caption text-muted">
          a promessa &ldquo;eu mando aqui o link de acesso&rdquo;, como linha na fila
        </span>
      </div>

      <Card className="flex flex-col gap-3" accent={healthy}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="text-lead font-semibold text-ink">
            A linha datada do disparo aos fundadores
          </div>
          <OpeningBadge watch={watch} />
        </div>

        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-stat tabular-nums text-ink">{headline(watch)}</span>
          <span className="text-meta text-muted">{beside(opening)}</span>
        </div>

        <OpeningNote watch={watch} />
        {'reading' in watch && !watch.reading.deliveryReady ? (
          <p className="text-meta leading-relaxed text-attention">
            <strong>Uma das chaves de envio está desligada no worker.</strong> A linha pode
            estar perfeita e ainda assim ninguém recebe nada: o envio renderiza a mensagem,
            grava <span className="font-mono">dry_run</span> e para aí. Isto não é a mesma
            coisa que a linha faltar — conserta-se com variável de ambiente, não com comando.
          </p>
        ) : null}

        {'reading' in watch ? <OpeningDetail reading={watch.reading} /> : null}

        <div className="mt-auto pt-1 font-mono text-caption text-muted">{opening.source}</div>
      </Card>
    </section>
  )
}

/**
 * The countdown to the broadcast, which is the number that decides whether
 * anything can still be done. An em dash when there is no reading — never a
 * zero, which would read as *due now*.
 */
function headline(watch: Opening): string {
  switch (watch.kind) {
    case 'current':
    case 'stale':
    case 'unknown':
      return countdown(watch.reading.hoursToDue)
    case 'never':
    case 'error':
      return '—'
  }
}

/** What the headline is about, so the number is never ambiguous. */
function beside(opening: OpeningWatch): string {
  const { watch } = opening
  const alarm = `alerta depois de ${PT.format(opening.thresholdHours)} h sem conferir`
  switch (watch.kind) {
    case 'current':
    case 'unknown': {
      const { dueAt, hourBrt } = watch.reading
      return `disparo ${bothClocks(dueAt)} (${hourBrt} BRT) · conferido há ${age(watch.reading.hours)}`
    }
    case 'stale':
      // Hours against hours: "há 3 dias · alerta depois de 3 dias" reads as a
      // contradiction of itself at 73 h. `CoverageCard`'s review caught that
      // there; the same two units are kept here.
      return `última conferência há ${age(watch.reading.hours)} · ${alarm}`
    case 'never':
    case 'error':
      return `${alarm}, e nunca conferiu`
  }
}

function OpeningBadge({ watch }: { watch: Opening }) {
  switch (watch.kind) {
    case 'stale':
      return <Tag tone="attention">sem conferência recente</Tag>
    case 'never':
      return <Tag tone="muted">nunca conferiu</Tag>
    case 'error':
      return <Tag tone="attention">erro</Tag>
    case 'unknown':
      return <Tag tone="attention">estado desconhecido</Tag>
    case 'current':
      switch (watch.reading.state) {
        case 'queued':
          return <Status kind="positive">na fila</Status>
        case 'sent':
          return <Status kind="positive">disparado</Status>
        case 'missing':
          return <Tag tone="attention">não está na fila</Tag>
        case 'misdated':
          return <Tag tone="attention">data divergente</Tag>
        case 'late':
          return <Tag tone="attention">atrasado</Tag>
        case 'fired_early':
          return <Tag tone="attention">disparou antes</Tag>
        case 'failed':
          return <Tag tone="attention">falhou</Tag>
      }
  }
}

/** One sentence per state, and they are deliberately not interchangeable. */
function OpeningNote({ watch }: { watch: Opening }) {
  const bad = 'text-meta leading-relaxed text-attention'
  switch (watch.kind) {
    case 'error':
      return (
        <p className="text-meta text-attention">
          A consulta falhou ({watch.reason}). O silêncio não é prova de saúde.
        </p>
      )
    case 'never':
      return <p className="text-meta leading-relaxed text-muted">{watch.note}</p>
    case 'unknown':
      return (
        <p className={bad}>
          A conferência gravou o estado{' '}
          <span className="font-mono">{watch.reading.state}</span>, que esta versão da tela não
          sabe ler. Nada aqui autoriza dizer que o disparo está em ordem.
        </p>
      )
    case 'stale':
      return (
        <p className={bad}>
          Nenhuma conferência dentro do prazo. A última dizia{' '}
          <span className="font-mono">{watch.reading.state}</span>, e isso deixou de ser prova.
          Não é o mesmo que a linha ter desaparecido: aqui não sabemos.
        </p>
      )
    case 'current':
      return <StateNote reading={watch.reading} />
  }
}

function StateNote({ reading }: { reading: OpeningReading }) {
  const bad = 'text-meta leading-relaxed text-attention'
  switch (reading.state) {
    case 'queued':
      return (
        <p className="text-meta leading-relaxed text-muted">
          A linha está na fila para o instante configurado. Ela fica inerte até a hora chegar,
          um consumidor estar rodando e as chaves de envio estarem ligadas — nada disso é
          decidido por esta tela.
        </p>
      )
    case 'sent':
      return (
        <p className="text-meta leading-relaxed text-muted">
          A linha rodou. <strong>Isso não é prova por destinatário:</strong> o status de um job
          disse por dias que as boas-vindas tinham sido enviadas enquanto a chave estava
          desligada (E4). A prova é um evento <span className="font-mono">whatsapp.sent</span> /{' '}
          <span className="font-mono">email.sent</span> por pessoa — rode{' '}
          <span className="font-mono">preview_founders_opening.py</span> de novo.
        </p>
      )
    case 'missing':
      return (
        <p className={bad}>
          <strong>Não existe linha nenhuma com essa chave.</strong> Foi exatamente isto em
          03/10/2026: o job 103288 foi apagado e dois dias passaram sem ninguém notar. Nada vai
          agendar sozinho — alguém precisa rodar{' '}
          <span className="font-mono">schedule_founders_opening.py --commit</span>.
        </p>
      )
    case 'misdated':
      return (
        <p className={bad}>
          Existe linha viva, para um instante diferente do configurado. Ou a linha está errada,
          ou a configuração está — esta tela não sabe qual, e imprime as duas abaixo.
        </p>
      )
    case 'late':
      return (
        <p className={bad}>
          O instante passou e a linha continua reclamável. Nenhum consumidor a pegou: ou não há
          consumidor rodando, ou ele travou.
        </p>
      )
    case 'fired_early':
      return (
        <p className={bad}>
          A linha rodou <strong>antes</strong> do instante para o qual foi agendada. Se isso
          aconteceu, todo fundador com vaga recebeu um link de acesso para um produto que ainda
          não abriu.
        </p>
      )
    case 'failed':
      return (
        <p className={bad}>
          A linha mais recente com essa chave falhou e nada vivo a substituiu. O índice{' '}
          <span className="font-mono">jobs_dedupe</span> é parcial, então uma linha morta não
          impede uma nova: rodar{' '}
          <span className="font-mono">schedule_founders_opening.py --commit</span> coloca outra.
        </p>
      )
  }
}

/**
 * The facts the reading carried, so every sentence above is checkable.
 *
 * Typed on everything **except** `state`: these rows are what makes an
 * `unknown` state diagnosable at all, so the detail list has to render for a
 * reading whose state word this build does not recognise.
 */
function OpeningDetail({ reading }: { reading: Omit<OpeningReading, 'state'> }) {
  return (
    <dl className="m-0 flex flex-col gap-1.5 border-t border-line pt-3">
      <Row label="instante do disparo">{bothClocks(reading.dueAt)}</Row>
      <Row label="chave procurada">
        <span className="font-mono">{reading.expectedKey}</span>
      </Row>
      <Row label="job">
        {reading.jobId === null ? (
          <span className="text-attention">nenhum</span>
        ) : (
          <>
            <span className="font-mono">#{reading.jobId}</span> · {reading.jobStatus}
            {reading.jobRunAfter === null ? '' : ` · run_after ${bothClocks(reading.jobRunAfter)}`}
          </>
        )}
      </Row>
      <Row label="data da abertura no worker">
        {/* The env override, made visible — see the module comment. */}
        <span className={reading.dateMatchesProduct ? '' : 'text-attention'}>
          {reading.openingDate}
          {reading.dateMatchesProduct
            ? ''
            : ` ≠ ${reading.productOpeningDate} (product.json) — FOUNDERS_OPENING_DATE`}
        </span>
      </Row>
      <Row label="chaves de envio (no worker)">
        {/* The deployed worker's own values. The preview script prints these
            from whatever process runs it, which from a laptop is the laptop —
            so this row is the only place the production answer appears. */}
        <span className={reading.whatsappDelivery === 'send' ? '' : 'text-attention'}>
          WHATSAPP_DELIVERY={reading.whatsappDelivery ?? '—'}
        </span>{' · '}
        <span className={reading.emailDelivery === 'send' ? '' : 'text-attention'}>
          EMAIL_DELIVERY={reading.emailDelivery ?? '—'}
        </span>
      </Row>
      <Row label="fundadores">
        {PT.format(reading.seated)} com vaga ·{' '}
        <span className={reading.waitlisted > 0 ? 'text-attention' : ''}>
          {PT.format(reading.waitlisted)} na espera, que este disparo não alcança
        </span>
      </Row>
    </dl>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
      <dt className="text-body text-muted">{label}</dt>
      <dd className="m-0 text-caption text-ink">{children}</dd>
    </div>
  )
}
