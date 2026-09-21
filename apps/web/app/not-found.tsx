import Link from 'next/link'
import { AppBar, Button, Logo, StateCard } from '@/components'
import { messages } from '@/lib/messages'

/**
 * The branded 404.
 *
 * Added with task D3 because the Radar links into routes that later tasks own.
 * `/conta/criar` (U1) and `/conta/alertas` (E1) no longer reach it — R2 sent
 * every account control through `lib/routes.ts` to `/fundadores`, because a
 * `<Link>` to a route that does not exist is prefetched as a 404 and clicked
 * as a dead end. `/radar/edital/<id>/triagem` (D4) still lands here, as does
 * any mistyped tender id: this is what a visitor sees instead of Next's
 * unstyled default.
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
