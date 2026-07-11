// escrow.mjs — tier-2 dead-man's switch, end to end against the in-memory
// relay with an injected clock (90 simulated days in microseconds).
//
// Acceptance (spec §8 M4): simulated silence releases grants; the escrow
// storage audit proves undecryptability with escrow-held material alone;
// a challenge-contact veto halts a staged release.

import { generateSecretKey, getPublicKey, nip44 } from 'nostr-tools'
import { Relay } from '../lib/relay.mjs'
import { LocalRelay } from '../lib/liverelay.mjs'
import {
  newScopeKey, publishScope, receiveGrants, latestGrants, fetchScope, saveGrantIndex,
} from '../lib/nipxx.mjs'
import { newScopePayload } from '../shared/estate.mjs'
import {
  buildSealedGrant, sendDeposit, sendDepositAck, sendReleaseWarning, sendVeto,
  receiveEscrowMail, receiveAcks, evaluateDeposit, markSeen, sanitizePolicy,
} from '../shared/escrowpkg.mjs'

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
const kid = generateSecretKey()
const spouse = generateSecretKey()          // challenge contact
const escrowSk = generateSecretKey()        // the operator
const escrowPub = getPublicKey(escrowSk)

try {
  console.log('\n1. Owner publishes an executor scope and seals grants for escrow')
  const scope = { scopeId: 'nhesc1', generation: 1, scopeKey: newScopeKey(),
    payload: newScopePayload('executor') }
  scope.payload.items[0].value = 'Original will: office safe of Chen & Partners LLP'
  await publishScope(relay, owner, scope)
  const sealedExec = await buildSealedGrant(owner, getPublicKey(executor),
    { ...scope, scopeName: scope.payload.name })
  const sealedKid = await buildSealedGrant(owner, getPublicKey(kid),
    { ...scope, scopeName: scope.payload.name })
  check('sealed wraps are kind 1059', sealedExec.kind === 1059 && sealedKid.kind === 1059)

  console.log('\n2. Deposit rides a gift wrap to the escrow operator')
  const policy = sanitizePolicy({ quiet_days: 30, grace_days: 60, veto_days: 7 })
  await sendDeposit(relay, owner, escrowPub, {
    wraps: [sealedExec, sealedKid], policy,
    challengeContacts: [getPublicKey(spouse)], contact: 'owner@example.invalid',
  })
  const mail = await receiveEscrowMail(relay, escrowSk)
  check('escrow received the deposit', mail.deposits.length === 1
    && mail.deposits[0].wraps.length === 2)
  const dep0 = mail.deposits[0]
  check('policy survived transport', dep0.policy.quiet_days === 30 && dep0.policy.veto_days === 7)

  console.log('\n3. STORAGE AUDIT: escrow-held material alone decrypts nothing')
  // The escrow holds: the deposit (it can read that), and inside it the
  // sealed wraps. Try to open a wrap with the escrow key — the outer NIP-44
  // layer is keyed to the BENEFICIARY, so this must fail.
  let opened = false
  try {
    nip44.v2.decrypt(sealedExec.content,
      nip44.v2.utils.getConversationKey(escrowSk, sealedExec.pubkey))
    opened = true
  } catch { /* expected */ }
  check('escrow cannot open a sealed wrap', !opened)
  const held = JSON.stringify(dep0)
  check('scope key nowhere in escrow-held material',
    !held.includes(Buffer.from(scope.scopeKey).toString('base64'))
    && !held.includes(Buffer.from(scope.scopeKey).toString('hex')))
  check('scope name/content nowhere in escrow-held material',
    !held.includes('Executor') && !held.includes('Chen'))
  check('escrow sees beneficiary pubkeys (honest trust surface)',
    JSON.stringify(dep0.wraps[0].tags).includes(getPublicKey(executor)))

  console.log('\n4. Ack: the owner sees the escrow holds the switch')
  await sendDepositAck(relay, escrowSk, getPublicKey(owner),
    { depositId: dep0.id, policy: dep0.policy, wrapCount: 2 })
  const acks = await receiveAcks(relay, owner)
  check('owner received ack with wrap count', acks.some(a => a.wrapCount === 2))

  console.log('\n5. Liveness state machine: 90 quiet days stage then release')
  const t0 = dep0.at
  let dep = { policy: dep0.policy, lastSeen: t0, state: 'alive', stagedAt: null }
  dep = evaluateDeposit(dep, t0 + 10 * DAY)
  check('day 10: alive, no action', dep.state === 'alive' && dep.action === null)
  dep = evaluateDeposit(dep, t0 + 31 * DAY)
  check('day 31: quiet → outreach fires once', dep.state === 'quiet' && dep.action === 'outreach')
  dep = evaluateDeposit(dep, t0 + 45 * DAY)
  check('day 45: still quiet, outreach not repeated', dep.state === 'quiet' && dep.action === null)
  dep = evaluateDeposit(dep, t0 + 91 * DAY)
  check('day 91: staged → challenge contacts warned', dep.state === 'staged' && dep.action === 'warn')
  dep = evaluateDeposit(dep, t0 + 95 * DAY)
  check('day 95: veto window open, no release yet', dep.state === 'staged' && dep.action === null)
  dep = evaluateDeposit(dep, t0 + 99 * DAY)
  check('day 99: veto window passed → release', dep.state === 'released' && dep.action === 'release')

  console.log('\n6. Release: publishing the sealed wraps IS delivery')
  for (const w of dep0.wraps) await relay.publish(w)
  const execGrants = latestGrants(await receiveGrants(relay, executor))
  check('executor now holds an ordinary grant', execGrants.length === 1)
  const got = await fetchScope(relay, execGrants[0])
  check('executor reads the released scope', got.status === 'ok'
    && got.data.items[0].value.includes('Chen & Partners'))

  console.log('\n7. Veto path: a staged release halts and the clock resets')
  let dep2 = { policy: dep0.policy, lastSeen: t0, state: 'alive', stagedAt: null }
  dep2 = evaluateDeposit(dep2, t0 + 91 * DAY)
  check('second deposit staged', dep2.state === 'staged')
  await sendReleaseWarning(relay, escrowSk, getPublicKey(spouse),
    { ownerPub: getPublicKey(owner), releaseAt: t0 + 98 * DAY })
  await sendVeto(relay, spouse, escrowPub, getPublicKey(owner), 'he is on a sailboat, not dead')
  const mail2 = await receiveEscrowMail(relay, escrowSk)
  const veto = mail2.vetoes.find(v => v.owner === getPublicKey(owner))
  check('escrow received the veto', !!veto && veto.from === getPublicKey(spouse))
  check('veto is from a listed challenge contact', dep0.challengeContacts.includes(veto.from))
  dep2 = markSeen(dep2, veto.at)
  dep2 = evaluateDeposit(dep2, veto.at + 5 * DAY)
  check('vetoed deposit back to alive; countdown restarted', dep2.state === 'alive' && dep2.stagedAt === null)

  console.log('\n8. Owner activity resets the clock (normal nostr life = heartbeat)')
  let dep3 = { policy: dep0.policy, lastSeen: t0, state: 'quiet', stagedAt: null }
  await saveGrantIndex(relay, owner, { issued: [], received: [] })   // any signed event
  const [latest] = await relay.query({ kinds: [10440], authors: [getPublicKey(owner)] })
  dep3 = markSeen(dep3, latest.created_at)
  check('owner event marks the deposit alive', dep3.state === 'alive'
    && dep3.lastSeen >= t0)

  console.log('\n9. Adversarial observer: relay learned nothing about the switch')
  const blob = JSON.stringify(inner.observerView())
  check('no policy/veto/deposit markers visible', !blob.includes('nherit_escrow')
    && !blob.includes('nherit_veto') && !blob.includes('sailboat'))
  check('owner–escrow relationship invisible',
    !JSON.stringify(inner.events.filter(e => e.kind === 1059).map(e => e.pubkey))
      .includes(getPublicKey(owner)))

  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`)
  process.exit(failed === 0 ? 0 : 1)
} catch (err) {
  console.error('\n\x1b[31mEscrow test aborted:\x1b[0m', err)
  process.exit(1)
}
