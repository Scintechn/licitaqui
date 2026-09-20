import Link from 'next/link'
import { AppBar, Button, Logo, StateCard } from '@/components'
import { messages } from '@/lib/messages'

/**
 * The branded 404.
 *
 * Added with task D3 because the Radar links into routes that later tasks own
 * — `/conta/criar` (U1), `/conta/alertas` (E1),
 * `/radar/edital/<id>/triagem` (D4). Those are the addresses the approved
 * canvas gives those controls, so the links are right and the pages are simply
 * not built yet; until they are, this is what a visitor who follows one sees,
 * instead of Next's unstyled default.
 */

const copy = messages.radar.notFoundPage

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar
        leading={
          <Link href="/" aria-label={messages.radar.nav.home} className="inline-flex">
            <Logo size={30} />
          </Link>
        }
      />
      <main className="mx-auto flex w-full max-w-[560px] grow flex-col gap-4 px-gutter pt-8">
        <h1 className="font-display text-[28px] leading-tight font-semibold">{copy.title}</h1>
        <StateCard kind="empty" title={messages.errors.notFound} description={copy.body} />
        <div className="flex flex-col gap-2 min-[560px]:flex-row">
          <Button href="/radar" iconEnd="arrowRight">
            {copy.radar}
          </Button>
          <Button href="/" variant="secondary">
            {copy.home}
          </Button>
        </div>
      </main>
    </div>
  )
}
