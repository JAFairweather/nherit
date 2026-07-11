// invite.mjs — bearer invite links for keyless heirs, in-memory relay.
// Full loop: mint link → open → claim → approve → pre-claim link dead.
// This is the dominant beneficiary onboarding path (most heirs have no
// nostr key), so the whole lifecycle is asserted.
//
//   node test/invite.mjs

import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { Relay } from '../lib/relay.mjs'
import { LocalRelay } from '../lib/liverelay.mjs'
import {
  newScopeKey, publishScope, grant,
  receiveGrants, latestGrants, fetchScope,
  loadGrantIndex, saveGrantIndex, toIssuedEntry,
} from '../lib/nipxx.mjs'
import { newScopePayload } from '../shared/estate.mjs'
import {
  buildInviteUrl, parseInviteFragment, createInvite,
  sendClaimRequest, pollClaims, approveClaim,
} from '../shared/invite.mjs'

const inner = new Relay()
const relay = new LocalRelay(inner)

let passed = 0, failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? passed++ : failed++
}

const owner = generateSecretKey()
const spouse = generateSecretKey()      // existing keyed beneficiary

try {
  console.log('\n1. The link: secret rides the fragment only, round-trips exactly')
  const tmp = generateSecretKey()
  const url = buildInviteUrl('https://nherit.example/app/', tmp, ['wss://a.example', 'wss://b.example'])
  const u = new URL(url)
  const parsed = parseInviteFragment(u.hash)
  check('nsec round-trips through the fragment', parsed.sk.length === 32 && parsed.sk.every((b, i) => b === tmp[i]))
  check('relay hints round-trip', parsed.relays.join(',') === 'wss://a.example,wss://b.example')
  check('nothing secret outside the fragment', u.pathname + u.search === '/app/' && !u.username && !u.password)
  check('junk fragments rejected', parseInviteFragment('#vault') === null
    && parseInviteFragment(`#i=${nip19.npubEncode(getPublicKey(tmp))}`) === null
    && parseInviteFragment('') === null)

  console.log('\n2. Owner: scope + keyed beneficiary + bearer invite for a keyless kid')
  const scope = {
    scopeId: 'nh' + Math.random().toString(36).slice(2, 8),
    scopeName: 'Child', generation: 1, scopeKey: newScopeKey(), grantees: [],
  }
  const payload = newScopePayload('kid', 'Child')
  payload.items[0].value = 'The letter is real, kid. Read it slowly.'
  scope.payload = payload
  await publishScope(relay, owner, { ...scope, payload })
  await grant(relay, owner, getPublicKey(spouse), scope)
  scope.grantees.push(getPublicKey(spouse))

  const inv = await createInvite(relay, owner, scope, 'wss://hint.example')
  scope.grantees.push(inv.pub)
  let invites = [{ pub: inv.pub, scope: scope.scopeId, created_at: Math.floor(Date.now() / 1000) }]
  await saveGrantIndex(relay, owner, {
    issued: [toIssuedEntry(scope, scope.grantees)], received: [], nherit_invites: invites,
  })
  const idx = await loadGrantIndex(relay, owner)
  check('bearer flag survives in the index (app-level field, no lib change)',
    idx.nherit_invites?.length === 1 && idx.nherit_invites[0].pub === inv.pub
    && idx.nherit_invites[0].scope === scope.scopeId)
  check('invite is a normal grantee in the issued entry', idx.issued[0].grantees.includes(inv.pub))

  console.log('\n3. Anyone with the link reads the scope — no login, no other key material')
  const opened = latestGrants(await receiveGrants(relay, inv.sk))
  const got = await fetchScope(relay, opened[0])
  check('link dereferences the live scope', got.status === 'ok'
    && got.data.items[0].value.includes('Read it slowly'))

  console.log('\n4. Claim request rides a gift wrap; forgeries are dropped')
  const rSk = generateSecretKey()
  const rPub = getPublicKey(rSk)
  await sendClaimRequest(relay, inv.sk, getPublicKey(owner), scope.scopeId, rPub)
  const mallory = generateSecretKey() // never held the link
  await sendClaimRequest(relay, mallory, getPublicKey(owner), scope.scopeId, getPublicKey(mallory))
  const claims = await pollClaims(relay, owner, idx.nherit_invites)
  check('owner sees exactly the real claim', claims.length === 1
    && claims[0].rPub === rPub && claims[0].invitePub === inv.pub && claims[0].scope === scope.scopeId)

  console.log('\n5. Approve: grant R, rotate every bearer key out')
  const res = await approveClaim(relay, owner, scope, invites, claims[0])
  check('bearer key retired by the rotation', res.retired.length === 1 && res.retired[0] === inv.pub
    && !res.survivors.includes(inv.pub) && res.survivors.includes(rPub))
  Object.assign(scope, { generation: res.generation, scopeKey: res.scopeKey, grantees: res.survivors })
  invites = [{ ...invites[0], claimed_by: rPub, claimed_at: Math.floor(Date.now() / 1000) }]
  await saveGrantIndex(relay, owner, {
    issued: [toIssuedEntry(scope, scope.grantees)], received: [], nherit_invites: invites,
  })
  const rGot = await fetchScope(relay, latestGrants(await receiveGrants(relay, rSk))[0])
  check('claimed key reads the scope durably', rGot.status === 'ok'
    && rGot.data.items[0].value.includes('Read it slowly'))
  const sGot = await fetchScope(relay, latestGrants(await receiveGrants(relay, spouse))[0])
  check('prior beneficiary survives the claim rotation', sGot.status === 'ok')

  console.log('\n6. The pre-claim link is dead')
  const dead = await fetchScope(relay, latestGrants(await receiveGrants(relay, inv.sk))[0])
  check('old link reads stale after claim', dead.status === 'stale')
  check('claim leaves the pending queue once the invite is marked claimed',
    (await pollClaims(relay, owner, invites)).length === 0)

  console.log('\n7. Adversarial observer view')
  const blob = JSON.stringify(inner.observerView())
  check('no scope name or content visible', !blob.includes('Child') && !blob.includes('slowly'))
  check('no bearer or claimer pubkeys visible', !blob.includes(inv.pub) && !blob.includes(rPub))
  check('no claim marker visible', !blob.includes('nherit_claim') && !blob.includes('r_pub'))

  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`)
  process.exit(failed === 0 ? 0 : 1)
} catch (err) {
  console.error('\n\x1b[31mInvite test aborted:\x1b[0m', err)
  process.exit(1)
}
