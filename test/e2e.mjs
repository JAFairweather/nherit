// e2e.mjs — the whole life of an estate, in one run (spec §9): setup →
// grants in all three tiers → living maintenance → estrangement rotation →
// simulated death (injected clock) → escrow release → executor claims from
// paper → the estate assembles on a device that held nothing. In-memory
// relay; two mock Blossom hosts (real HTTP) carry an 800 KB "scanned will"
// through the blob pipeline.
//
//   node test/e2e.mjs

import { createServer } from 'node:http'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import * as nip49 from 'nostr-tools/nip49'
import { Relay } from '../lib/relay.mjs'
import { LocalRelay } from '../lib/liverelay.mjs'
import {
  newScopeKey, publishScope, grant, rotateScope, receiveGrants, latestGrants,
  fetchScope, saveGrantIndex, loadGrantIndex, toIssuedEntry, fromIssuedEntry, localSigner,
} from '../lib/nipxx.mjs'
import { newScopePayload, validateScopePayload, reviewDue } from '../shared/estate.mjs'
import { inlineFileEntry, inlineBytes, blobFileEntry, blobKey } from '../shared/manifest.mjs'
import { newFileKey, encryptBlob, decryptBlob, uploadBlob, fetchBlob, sha256hex } from '../shared/blossom.mjs'
import { buildSealedGrant, sendDeposit, sanitizePolicy } from '../shared/escrowpkg.mjs'
import { splitScopeKey, combineShares } from '../shared/shamir.mjs'
import { sendRevocationNotice, receiveNotices } from '../shared/notices.mjs'
import { ownerSheet } from '../shared/paper.mjs'
import { sweep } from '../escrow/src/watch.mjs'

const inner = new Relay()
const relay = new LocalRelay(inner)
const DAY = 86400

let passed = 0, failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? passed++ : failed++
}

// --- two mock Blossom hosts: store by sha256, demand a kind-24242 auth header
function mockBlossom() {
  const blobs = new Map()
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    if (req.method === 'PUT' && req.url === '/upload') {
      if (!req.headers.authorization?.startsWith('Nostr ')) { res.writeHead(401); return res.end() }
      const sha = await sha256hex(new Uint8Array(body))
      blobs.set(sha, body)
      res.writeHead(201, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ sha256: sha }))
    }
    const sha = req.url.slice(1)
    if (req.method === 'GET' && blobs.has(sha)) { res.writeHead(200); return res.end(blobs.get(sha)) }
    if (req.method === 'DELETE' && blobs.has(sha)) { blobs.delete(sha); res.writeHead(204); return res.end() }
    res.writeHead(404); res.end()
  })
  return new Promise(r => server.listen(0, () => r({ server, blobs, url: `http://127.0.0.1:${server.address().port}` })))
}

const owner = generateSecretKey()
const spouse = generateSecretKey()      // tier 1: immediate
const executor = generateSecretKey()    // tier 2: escrowed
const sibling = generateSecretKey()     // tier 3: shareholder
const attorney = generateSecretKey()    // tier 3: shareholder
const estranged = generateSecretKey()   // revoked pre-death
const escrowSk = generateSecretKey()

try {
  const host1 = await mockBlossom(), host2 = await mockBlossom()
  const SERVERS = [host1.url, host2.url]

  console.log('\n1. Setup: executor scope with an 800 KB scanned will (blob) + a letter (inline)')
  const scope = { scopeId: 'nhe2e1', generation: 1, scopeKey: newScopeKey(),
    payload: newScopePayload('executor') }
  scope.payload.items[0].value = 'Original will: fire safe, garage. Scan attached.'
  const willBytes = new Uint8Array(800 * 1024)                           // a "scan"
  for (let i = 0; i < willBytes.length; i += 65536)
    crypto.getRandomValues(willBytes.subarray(i, Math.min(i + 65536, willBytes.length)))
  const filekey = newFileKey()
  const cipher = encryptBlob(filekey, willBytes)
  const desc = await uploadBlob(SERVERS, localSigner(owner), cipher)
  scope.payload.docs.push(blobFileEntry({ name: 'will-scan.bin', mime: 'application/octet-stream',
    size: willBytes.length, filekey, desc }))
  scope.payload.docs.push(inlineFileEntry({ name: 'letter.txt', mime: 'text/plain',
    bytes: new TextEncoder().encode('Read the will before the funeral, not after.') }))
  check('payload with docs validates', validateScopePayload(scope.payload).length === 0)
  check('blob mirrored to both hosts', desc.servers.length === 2)
  await publishScope(relay, owner, scope)

  const spouseScope = { scopeId: 'nhe2e2', generation: 1, scopeKey: newScopeKey(),
    payload: newScopePayload('spouse') }
  spouseScope.payload.items[0].value = 'Everything account-shaped is in the vault; kit in envelope B'
  await publishScope(relay, owner, spouseScope)

  console.log('\n2. Grants in all three tiers')
  await grant(relay, owner, getPublicKey(spouse), { ...spouseScope, scopeName: 'Spouse' })
  await grant(relay, owner, getPublicKey(estranged), { ...spouseScope, scopeName: 'Spouse' })
  const sealed = await buildSealedGrant(owner, getPublicKey(executor), { ...scope, scopeName: 'Executor' })
  await sendDeposit(relay, owner, getPublicKey(escrowSk), {
    wraps: [sealed], policy: sanitizePolicy({}), challengeContacts: [getPublicKey(spouse)],
    contact: 'owner@example.invalid',
  })
  const mnemonics = splitScopeKey(scope.scopeKey, { count: 3, threshold: 2 })
  check('tier 3 minted alongside tiers 1–2', mnemonics.length === 3)
  await saveGrantIndex(relay, owner, {
    issued: [toIssuedEntry({ ...scope, scopeName: 'Executor' }, []),
             toIssuedEntry({ ...spouseScope, scopeName: 'Spouse' }, [getPublicKey(spouse), getPublicKey(estranged)])],
    received: [],
  })
  check('nothing readable by the executor yet', (await receiveGrants(relay, executor)).length === 0)

  console.log('\n3. Living maintenance + annual-review logic')
  spouseScope.payload.items[1].value = 'Password vault: emergency kit envelope B, home safe'
  spouseScope.payload.updated_at = Math.floor(Date.now() / 1000)
  await publishScope(relay, owner, spouseScope)
  const sRead = await fetchScope(relay, latestGrants(await receiveGrants(relay, spouse))[0])
  check('spouse sees the edit live', sRead.data.items[1].value.includes('envelope B'))
  check('review not due on fresh data', !reviewDue([spouseScope.payload]))
  check('review due at 13 months', reviewDue([spouseScope.payload],
    Math.floor(Date.now() / 1000) + 396 * DAY))

  console.log('\n4. Estrangement, pre-death: rotate + 441')
  const rot = await rotateScope(relay, owner, {
    scopeId: spouseScope.scopeId, generation: 1, scopeName: 'Spouse',
    payload: spouseScope.payload, survivors: [getPublicKey(spouse)],
  })
  Object.assign(spouseScope, rot)
  await sendRevocationNotice(relay, owner, getPublicKey(estranged), { scopeId: spouseScope.scopeId })
  const eRead = await fetchScope(relay, latestGrants(await receiveGrants(relay, estranged))[0])
  check('estranged is stale at v2', eRead.status === 'stale')
  check('441 notice delivered', (await receiveNotices(relay, estranged)).revocations.length === 1)

  console.log('\n5. Death, simulated: 98 quiet days of daemon sweeps')
  const store = { data: { deposits: {} } }
  const outreach = []
  const t0 = Math.floor(Date.now() / 1000) + 1000
  for (const day of [0, 31, 92, 100])
    await sweep({ relay, signer: localSigner(escrowSk), store, nowSec: t0 + day * DAY,
      outreach: async (o) => outreach.push(o.stage) })
  const dep = store.data.deposits[getPublicKey(owner)]
  check('escalation ran outreach → staged → released', outreach.join(',') === 'quiet,staged,released'
    && dep.state === 'released')

  console.log('\n6. The executor claims — ordinary client, then the paper ceremony variant')
  const grants = latestGrants(await receiveGrants(relay, executor))
  check('released grant arrived as an ordinary 440', grants.length === 1 && grants[0].scopeName === 'Executor')
  const got = await fetchScope(relay, grants[0])
  check('estate scope decrypts post-release', got.status === 'ok'
    && got.data.items[0].value.includes('fire safe'))
  const willEntry = got.data.docs.find(d => d.name === 'will-scan.bin')
  const fetched = await fetchBlob(willEntry.servers, willEntry.sha256_cipher)
  const plain = decryptBlob(blobKey(willEntry), fetched)
  check('800 KB will round-trips hash-verified', plain.length === willBytes.length
    && (await sha256hex(plain)) === (await sha256hex(willBytes)))
  check('inline letter reads', new TextDecoder().decode(
    inlineBytes(got.data.docs.find(d => d.name === 'letter.txt'))).includes('before the funeral'))

  // Tier-3 alternative: sibling + attorney reconstitute WITHOUT any release
  const key = combineShares([mnemonics[1], mnemonics[2]])
  const cGot = await fetchScope(relay, { publisher: getPublicKey(owner),
    scopeId: scope.scopeId, generation: 1, scopeKey: key })
  check('2-of-3 ceremony opens the same scope with no service', cGot.status === 'ok')

  console.log('\n7. Paper: owner sheet → fresh profile → whole estate')
  const pass = 'orchard vane thimble crux'
  const nc = nip49.encrypt(owner, pass)
  const sheet = ownerSheet({ ncryptsec: nc, npub: nip19.npubEncode(getPublicKey(owner)),
    relays: ['wss://relay.example'] })
  check('sheet never carries the raw nsec', !sheet.includes(nip19.nsecEncode(owner)))
  const recovered = nip49.decrypt(nc, pass)
  const idx = await loadGrantIndex(relay, localSigner(recovered))
  const scopes = idx.issued.map(fromIssuedEntry)
  const back = await fetchScope(relay, { ...scopes.find(s => s.scopeName === 'Executor'),
    publisher: getPublicKey(recovered) })
  check('10440 → everything: estate reassembles from paper alone', back.status === 'ok'
    && back.data.docs.length === 2)

  console.log('\n8. Observer: the estate\'s whole life leaked nothing')
  const blob = JSON.stringify(inner.observerView())
  check('no names, contents, or tiers on the wire', !blob.includes('Executor') && !blob.includes('Spouse')
    && !blob.includes('fire safe') && !blob.includes('envelope B') && !blob.includes('nherit_'))
  check('no beneficiary or shareholder pubkeys visible', ![spouse, executor, sibling, attorney, estranged]
    .some(k => blob.includes(getPublicKey(k))))

  host1.server.close(); host2.server.close()
  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`)
  process.exit(failed === 0 ? 0 : 1)
} catch (err) {
  console.error('\n\x1b[31mE2E aborted:\x1b[0m', err)
  process.exit(1)
}
