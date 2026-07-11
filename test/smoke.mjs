// smoke.mjs — Nherit M1 smoke test: the estate record over NIP-DA.
//
//   node test/smoke.mjs --local     # in-memory relay
//   node test/smoke.mjs             # live public relays
//
// Acceptance (spec §8 M1): spouse + medical scopes round-trip between two
// keypairs; an edit propagates with no grantee action; the observer view
// shows no beneficiary identities and no scope structure. Adversarial
// observer assertions are first-class.

import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { Relay } from '../lib/relay.mjs'
import { LiveRelay, LocalRelay } from '../lib/liverelay.mjs'
import {
  newScopeKey, publishScope, grant, rotateScope,
  receiveGrants, latestGrants, fetchScope,
  loadGrantIndex, saveGrantIndex, toIssuedEntry, fromIssuedEntry,
} from '../lib/nipxx.mjs'
import { newScopePayload, validateScopePayload } from '../shared/estate.mjs'
import { sendRevocationNotice, receiveNotices } from '../shared/notices.mjs'

const local = process.argv.includes('--local')
const inner = local ? new Relay() : null
const relay = local ? new LocalRelay(inner)
  : new LiveRelay(['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'])
console.log(local ? 'mode: LOCAL' : 'mode: LIVE')
const settle = () => local ? Promise.resolve() : new Promise(r => setTimeout(r, 1500))

let passed = 0, failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? passed++ : failed++
}

const owner = generateSecretKey()          // James, maintaining his record
const spouse = generateSecretKey()         // immediate grant
const physician = generateSecretKey()      // immediate grant, medical only
const estranged = generateSecretKey()      // will be revoked

const rand = () => 'nh' + Math.random().toString(36).slice(2, 8)

try {
  console.log('\n1. Owner authors medical + spouse scopes from templates')
  const medical = { scopeId: rand(), generation: 1, scopeKey: newScopeKey(),
    payload: newScopePayload('medical') }
  medical.payload.items[0].value = 'Advance directive: original with attorney Chen, scan attached'
  medical.payload.items[1].value = 'Registered organ donor — everything usable'
  const spouseScope = { scopeId: rand(), generation: 1, scopeKey: newScopeKey(),
    payload: newScopePayload('spouse') }
  spouseScope.payload.items[1].value = 'Vault emergency kit: envelope B, home safe'
  check('medical payload validates', validateScopePayload(medical.payload).length === 0)
  check('spouse payload validates', validateScopePayload(spouseScope.payload).length === 0)
  const p1 = await publishScope(relay, owner, medical)
  const p2 = await publishScope(relay, owner, spouseScope)
  check('30440s accepted', (p1.acks ?? 1) > 0 && (p2.acks ?? 1) > 0)

  console.log('\n2. Immediate grants: spouse gets both, physician gets medical, estranged gets spouse')
  for (const [scope, to] of [[medical, spouse], [medical, physician], [spouseScope, spouse], [spouseScope, estranged]])
    await grant(relay, owner, getPublicKey(to), { ...scope, scopeName: scope.payload.name })
  await saveGrantIndex(relay, owner, {
    issued: [
      toIssuedEntry({ ...medical, scopeName: medical.payload.name }, [getPublicKey(spouse), getPublicKey(physician)]),
      toIssuedEntry({ ...spouseScope, scopeName: spouseScope.payload.name }, [getPublicKey(spouse), getPublicKey(estranged)]),
    ],
    received: [],
  })
  await settle()

  console.log('\n3. Beneficiaries read their scopes — and only theirs')
  const spouseGrants = latestGrants(await receiveGrants(relay, spouse))
  const physGrants = latestGrants(await receiveGrants(relay, physician))
  check('spouse holds two grants', spouseGrants.length === 2)
  check('physician holds one grant (medical only)', physGrants.length === 1
    && physGrants[0].scopeName === 'Medical')
  const spouseRead = await fetchScope(relay, spouseGrants.find(g => g.scopeName === 'Spouse'))
  const physRead = await fetchScope(relay, physGrants[0])
  check('spouse reads the vault pointer', spouseRead.status === 'ok'
    && spouseRead.data.items.some(i => i.value.includes('envelope B')))
  check('physician reads the directive', physRead.status === 'ok'
    && physRead.data.items[0].value.includes('attorney Chen'))

  console.log('\n4. Living maintenance: owner edits, every grantee is current')
  medical.payload.items[2].value = 'Metformin 500mg 2x daily; list updated after annual physical'
  await publishScope(relay, owner, medical)
  await settle()
  const physRead2 = await fetchScope(relay, physGrants[0])
  check('edit propagates with no grantee action', physRead2.status === 'ok'
    && physRead2.data.items[2].value.includes('Metformin'))

  console.log('\n5. Relationship change: revoke the estranged party from the spouse scope')
  const rotated = await rotateScope(relay, owner, {
    scopeId: spouseScope.scopeId, generation: spouseScope.generation,
    scopeName: spouseScope.payload.name, payload: spouseScope.payload,
    survivors: [getPublicKey(spouse)],
  })
  Object.assign(spouseScope, rotated)
  await sendRevocationNotice(relay, owner, getPublicKey(estranged),
    { scopeId: spouseScope.scopeId, reason: 'no longer maintained for you' })
  await settle()
  const spouseAfter = await fetchScope(relay,
    latestGrants(await receiveGrants(relay, spouse)).find(g => g.scopeName === 'Spouse'))
  const estrangedAfter = await fetchScope(relay,
    latestGrants(await receiveGrants(relay, estranged))[0])
  check('spouse (survivor) reads v2', spouseAfter.status === 'ok' && spouseAfter.generation === 2)
  check('estranged reads stale — cut off from all future versions', estrangedAfter.status === 'stale')
  const { revocations } = await receiveNotices(relay, estranged)
  check('estranged received the 441 notice', revocations.length === 1
    && revocations[0].scopeId === spouseScope.scopeId)

  console.log('\n6. Recovery: the whole estate reconstitutes from the owner key alone')
  await saveGrantIndex(relay, owner, {
    issued: [
      toIssuedEntry({ ...medical, scopeName: medical.payload.name }, [getPublicKey(spouse), getPublicKey(physician)]),
      toIssuedEntry({ ...spouseScope, scopeName: spouseScope.payload.name }, [getPublicKey(spouse)]),
    ],
    received: [],
  })
  await settle()
  const recovered = (await loadGrantIndex(relay, owner)).issued.map(fromIssuedEntry)
  check('index recovers both scopes + audiences', recovered.length === 2
    && recovered.every(s => s.grantees.length >= 1))
  const rMed = await fetchScope(relay, { ...recovered.find(s => s.scopeName === 'Medical'), publisher: getPublicKey(owner) })
  check('recovered key decrypts current data', rMed.status === 'ok'
    && rMed.data.items[2].value.includes('Metformin'))

  // The beneficiary side of the same guarantee: spouse on a fresh device,
  // holding nothing but her nsec.
  const fresh = latestGrants(await receiveGrants(relay, spouse))
  const freshRead = await fetchScope(relay, fresh.find(g => g.scopeName === 'Spouse'))
  check('beneficiary view reconstitutes from nsec alone', freshRead.status === 'ok'
    && freshRead.data.items.some(i => i.value.includes('envelope B')))

  if (local) {
    console.log('\n7. Adversarial observer view — what a hostile relay learned')
    const view = inner.observerView()
    const blob = JSON.stringify(view)
    check('no scope names visible', !blob.includes('Medical') && !blob.includes('Spouse'))
    check('no content visible', !blob.includes('Metformin') && !blob.includes('envelope')
      && !blob.includes('attorney'))
    check('no beneficiary pubkeys visible', ![spouse, physician, estranged]
      .some(k => blob.includes(getPublicKey(k))))
  }

  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`)
  relay.close?.()
  process.exit(failed === 0 ? 0 : 1)
} catch (err) {
  console.error('\n\x1b[31mSmoke aborted:\x1b[0m', err)
  relay.close?.()
  process.exit(1)
}
