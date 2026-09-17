import { expect, test } from 'vitest'

import messages from '../messages/pt-BR.json'

test('pt-BR messages carry the brand name', () => {
  expect(messages.brand.name).toBe('LicitaQui')
})
