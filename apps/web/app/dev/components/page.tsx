import type { Metadata } from 'next'
import {
  AppBar,
  AppBarAction,
  AppBarActionLink,
  AppBarBack,
  Button,
  Card,
  CardLink,
  CardRow,
  Field,
  ICON_NAMES,
  Icon,
  LockedBlock,
  LockedValue,
  Logo,
  LogoSymbol,
  SectionLabel,
  Select,
  StateCard,
  Status,
  Tag,
  TagList,
} from '@/components'

/**
 * `/dev/components` — the design system board as a live page.
 *
 * Internal tool, not a product screen: the labels below are hardcoded in
 * Brazilian Portuguese on purpose. Product copy belongs in
 * `apps/web/messages/pt-BR.json`, which this page deliberately does not touch.
 *
 * Every panel mirrors one section of `docs/design/wireframes/DesignSystem.dc.html`.
 */
export const metadata: Metadata = {
  title: 'Design system · LicitaQui',
  robots: { index: false, follow: false },
}

/* ------------------------------------------------------------------ layout */

function Panel({
  label,
  hint,
  children,
  className,
}: {
  label: string
  hint?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={`flex flex-col gap-3.5 ${className ?? ''}`}>
      <div className="flex items-baseline gap-2">
        <SectionLabel>{label}</SectionLabel>
        {hint ? <span className="text-caption text-muted">{hint}</span> : null}
      </div>
      {children}
    </section>
  )
}

/* ----------------------------------------------------------------- palette */

/**
 * Mirrors `apps/web/styles/tokens.css`. The swatch is painted with the Tailwind
 * utility, so if a token moves the swatch moves with it and the printed hex
 * stops matching — which is exactly the signal we want on this page.
 */
const PALETTE: { name: string; hex: string; swatch: string; utility: string }[] = [
  { name: 'Ivory · fundo', hex: '#FBF7F3', swatch: 'bg-ivory', utility: 'ivory' },
  { name: 'Branco · superfície', hex: '#FFFFFF', swatch: 'bg-surface', utility: 'surface' },
  { name: 'Grafite · texto', hex: '#171717', swatch: 'bg-ink', utility: 'ink' },
  { name: 'Cinza · secundário', hex: '#6B6B67', swatch: 'bg-muted', utility: 'muted' },
  { name: 'Azul · ação', hex: '#2457D6', swatch: 'bg-blue', utility: 'blue' },
  { name: 'Sucesso', hex: '#18794E', swatch: 'bg-success', utility: 'success' },
  { name: 'Atenção', hex: '#8F5200', swatch: 'bg-attention', utility: 'attention' },
  { name: 'Erro', hex: '#B42318', swatch: 'bg-error', utility: 'error' },
]

const SUPPORT: { name: string; hex: string; swatch: string }[] = [
  { name: 'blue-soft', hex: '#E8EEFB', swatch: 'bg-blue-soft' },
  { name: 'blue-line', hex: '#B9CBF3', swatch: 'bg-blue-line' },
  { name: 'blue-hover', hex: '#1A43A8', swatch: 'bg-blue-hover' },
  { name: 'blue-light', hex: '#5C86EC', swatch: 'bg-blue-light' },
  { name: 'success-soft', hex: '#E3F1EA', swatch: 'bg-success-soft' },
  { name: 'attention-soft', hex: '#F7EBDD', swatch: 'bg-attention-soft' },
  { name: 'attention-line', hex: '#E8CFAE', swatch: 'bg-attention-line' },
  { name: 'error-soft', hex: '#F8E4E1', swatch: 'bg-error-soft' },
  { name: 'line', hex: '#E7E1D9', swatch: 'bg-line' },
  { name: 'line-strong', hex: '#D6CFC5', swatch: 'bg-line-strong' },
  { name: 'field-line', hex: '#8A7F6D', swatch: 'bg-field-line' },
  { name: 'fill-muted', hex: '#F3EEE8', swatch: 'bg-fill-muted' },
]

function Palette() {
  return (
    <Panel label="Paleta de cores">
      <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-4">
        {PALETTE.map((token) => (
          <div key={token.utility} className="flex flex-col gap-1.5">
            <div className={`h-16 rounded-swatch border border-line ${token.swatch}`} />
            <div className="text-meta font-medium">{token.name}</div>
            <div className="font-mono text-caption text-muted">{token.hex}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {SUPPORT.map((token) => (
          <div key={token.name} className="flex items-center gap-2">
            <span className={`size-5 rounded border border-line ${token.swatch}`} />
            <span className="font-mono text-caption text-muted">
              {token.name} {token.hex}
            </span>
          </div>
        ))}
      </div>

      <p className="text-caption leading-relaxed text-muted">
        Contraste sobre o fundo: texto 16,8:1 · cinza 5,0:1 · azul 5,8:1 · atenção 4,9:1
        (todos passam AA)
      </p>
    </Panel>
  )
}

/* -------------------------------------------------------------- typography */

function Typography() {
  return (
    <Panel label="Tipografia">
      <div>
        <div className="text-meta">
          Archivo <span className="text-muted">· títulos e números</span>
        </div>
        <div className="font-display text-[44px] leading-[1.1] font-semibold">Aa R$ 48.196</div>
        <div className="text-caption text-muted">
          Medium · Semibold · Bold · eixo de largura (wdth) carregado
        </div>
      </div>
      <div>
        <div className="text-meta">
          IBM Plex Sans <span className="text-muted">· texto</span>
        </div>
        <div className="font-sans text-[32px]">Aa Baterias e pilhas</div>
        <div className="text-caption text-muted">Regular · Medium · Semibold</div>
      </div>
      <div>
        <div className="text-meta">
          IBM Plex Mono <span className="text-muted">· dados e rótulos</span>
        </div>
        <div className="font-mono text-[26px]">PROPOSTA ATÉ 0123456789</div>
        <div className="text-caption text-muted">Regular · Medium</div>
      </div>
      <div className="flex flex-col gap-1 border-t border-line pt-3">
        <span className="text-label font-mono text-muted">text-label · 11px</span>
        <span className="text-caption">text-caption · 12px</span>
        <span className="text-meta">text-meta · 13px</span>
        <span className="text-body">text-body · 14px</span>
        <span className="text-lead">text-lead · 15px</span>
      </div>
    </Panel>
  )
}

/* ------------------------------------------------------------------- logo */

function Brand() {
  return (
    <Panel label="Marca" hint="nunca alinhar as barras pela direita">
      <div className="flex flex-wrap items-end gap-6">
        <div className="flex flex-col items-start gap-2">
          <Logo size={30} />
          <span className="font-mono text-caption text-muted">full · brand</span>
        </div>
        <div className="flex flex-col items-start gap-2">
          <Logo size={44} tone="mono" />
          <span className="font-mono text-caption text-muted">full · mono</span>
        </div>
        <div className="flex flex-col items-start gap-2">
          <div className="rounded-card bg-ink p-3">
            <Logo size={30} tone="inverse" />
          </div>
          <span className="font-mono text-caption text-muted">full · inverse (no grafite)</span>
        </div>
        <div className="flex flex-col items-start gap-2">
          <div className="rounded-card bg-blue p-3">
            <Logo size={30} tone="ivory" />
          </div>
          <span className="font-mono text-caption text-muted">full · ivory (no azul)</span>
        </div>
        <div className="flex flex-col items-start gap-2">
          <div className="flex items-end gap-3">
            <LogoSymbol size={24} />
            <LogoSymbol size={40} />
            <LogoSymbol size={64} />
          </div>
          <span className="font-mono text-caption text-muted">símbolo · 24 / 40 / 64</span>
        </div>
      </div>
    </Panel>
  )
}

/* -------------------------------------------------------------- components */

function Controls() {
  return (
    <Panel label="Componentes">
      <Field
        id="ds-cnpj"
        label="CNPJ da empresa"
        placeholder="00.000.000/0001-00"
        icon="company"
        mono
        inputMode="numeric"
      />
      <Field
        id="ds-keyword"
        label="Palavra-chave"
        placeholder="baterias"
        hint="Usada quando o CNAE não encontra nada."
      />
      <Field
        id="ds-uf"
        label="UF"
        defaultValue="SPP"
        error="Use a sigla do estado com duas letras."
      />
      {/* Added by task D3: the board's "UF onde você entrega" picker. */}
      <Select
        id="ds-select"
        label="UF onde você entrega"
        options={[
          { value: '', label: 'Todo o Brasil' },
          { value: 'SP', label: 'São Paulo (SP)' },
          { value: 'RJ', label: 'Rio de Janeiro (RJ)' },
        ]}
      />

      <div className="flex flex-col gap-2.5">
        <Button iconEnd="arrowRight" fullWidth>
          Botão principal
        </Button>
        <Button variant="secondary" fullWidth>
          Botão secundário
        </Button>
        <Button variant="locked" fullWidth>
          Travado: precisa de conta
        </Button>
        <div>
          <Button variant="link" href="#" iconEnd="arrowRight">
            Link secundário
          </Button>
        </div>
        <div>
          <Button disabled>Desabilitado</Button>
        </div>
      </div>
    </Panel>
  )
}

/* ----------------------------------------------------------------- app bar */

function Bars() {
  return (
    <Panel label="App bar" hint="60px · alvos de toque 44px">
      <Card padding="none" className="overflow-hidden">
        <AppBar
          leading={<Logo size={30} />}
          actions={
            <>
              <AppBarAction icon="alert" label="Alertas" />
              <AppBarActionLink icon="account" label="Conta" href="#" />
            </>
          }
        />
      </Card>
      <Card padding="none" className="overflow-hidden">
        <AppBar
          leading={<AppBarBack href="#">Voltar</AppBarBack>}
          title="Até quanto ofertar?"
          actions={<Tag tone="blue">Essencial</Tag>}
        />
      </Card>
    </Panel>
  )
}

/* ------------------------------------------------------------ badges, tags */

function Badges() {
  return (
    <Panel label="Badges e status">
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-3">
          <Status kind="compatible">Compatível</Status>
          <span className="text-meta text-muted">seu CNAE atende</span>
        </div>
        <div className="flex items-center gap-3">
          <Status kind="check">Verificar</Status>
          <span className="text-meta text-muted">pode haver exigências</span>
        </div>
        <div className="flex items-center gap-3">
          <Status kind="keyword">Palavra-chave</Status>
          <span className="text-meta text-muted">achado pela busca</span>
        </div>
      </div>

      <TagList>
        <Tag tone="blue">Exclusivo ME/EPP</Tag>
        <Tag>Cota ME/EPP</Tag>
        <Tag>Sem cota</Tag>
        <Tag tone="attention">Exige licença sanitária</Tag>
        <Tag tone="muted">Essencial</Tag>
      </TagList>

      <SectionLabel tone="muted">Ícones · traço 1.8</SectionLabel>
      <div className="flex flex-wrap gap-3.5">
        {ICON_NAMES.map((name) => (
          <div
            key={name}
            className="flex w-16 flex-col items-center gap-1 text-caption text-muted"
          >
            <Icon name={name} size={22} className="text-ink" />
            <span className="font-mono text-[10px] break-all">{name}</span>
          </div>
        ))}
      </div>
    </Panel>
  )
}

/* ------------------------------------------------------------------ states */

function States() {
  return (
    <Panel label="Estados">
      <StateCard
        kind="analyzing"
        title="Analisando edital…"
        description="Lendo documentos e conferindo exigências"
      />
      <StateCard kind="found" title="Oportunidade encontrada" description="Análise concluída" />
      <StateCard
        kind="empty"
        title="Nenhum edital compatível agora"
        description="Amplie as UFs ou adicione uma palavra-chave."
        action={
          <Button variant="link" href="#" iconEnd="arrowRight" className="px-0">
            Ajustar filtros
          </Button>
        }
      />
      <StateCard
        kind="limit"
        title="Limite do visitante"
        description="Seus 3 dias ou 2 triagens acabaram. Crie a conta grátis para continuar."
      />
    </Panel>
  )
}

/* ------------------------------------------------------------ cards, locks */

function Surfaces() {
  return (
    <Panel label="Cards e bloco travado">
      <CardLink href="#">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Status kind="compatible">Compatível</Status>
            <span className="text-caption text-muted">13 dias</span>
          </div>
          <div className="text-lead leading-snug font-semibold">Baterias e pilhas</div>
          <div className="text-meta text-muted">
            Prefeitura de Campinas/SP · Pregão eletrônico
          </div>
          <div className="flex items-baseline justify-between">
            <span className="font-display text-[22px] font-semibold">R$ 48.196</span>
            <span className="text-caption text-muted">7 itens</span>
          </div>
          <TagList>
            <Tag tone="blue">Exclusivo ME/EPP</Tag>
            <Tag>7 itens</Tag>
          </TagList>
        </div>
      </CardLink>

      <Card>
        <SectionLabel tone="muted">Referências de preço</SectionLabel>
        <CardRow label="Edital paga (estimado)" value="R$ 3,74" />
        <CardRow
          label={
            <span className="flex items-center gap-1.5">
              <Icon name="locked" size={14} className="text-muted" />
              Venceu em editais parecidos
            </span>
          }
          value={<LockedValue label="Disponível no plano Essencial" />}
        />
        <CardRow
          label={
            <span className="flex items-center gap-1.5">
              <Icon name="locked" size={14} className="text-muted" />
              Preço de mercado + frete
            </span>
          }
          value={<LockedValue label="Disponível no plano Essencial" />}
          last
        />
      </Card>

      <Card accent className="flex flex-col gap-2.5">
        <div className="text-body font-medium text-blue">Seu preço máximo de compra</div>
        <div className="flex items-center gap-2.5">
          <span className="font-display text-[30px] font-semibold text-muted">R$</span>
          <LockedValue width={110} height={30} label="Disponível no plano Essencial" />
        </div>
        <div className="text-meta leading-relaxed text-muted">
          Calculado com imposto, frete e a margem que você escolher.
        </div>
      </Card>

      <LockedBlock
        href="#"
        icon="margin"
        title="Até quanto ofertar com lucro?"
        description="Preço que venceu e preço-alvo · Essencial"
      />
      <LockedBlock href="#" title="Baixar o edital" description="Precisa de conta grátis" />
    </Panel>
  )
}

/* ---------------------------------------------------------------- telegram */

function TelegramAlert() {
  const items = [
    { title: 'Baterias e pilhas · Campinas/SP', meta: 'R$ 48 mil · exclusivo ME/EPP · 30/09' },
    { title: 'Materiais hospitalares · Campinas/SP', meta: 'R$ 1,25 mi · exige licença sanitária' },
    { title: 'Sistema web SaaS · Americana/SP', meta: 'R$ 4,3 mi · atestado de 650 usuários' },
  ]
  return (
    <Panel label="Alerta no Telegram">
      <Card padding="sm" className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <span className="inline-flex size-7 items-center justify-center rounded-pill bg-blue">
            <LogoSymbol size={20} tone="ivory" />
          </span>
          <span className="text-meta font-semibold">LicitaQui</span>
        </div>
        <div className="text-lead font-semibold">3 editais novos para sua empresa</div>
        {items.map((item) => (
          <div key={item.title} className="flex items-start gap-2">
            <Icon name="tender" size={16} className="mt-0.5 text-blue" />
            <div>
              <div className="text-body font-semibold">{item.title}</div>
              <div className="text-caption text-muted">{item.meta}</div>
            </div>
          </div>
        ))}
        <div className="flex min-h-10 items-center justify-center rounded-control bg-blue-soft text-body font-semibold text-blue">
          Ver triagens
        </div>
        <div className="text-caption text-muted">Telegram · segunda 07:00</div>
      </Card>
    </Panel>
  )
}

/* -------------------------------------------------------------------- page */

export default function DevComponentsPage() {
  return (
    <main className="mx-auto flex max-w-[1600px] flex-col gap-7 px-gutter py-9 xl:px-10">
      <div className="flex flex-wrap items-baseline gap-4">
        <h1 className="font-display text-[clamp(28px,6vw,36px)] font-semibold">
          LicitaQui · design system
        </h1>
        <span className="text-body text-muted">v1 · Radar grátis e app</span>
      </div>
      <p className="max-w-[70ch] text-meta text-muted">
        Página interna (D1). Espelha{' '}
        <code className="font-mono">docs/design/wireframes/DesignSystem.dc.html</code>. Os textos
        aqui são fixos de propósito: a cópia do produto vive em{' '}
        <code className="font-mono">messages/pt-BR.json</code>.
      </p>

      {/* 390px: one column. 1280px+: the board's three-column rhythm. */}
      <div className="grid gap-9 border-t border-line pt-7 xl:grid-cols-[1.3fr_1fr_0.9fr]">
        <Palette />
        <Typography />
        <Controls />
      </div>

      <div className="grid gap-9 border-t border-line pt-7 xl:grid-cols-[1fr_1.1fr_0.9fr]">
        <Badges />
        <States />
        <TelegramAlert />
      </div>

      <div className="grid gap-9 border-t border-line pt-7 xl:grid-cols-[1.3fr_1.7fr]">
        <div className="flex flex-col gap-9">
          <Brand />
          <Bars />
        </div>
        <Surfaces />
      </div>
    </main>
  )
}
