import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { approvedEmail, quotaExhaustedEmail } from '../src/email/templates.js'
import { landingPage } from '../src/views/pages.js'
import { makeUser, testConfig } from './helpers.js'

// #1267: the grant is an operator setting, so no surface may print a fixed figure.
// The landing fine print reads the config; each mail reads the recipient's row, so
// a topped-up or individually adjusted grant is never described as the default.
test('a configured grant is the figure the landing page and the quota mails state', () => {
  const config = testConfig({ quota: { initialCny: 25, usdCny: 7.2, comfortCny: 50 } })
  for (const locale of ['zh', 'en'] as const) {
    const html = landingPage(config, null, false, locale)
    assert.match(html, /¥25\.00/, `${locale}: the landing page states the configured grant`)
    assert.doesNotMatch(html, /1 元|1 CNY of quota/, `${locale}: no fixed 1 CNY claim`)
  }
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'quota-copy', status: 'approved', quota: 25 })
    const mails = [
      ['approved', approvedEmail(user, 'https://fledge.example')],
      ['quota-exhausted', quotaExhaustedEmail(user, 'https://fledge.example')],
    ] as const
    for (const [name, mail] of mails) {
      for (const [part, text] of [['text', mail.text], ['html', mail.html]] as const) {
        assert.match(text, /¥25\.00/, `${name}/${part}: states the grant`)
        assert.doesNotMatch(text, /1 元/, `${name}/${part}: no fixed 1 CNY claim`)
      }
    }
  } finally {
    store.close()
  }
})
