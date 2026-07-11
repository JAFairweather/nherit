// shamir.mjs — tier 3: SLIP-39 threshold shares over the in-memory relay.
//
// Acceptance (spec §8 M5): a 2-of-3 ceremony reconstitutes a scope on a
// device that has never held the owner key.

import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { Relay } from '../lib/relay.mjs'
import { LocalRelay } from '../lib/liverelay.mjs'
import { newScopeKey, publishScope, fetchScope } from '../lib/nipxx.mjs'
import { newScopePayload } from '../shared/estate.mjs'
import { splitScopeKey, combineShares, validShareWords, sendShare, receiveShares } from '../shared/shamir.mjs'

const inner = new Relay()
const relay = new LocalRelay(inner)

let passed = 0, failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? passed++ : failed++
}

const owner = generateSecretKey()
const executor = generateSecretKey()
const sibling = generateSecretKey()
const attorney = generateSecretKey()
const holders = [executor, sibling, attorney]

try {
  console.log('\n1. Split a scope key 2-of-3')
  const scope = { scopeId: 'nhsh1', generation: 1, scopeKey: newScopeKey(),
    payload: newScopePayload('executor') }
  scope.payload.items[0].value = 'Will: bottom drawer of the fire safe, garage'
  await publishScope(relay, owner, scope)
  const mnemonics = splitScopeKey(scope.scopeKey, { count: 3, threshold: 2 })
  check('three mnemonics minted', mnemonics.length === 3)
  check('every share validates', mnemonics.every(validShareWords))
  check('shares are ~20 SLIP-39 words', mnemonics.every(m => m.split(' ').length >= 20))

  console.log('\n2. Any two shares reconstitute the key; one alone cannot')
  const k01 = combineShares([mnemonics[0], mnemonics[1]])
  const k12 = combineShares([mnemonics[1], mnemonics[2]])
  const k20 = combineShares([mnemonics[2], mnemonics[0]])
  const hex = (b) => Buffer.from(b).toString('hex')
  check('all three pairs agree', hex(k01) === hex(scope.scopeKey)
    && hex(k12) === hex(scope.scopeKey) && hex(k20) === hex(scope.scopeKey))
  let lone = false
  try { combineShares([mnemonics[0]]); lone = true } catch { /* expected */ }
  check('a single share reveals nothing', !lone)
  let garbled = false
  try { combineShares([mnemonics[0], mnemonics[1].replace(/^\w+/, 'academic')]); garbled = true } catch { /* expected */ }
  check('a tampered share fails the checksum', !garbled)

  console.log('\n3. Delivery: each shareholder gets their share gift-wrapped')
  for (const [i, sk] of holders.entries())
    await sendShare(relay, owner, getPublicKey(sk), {
      scopeId: scope.scopeId, generation: 1, scopeName: scope.payload.name,
      mnemonic: mnemonics[i], threshold: 2, count: 3, index: i,
    })
  const execShares = await receiveShares(relay, executor)
  check('executor holds exactly their share', execShares.length === 1
    && execShares[0].index === 0 && execShares[0].threshold === 2)
  check('share names its scope pointer', execShares[0].scopeId === scope.scopeId
    && execShares[0].owner === getPublicKey(owner))

  console.log('\n4. THE CEREMONY: a fresh device that never held the owner key')
  // Two shareholders in a room: executor's share (from their wraps) and
  // sibling's share (typed from a paper card). Nothing else.
  const sibShares = await receiveShares(relay, sibling)
  const key = combineShares([execShares[0].mnemonic, sibShares[0].mnemonic])
  const got = await fetchScope(relay, {
    publisher: execShares[0].owner, scopeId: execShares[0].scopeId,
    generation: execShares[0].generation, scopeKey: key,
  })
  check('ceremony decrypts the scope', got.status === 'ok'
    && got.data.items[0].value.includes('fire safe'))

  console.log('\n5. Blast radius: the ceremony opened ONE scope, not the estate')
  const other = { scopeId: 'nhsh2', generation: 1, scopeKey: newScopeKey(),
    payload: newScopePayload('spouse') }
  await publishScope(relay, owner, other)
  const cross = await fetchScope(relay, {
    publisher: getPublicKey(owner), scopeId: other.scopeId, generation: 1, scopeKey: key,
  })
  check('reconstituted key opens nothing else', cross.status !== 'ok')

  console.log('\n6. Adversarial observer view')
  const blob = JSON.stringify(inner.observerView())
  check('no share material on the wire', !blob.includes('nherit_share')
    && !mnemonics.some(m => blob.includes(m.split(' ')[0] + ' ' + m.split(' ')[1])))
  check('shareholder pubkeys not linked to owner',
    !JSON.stringify(inner.events.filter(e => e.kind === 1059).map(e => e.pubkey))
      .includes(getPublicKey(owner)))

  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`)
  process.exit(failed === 0 ? 0 : 1)
} catch (err) {
  console.error('\n\x1b[31mShamir test aborted:\x1b[0m', err)
  process.exit(1)
}
