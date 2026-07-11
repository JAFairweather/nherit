// escrow-daemon.mjs — the daemon's sweep loop end to end, in-memory relay,
// injected clock. Where test/escrow.mjs proves the pieces, this proves the
// operator process: mail ingest, ack, liveness via relay scan, outreach
// escalation, staged warning, veto reset, and final release — then a
// beneficiary's ordinary client reading the released grant.
//
//   node test/escrow-daemon.mjs

import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { Relay } from '../lib/relay.mjs'
import { LocalRelay } from '../lib/liverelay.mjs'
import {
  newScopeKey, publishScope, receiveGrants, latestGrants, fetchScope, saveGrantIndex, localSigner,
} from '../lib/nipxx.mjs'
import { newScopePayload } from '../shared/estate.mjs'
import { buildSealedGrant, sendDeposit, sendVeto, receiveAcks, sanitizePolicy } from '../shared/escrowpkg.mjs'
import { sweep } from '../escrow/src/watch.mjs'

const inner = new Relay()
const relay = new LocalRelay(inner)
const DAY = 86400

let passed = 0, failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? passed++ : failed++
}

const owner = generateSecretKey()
const executor = generateSecretKey()
const spouse = generateSecretKey()
const escrowSk = generateSecretKey()

const store = { data: { deposits: {} } }              // save() omitted: memory-only
const outreachLog = []
const outreach = async (o) => outreachLog.push({ stage: o.stage, owner: o.owner })
const t0 = Math.floor(Date.now() / 1000)
const at = (days) => sweep({ relay, signer: localSigner(escrowSk), store,
  nowSec: t0 + days * DAY, outreach })

try {
  console.log('\n1. Owner deposits; first sweep ingests and acks')
  const scope = { scopeId: 'nhdmn1', generation: 1, scopeKey: newScopeKey(),
    payload: newScopePayload('executor') }
  scope.payload.items[1].value = 'Attorney: R. Chen, chen.example.invalid'
  await publishScope(relay, owner, scope)
  const sealed = await buildSealedGrant(owner, getPublicKey(executor),
    { ...scope, scopeName: scope.payload.name })
  await sendDeposit(relay, owner, getPublicKey(escrowSk), {
    wraps: [sealed], policy: sanitizePolicy({}),
    challengeContacts: [getPublicKey(spouse)], contact: 'owner@example.invalid',
  })
  await at(0)
  const dep = store.data.deposits[getPublicKey(owner)]
  check('deposit in the store', !!dep && dep.wraps.length === 1)
  check('owner got an ack', (await receiveAcks(relay, owner)).some(a => a.wrapCount === 1))

  console.log('\n2. Owner activity keeps the switch quiet-proof')
  // The deposit gift wrap itself is NOT owner-authored (ephemeral key), so
  // silence starts at deposit time unless the owner does something. Let them
  // save their index on day 20 — ordinary app activity.
  const day20 = t0 + 20 * DAY
  inner.now = undefined // (LocalRelay uses event timestamps; we fake via created_at)
  await saveGrantIndex(relay, owner, { issued: [], received: [] })
  // force the event's created_at into the future-day window for the scan
  inner.events.filter(e => e.kind === 10440 && e.pubkey === getPublicKey(owner))
    .forEach(e => { e.created_at = day20 })
  await at(35)
  check('day 35: alive thanks to day-20 activity', dep.state === 'alive'
    && outreachLog.length === 0)

  console.log('\n3. Then 30+ quiet days → outreach; 90+ → staged warning')
  await at(51)
  check('day 51 (31 quiet): outreach fired once', dep.state === 'quiet'
    && outreachLog.filter(o => o.stage === 'quiet').length === 1)
  await at(70)
  check('day 70: still quiet, no repeat outreach', dep.state === 'quiet'
    && outreachLog.filter(o => o.stage === 'quiet').length === 1)
  await at(111)
  check('day 111 (91 quiet): staged, challenge contact warned', dep.state === 'staged'
    && outreachLog.some(o => o.stage === 'staged'))
  const spouseWraps = await relay.query({ kinds: [1059], '#p': [getPublicKey(spouse)] })
  check('warning wrap reached the spouse', spouseWraps.length >= 1)

  console.log('\n4. Veto: spouse pauses the countdown')
  await sendVeto(relay, spouse, getPublicKey(escrowSk), getPublicKey(owner),
    'sabbatical, not dead', t0 + 111 * DAY + 43200)   // vetoed in simulated time
  await at(112)
  check('vetoed back to alive', dep.state === 'alive' && dep.stagedAt === null)
  check('nothing released', (await receiveGrants(relay, executor)).length === 0)

  console.log('\n5. True silence: quiet → staged → veto window passes → RELEASE')
  await at(112 + 31)   // outreach again
  await at(112 + 91)   // staged again
  check('re-staged after renewed silence', dep.state === 'staged')
  await at(112 + 91 + 8) // veto window (7d) passes
  check('released', dep.state === 'released' && !!dep.releasedAt)
  check('outreach pipeline saw the release', outreachLog.some(o => o.stage === 'released'))

  console.log('\n6. The executor claims with an ordinary client — no Nherit machinery')
  const grants = latestGrants(await receiveGrants(relay, executor))
  check('released wrap is an ordinary grant', grants.length === 1)
  const got = await fetchScope(relay, grants[0])
  check('executor reads the scope', got.status === 'ok'
    && got.data.items[1].value.includes('R. Chen'))

  console.log('\n7. Cancellation: an empty re-deposit removes the switch')
  await sendDeposit(relay, owner, getPublicKey(escrowSk), {
    wraps: [], policy: sanitizePolicy({}), challengeContacts: [], contact: '',
  })
  await at(112 + 91 + 9)
  check('deposit gone from the store', !store.data.deposits[getPublicKey(owner)])

  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`)
  process.exit(failed === 0 ? 0 : 1)
} catch (err) {
  console.error('\n\x1b[31mDaemon test aborted:\x1b[0m', err)
  process.exit(1)
}
