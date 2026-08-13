import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { toBase64, fromBase64, SyncError, describe as describeError } from '../src/lib/github.ts'

// btoa/atob are browser globals; Node has them too, which is why this file can
// exercise the encoding without a DOM.

describe('base64', () => {
  test('ASCII round-trips', () => {
    assert.equal(fromBase64(toBase64('der Abend')), 'der Abend')
  })

  test('Korean round-trips — btoa alone throws on this', () => {
    const text = '스키장, 스키 지역'
    assert.equal(fromBase64(toBase64(text)), text)
    assert.throws(() => btoa(text), 'plain btoa cannot encode it, which is the whole point')
  })

  test('German umlauts and ß', () => {
    const text = 'die Abfahrt / groß / Österreich / Ägypten'
    assert.equal(fromBase64(toBase64(text)), text)
  })

  test('mixed scripts in one string', () => {
    const text = 'das Skigebiet → 스키장 · Gebiet = 지역'
    assert.equal(fromBase64(toBase64(text)), text)
  })

  test('emoji survive the surrogate pair', () => {
    assert.equal(fromBase64(toBase64('🔊 hören')), '🔊 hören')
  })

  test('an empty string is not a special case', () => {
    assert.equal(fromBase64(toBase64('')), '')
  })

  test('a realistic chunk of JSON round-trips byte for byte', () => {
    const cards = Array.from({ length: 500 }, (_, i) => ({
      id: `card-${i}`,
      front: `das Wort ${i}`,
      back: `뜻 ${i}, 의미 ${i}`,
      note: 'Gebiet = 지역',
    }))
    const json = JSON.stringify(cards)
    assert.equal(fromBase64(toBase64(json)), json)
  })

  test('a payload past the argument limit still encodes', () => {
    // The encoder chunks at 32k; spreading a megabyte into apply() would throw.
    const big = '가'.repeat(200_000)
    assert.equal(fromBase64(toBase64(big)), big)
  })

  test('GitHub returns base64 wrapped in newlines', () => {
    const encoded = toBase64('der Abend')
    const wrapped = encoded.replace(/(.{4})/g, '$1\n')
    assert.equal(fromBase64(wrapped), 'der Abend')
  })
})

describe('error messages', () => {
  test('every kind names what to do about it', () => {
    const cases = [
      ['no-token', /Manage/],
      ['unauthorized', /new one/],
      ['forbidden', /cannot write/],
      ['rate-limited', /rate limit/i],
      ['conflict', /retrying/],
      ['too-large', /1MB/],
      ['offline', /will sync later/],
    ]
    for (const [kind, pattern] of cases) {
      assert.match(describeError(new SyncError(kind, 'x')), pattern, kind)
    }
  })

  test('a rate limit says when to come back', () => {
    const at = new Date('2026-08-14T09:30:00Z')
    assert.match(describeError(new SyncError('rate-limited', 'x', at)), /try again after/)
  })

  test('offline is reassuring, not alarming — nothing is lost', () => {
    assert.match(describeError(new SyncError('offline', 'x')), /saved/)
  })

  test('a plain Error passes its own message through', () => {
    assert.equal(describeError(new Error('boom')), 'boom')
  })

  test('a non-Error does not crash the status line', () => {
    assert.equal(describeError('something'), 'Sync failed')
  })
})
