import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'LicitaQui',
  description: 'Encontre licitações públicas que a sua MEI ou ME consegue atender.',
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  )
}
