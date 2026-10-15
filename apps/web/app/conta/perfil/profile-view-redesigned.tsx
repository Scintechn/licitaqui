'use client'

import Link from 'next/link'
import { Button, Field } from '@/components'
import { formatCnpj } from '@/lib/cnpj'
import { messages } from '@/lib/messages'
import { AccountChrome } from '../account-chrome'

const copy = messages.account.profile

function cnpjValue(value: string | null): string {
  if (!value) return ''
  return /^\d{14}$/.test(value) ? formatCnpj(value) : value
}

export type ProfileViewRedesignedProps = {
  action: (formData: FormData) => void | Promise<void>
  values: {
    name: string | null
    birthDate: string | null
    mobile: string | null
    cnpj: string | null
  }
  errors: readonly string[]
  plan: string
  planName: string
  hideTitle?: boolean
}

export function ProfileViewRedesigned({
  action,
  values,
  errors,
  plan,
  planName,
  hideTitle,
}: ProfileViewRedesignedProps) {
  const failed = (field: string) => errors.includes(field)

  const content = (
    <div className="flex flex-col gap-8 py-6 mt-4">
        {/* Profile Description */}
        <section>
          <p className="text-body text-muted">{copy.subtitle}</p>
        </section>

        {/* Profile Form Card */}
        <section className="flex flex-col gap-4">
          <h2 className="text-base font-semibold text-ink">Seus dados</h2>
          <div className="rounded-lg border border-line bg-surface p-6">
            <form action={action} className="flex flex-col gap-4">
              <Field
                id="perfil-nome"
                name="nome"
                label={copy.nameLabel}
                placeholder={copy.namePlaceholder}
                defaultValue={values.name ?? ''}
                error={failed('nome') ? copy.nameInvalid : undefined}
                hint={failed('nome') ? undefined : copy.nameHelp}
                autoComplete="name"
                maxLength={120}
                required
              />

              <Field
                id="perfil-nascimento"
                name="nascimento"
                label={copy.birthLabel}
                defaultValue={values.birthDate ?? ''}
                error={failed('nascimento') ? copy.birthInvalid : undefined}
                hint={failed('nascimento') ? undefined : copy.birthHelp}
                type="date"
                autoComplete="bday"
                required
              />

              <Field
                id="perfil-celular"
                name="celular"
                label={copy.mobileLabel}
                placeholder={copy.mobilePlaceholder}
                defaultValue={values.mobile ?? ''}
                error={failed('celular') ? copy.mobileInvalid : undefined}
                hint={failed('celular') ? undefined : copy.mobileHelp}
                type="tel"
                autoComplete="tel"
                required
              />

              <Field
                id="perfil-cnpj"
                name="cnpj"
                label={copy.cnpjLabel}
                placeholder={copy.cnpjPlaceholder}
                defaultValue={cnpjValue(values.cnpj)}
                error={failed('cnpj') ? copy.cnpjInvalid : undefined}
                hint={failed('cnpj') ? undefined : copy.cnpjHelp}
                inputMode="numeric"
                autoComplete="off"
                mono
                required
              />

              <Button type="submit" fullWidth>
                {copy.submit}
              </Button>
            </form>
          </div>
        </section>

        {/* Privacy Notice */}
        <section className="rounded-lg border border-line bg-surface p-6">
          <p className="text-meta leading-[1.45] text-muted">
            {copy.privacy.split('{politica}')[0]}
            <Link href="/privacidade" className="underline hover:no-underline">
              {copy.privacyLink}
            </Link>
            {copy.privacy.split('{politica}')[1]}
          </p>
        </section>
      </div>
  )

  if (hideTitle) return content

  return (
    <AccountChrome plan={plan} planName={planName} title={copy.title}>
      {content}
    </AccountChrome>
  )
}
