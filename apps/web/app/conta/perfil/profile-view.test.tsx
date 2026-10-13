import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messages } from '@/lib/messages'
import { ProfileView } from './profile-view'

/**
 * `/conta/perfil`'s form — task **F31**.
 *
 * §4c: this suite has no jsdom, so these are markup assertions. What they can
 * pin is the **mechanism** — that the three inputs exist, inside the form, with
 * the names the action reads, and that the two fields the privacy policy does
 * not name are absent. What they cannot pin is a submit; `e2e/` is where the
 * result belongs, and the PR says which does which.
 */

const copy = messages.account.profile
const EMPTY = { name: null, birthDate: null, mobile: null, cnpj: null }

const render = (props: Partial<Parameters<typeof ProfileView>[0]> = {}) =>
  renderToStaticMarkup(
    <ProfileView
      action={() => {}}
      values={EMPTY}
      errors={[]}
      plan="promocional"
      planName="Fundador"
      {...props}
    />,
  )

/** The one `<input>` tag whose `name` is this, or a failure that says so. */
function inputNamed(markup: string, name: string): string {
  const found = [...markup.matchAll(/<input[^>]*>/g)].filter((tag) =>
    tag[0].includes(`name="${name}"`),
  )
  if (found.length !== 1) throw new Error(`expected one input named ${name}, found ${found.length}`)
  return found[0]![0]
}

describe('the profile form', () => {
  it('asks for exactly the four fields the privacy policy covers', () => {
    const out = render()
    for (const field of ['nome', 'nascimento', 'celular', 'cnpj']) {
      expect(out, field).toContain(`name="${field}"`)
    }
    for (const label of [copy.nameLabel, copy.birthLabel, copy.mobileLabel, copy.cnpjLabel]) {
      expect(out).toContain(label)
    }
  })

  /*
   * **This test used to assert the date of birth was absent.** It shipped that
   * way because the privacy policy named no date of birth anywhere, so
   * collecting one would have been an undisclosed personal datum. Sci approved
   * the amendment on 2026-10-13 (policy v1.4: §2, §4c and a §5 purpose row),
   * and the field arrived with it — which is the order this repository wants:
   * disclose, then collect.
   *
   * The CPF is still absent, and now for a product reason rather than a legal
   * one: **F32**, Sci's ruling that a CNPJ stays required, which leaves a CPF
   * satisfying only Asaas. The assertion stays so that adding one is a
   * deliberate act.
   */
  it('does not ask for a CPF, which no form collects by F32', () => {
    const out = render()
    expect(out).not.toContain('name="cpf"')
    expect(out.toLowerCase()).not.toContain('cpf')
  })

  it('collects the date of birth the policy now names, as a date input', () => {
    expect(inputNamed(render(), 'nascimento')).toContain('type="date"')
    // The purpose, said on the screen, because it is the only one §5 declares.
    expect(render()).toContain(copy.birthHelp)
  })

  /* F38 brings the column; until then the field would discard its answer. */
  it('does not ask for a business name, which has nowhere to go yet', () => {
    expect(render()).not.toContain('name="empresa"')
  })

  it('posts all four to the action, inside the form', () => {
    const out = render()
    const form = out.slice(out.indexOf('<form'), out.indexOf('</form>'))
    for (const field of ['name="nome"', 'name="nascimento"', 'name="celular"', 'name="cnpj"']) {
      // Inside the form, not merely on the page: an input outside it posts
      // nothing, and the action would read three blanks and reject all three.
      expect(form, field).toContain(field)
    }
    expect(form).toContain(copy.submit)
  })

  it('pre-fills what the account already has, so a fix is an edit', () => {
    const out = render({
      values: {
        name: 'Maria Silva',
        birthDate: '1980-05-20',
        mobile: '+5511999999999',
        cnpj: '36955612000185',
      },
    })
    expect(out).toContain('value="Maria Silva"')
    expect(out).toContain('value="1980-05-20"')
    expect(out).toContain('value="+5511999999999"')
    // Formatted for a reader, the way `company-form.tsx` does it.
    expect(out).toContain('value="36.955.612/0001-85"')
  })

  it('shows the error on the field that was rejected and not on the others', () => {
    const out = render({ errors: ['celular'] })
    expect(out).toContain(copy.mobileInvalid)
    expect(out).not.toContain(copy.nameInvalid)
    expect(out).not.toContain(copy.cnpjInvalid)
    // The error replaces the hint rather than stacking under it.
    expect(out).not.toContain(copy.mobileHelp)
    expect(out).toContain(copy.nameHelp)
  })

  it('can show every error at once', () => {
    const out = render({ errors: ['nome', 'nascimento', 'celular', 'cnpj'] })
    expect(out).toContain(copy.birthInvalid)
    expect(out).toContain(copy.nameInvalid)
    expect(out).toContain(copy.mobileInvalid)
    expect(out).toContain(copy.cnpjInvalid)
  })

  /*
   * `type="tel"`, not `inputMode="numeric"`: Sci's ruling was *"mobile number
   * (BR or other country)"*, and a numeric keypad has no `+`. That one
   * attribute is the difference between an international number being typeable
   * and not — `lib/profile/phone.ts` reads the `+` as the only signal that the
   * country code was stated.
   */
  it('lets a country code be typed', () => {
    // The whole `<input>` tag, found by its name rather than by a window of N
    // characters around it: the first version of this test sliced 200 either
    // side, and `type="tel"` sits ~250 before `name=` because `Field` spreads
    // the caller's props ahead of its own. It failed on an attribute that was
    // there, which is a test reporting a defect in itself.
    expect(inputNamed(render(), 'celular')).toContain('type="tel"')
    expect(inputNamed(render(), 'cnpj')).toContain('inputMode="numeric"')
    expect(render()).toContain(copy.mobileHelp)
  })

  it('links the privacy policy it is collecting under', () => {
    const out = render()
    expect(out).toContain('href="/privacidade"')
    expect(out).toContain(copy.privacyLink)
    // The placeholder is substituted, not printed.
    expect(out).not.toContain('{politica}')
  })
})
