import { describe, expect, it } from 'vitest'
import {
  ADMIN_EMAILS_VAR,
  ADMIN_PASSWORD_VAR,
  adminConfig,
  authorizeAdmin,
  constantTimeEquals,
  denyResponse,
  isAllowedAdmin,
  MIN_PASSWORD_LENGTH,
  parseAllowlist,
  parseBasicHeader,
  type Env,
} from './auth'

/**
 * The gate in front of the founders list. Most of this file is one idea:
 * **every** way of being misconfigured denies access. A test suite that only
 * checks the happy path is how an admin page ends up open.
 */

const PASSWORD = 'uma-senha-bem-comprida'
const EMAIL = 'sci@scintechn.com'

const CONFIGURED: Env = { [ADMIN_EMAILS_VAR]: EMAIL, [ADMIN_PASSWORD_VAR]: PASSWORD }

function basic(user: string, password: string): Headers {
  const encoded = Buffer.from(`${user}:${password}`, 'utf8').toString('base64')
  return new Headers({ authorization: `Basic ${encoded}` })
}

describe('parseAllowlist', () => {
  it('splits on commas, semicolons and whitespace, and lowercases', () => {
    expect(parseAllowlist('A@x.com, b@x.com;C@x.com\nd@x.com')).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
      'd@x.com',
    ])
  })

  it('drops entries that are not addresses, so a typo cannot look configured', () => {
    expect(parseAllowlist('sci, , ;')).toEqual([])
  })

  it('de-duplicates', () => {
    expect(parseAllowlist('a@x.com,A@X.COM')).toEqual(['a@x.com'])
  })

  it('reads an unset variable as an empty list, never as "everyone"', () => {
    expect(parseAllowlist(undefined)).toEqual([])
    expect(parseAllowlist('')).toEqual([])
  })
})

describe('isAllowedAdmin', () => {
  it('matches whole addresses only, case-insensitively', () => {
    const list = ['sci@scintechn.com']
    expect(isAllowedAdmin('SCI@scintechn.com', list)).toBe(true)
    expect(isAllowedAdmin(' sci@scintechn.com ', list)).toBe(true)
    // A substring must never be enough.
    expect(isAllowedAdmin('sci@scintechn.com.attacker.test', list)).toBe(false)
    expect(isAllowedAdmin('xsci@scintechn.com', list)).toBe(false)
  })
})

describe('adminConfig fails closed', () => {
  const broken: [string, Env][] = [
    ['nothing set at all', {}],
    ['no allowlist', { [ADMIN_PASSWORD_VAR]: PASSWORD }],
    ['empty allowlist', { [ADMIN_EMAILS_VAR]: '', [ADMIN_PASSWORD_VAR]: PASSWORD }],
    ['allowlist of blanks', { [ADMIN_EMAILS_VAR]: ' , ; ', [ADMIN_PASSWORD_VAR]: PASSWORD }],
    ['allowlist without an @', { [ADMIN_EMAILS_VAR]: 'sci', [ADMIN_PASSWORD_VAR]: PASSWORD }],
    ['no password', { [ADMIN_EMAILS_VAR]: EMAIL }],
    ['empty password', { [ADMIN_EMAILS_VAR]: EMAIL, [ADMIN_PASSWORD_VAR]: '' }],
    ['short password', { [ADMIN_EMAILS_VAR]: EMAIL, [ADMIN_PASSWORD_VAR]: 'x'.repeat(MIN_PASSWORD_LENGTH - 1) }],
  ]

  for (const [name, env] of broken) {
    it(`refuses to consider itself configured: ${name}`, () => {
      expect(adminConfig(env).configured).toBe(false)
    })
  }

  it('is configured only when both variables are usable', () => {
    expect(adminConfig(CONFIGURED)).toEqual({
      configured: true,
      allowlist: [EMAIL],
      password: PASSWORD,
    })
  })
})

describe('authorizeAdmin fails closed', () => {
  it('denies everything when nothing is configured — credentials included', () => {
    expect(authorizeAdmin(basic(EMAIL, PASSWORD), {})).toEqual({
      ok: false,
      reason: 'not_configured',
    })
    // Not even a correct-looking password invents an allowlist.
    expect(authorizeAdmin(basic(EMAIL, PASSWORD), { [ADMIN_PASSWORD_VAR]: PASSWORD })).toEqual({
      ok: false,
      reason: 'not_configured',
    })
    // And an allowlist with no password is not a gate either.
    expect(authorizeAdmin(basic(EMAIL, ''), { [ADMIN_EMAILS_VAR]: EMAIL })).toEqual({
      ok: false,
      reason: 'not_configured',
    })
  })

  it('denies an empty allowlist even when the password matches', () => {
    const env: Env = { [ADMIN_EMAILS_VAR]: '   ', [ADMIN_PASSWORD_VAR]: PASSWORD }
    expect(authorizeAdmin(basic(EMAIL, PASSWORD), env)).toEqual({
      ok: false,
      reason: 'not_configured',
    })
  })

  it('asks for credentials when none arrive', () => {
    expect(authorizeAdmin(new Headers(), CONFIGURED)).toEqual({
      ok: false,
      reason: 'missing_credentials',
    })
  })

  it('rejects a header that is not Basic, or not decodable', () => {
    for (const header of ['Bearer abc', 'Basic', 'Basic !!!!', 'Basic ' + btoa('nocolon')]) {
      expect(authorizeAdmin(new Headers({ authorization: header }), CONFIGURED).ok).toBe(false)
    }
  })

  it('rejects an e-mail that is not on the list', () => {
    expect(authorizeAdmin(basic('outra@pessoa.com', PASSWORD), CONFIGURED)).toEqual({
      ok: false,
      reason: 'bad_credentials',
    })
  })

  it('rejects the right e-mail with the wrong password', () => {
    expect(authorizeAdmin(basic(EMAIL, `${PASSWORD}x`), CONFIGURED)).toEqual({
      ok: false,
      reason: 'bad_credentials',
    })
    expect(authorizeAdmin(basic(EMAIL, PASSWORD.slice(0, -1)), CONFIGURED)).toEqual({
      ok: false,
      reason: 'bad_credentials',
    })
  })

  it('cannot tell an unknown e-mail from a wrong password', () => {
    const unknown = authorizeAdmin(basic('outra@pessoa.com', PASSWORD), CONFIGURED)
    const wrong = authorizeAdmin(basic(EMAIL, 'errada-mas-comprida'), CONFIGURED)
    expect(unknown).toEqual(wrong)
  })

  it('lets an allowlisted e-mail with the right password in, and normalises it', () => {
    expect(authorizeAdmin(basic('SCI@Scintechn.com', PASSWORD), CONFIGURED)).toEqual({
      ok: true,
      email: EMAIL,
    })
  })

  it('accepts any address on a multi-entry list', () => {
    const env: Env = {
      [ADMIN_EMAILS_VAR]: `${EMAIL}, dev@scintechn.com`,
      [ADMIN_PASSWORD_VAR]: PASSWORD,
    }
    expect(authorizeAdmin(basic('dev@scintechn.com', PASSWORD), env).ok).toBe(true)
  })
})

describe('parseBasicHeader', () => {
  it('splits on the first colon only, so a password may contain one', () => {
    expect(parseBasicHeader(`Basic ${btoa('a@b.com:pa:ss:word')}`)).toEqual({
      user: 'a@b.com',
      password: 'pa:ss:word',
    })
  })

  it('reads UTF-8 credentials', () => {
    const encoded = Buffer.from('joão@x.com:señha-comprida', 'utf8').toString('base64')
    expect(parseBasicHeader(`Basic ${encoded}`)).toEqual({
      user: 'joão@x.com',
      password: 'señha-comprida',
    })
  })

  it('is case-insensitive about the scheme', () => {
    expect(parseBasicHeader(`basic ${btoa('a@b.com:x')}`)?.user).toBe('a@b.com')
  })

  it('returns null rather than a half-parsed guess', () => {
    expect(parseBasicHeader(null)).toBeNull()
    expect(parseBasicHeader('')).toBeNull()
    expect(parseBasicHeader(`Basic ${btoa(':only-a-password')}`)).toBeNull()
  })
})

describe('constantTimeEquals', () => {
  it('agrees with === on the cases that matter', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true)
    expect(constantTimeEquals('abc', 'abd')).toBe(false)
    expect(constantTimeEquals('abc', 'abcd')).toBe(false)
    expect(constantTimeEquals('', '')).toBe(true)
    expect(constantTimeEquals('', 'a')).toBe(false)
  })
})

describe('denyResponse', () => {
  it('challenges with Basic when credentials are missing or wrong', async () => {
    for (const reason of ['missing_credentials', 'bad_credentials'] as const) {
      const response = denyResponse(reason)
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toContain('Basic realm=')
      expect(response.headers.get('cache-control')).toContain('no-store')
      expect(response.headers.get('x-robots-tag')).toContain('noindex')
    }
  })

  it('does not challenge when no password could ever work, and says what is missing', async () => {
    const response = denyResponse('not_configured')
    expect(response.status).toBe(403)
    expect(response.headers.get('www-authenticate')).toBeNull()
    const body = await response.text()
    expect(body).toContain(ADMIN_EMAILS_VAR)
    expect(body).toContain(ADMIN_PASSWORD_VAR)
  })
})
