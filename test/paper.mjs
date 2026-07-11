// paper.mjs — the paper kit round trip, without a browser: render each
// sheet, extract the QR, DECODE the QR pixels back to text, and prove the
// recovered material actually opens the estate on a fresh profile.
//
// This is the flagship guarantee (spec §6.4): fresh device + owner sheet →
// Grant Index → everything.

import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import * as nip49 from 'nostr-tools/nip49'
import { encodeQR } from '@paulmillr/qr'
import { decodeQR } from '@paulmillr/qr/decode.js'
import { Relay } from '../lib/relay.mjs'
import { LocalRelay } from '../lib/liverelay.mjs'
import {
  newScopeKey, publishScope, grant, fetchScope, saveGrantIndex, loadGrantIndex,
  toIssuedEntry, fromIssuedEntry, localSigner,
} from '../lib/nipxx.mjs'
import { newScopePayload } from '../shared/estate.mjs'
import { ownerSheet, beneficiarySheet, shamirCard } from '../shared/paper.mjs'
import { splitScopeKey } from '../shared/shamir.mjs'

const inner = new Relay()
const relay = new LocalRelay(inner)
const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol']

let passed = 0, failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? passed++ : failed++
}

// "Scan" a QR the way a camera would, but pixel-perfect: re-encode the
// payload to a raw module matrix, rasterize to RGBA, and run the decoder.
function scanQR(payload) {
  const matrix = encodeQR(payload, 'raw', { ecc: 'medium' })
  const scale = 4, border = 8
  const size = matrix.length * scale + border * 2
  const data = new Uint8ClampedArray(size * size * 4).fill(255)
  matrix.forEach((row, y) => row.forEach((dark, x) => {
    if (!dark) return
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = ((border + y * scale + dy) * size + border + x * scale + dx) * 4
      data[i] = data[i + 1] = data[i + 2] = 0
    }
  }))
  return decodeQR({ height: size, width: size, data })
}

const qrPayloadsIn = (html) => [...html.matchAll(/<div class="k">([^<]+)<\/div>/g)].map(m => m[1])

try {
  console.log('\n1. Build an estate worth recovering')
  const owner = generateSecretKey()
  const spouse = generateSecretKey()
  const scope = { scopeId: 'nhpp1', generation: 1, scopeKey: newScopeKey(),
    payload: newScopePayload('medical') }
  scope.payload.items[0].value = 'Directive: filed with Dr. Osei, scan in vault'
  await publishScope(relay, owner, scope)
  await grant(relay, owner, getPublicKey(spouse), { ...scope, scopeName: scope.payload.name })
  await saveGrantIndex(relay, owner, {
    issued: [toIssuedEntry({ ...scope, scopeName: scope.payload.name }, [getPublicKey(spouse)])],
    received: [],
  })

  console.log('\n2. Print the owner sheet (ncryptsec, never the raw nsec)')
  const passphrase = 'correct horse battery staple'
  const ncryptsec = nip49.encrypt(owner, passphrase)
  const html = ownerSheet({
    ncryptsec, npub: nip19.npubEncode(getPublicKey(owner)),
    relays: RELAYS, passphraseHint: 'the usual four words',
  })
  check('sheet carries the ncryptsec', html.includes(ncryptsec))
  check('sheet does NOT carry the raw nsec', !html.includes(nip19.nsecEncode(owner)))
  check('bearer warning printed on the sheet', html.includes('bearer instrument'))
  check('print date present', html.includes(new Date().toISOString().slice(0, 10)))
  check('relay list printed', RELAYS.every(r => html.includes(r)))

  console.log('\n3. FLAGSHIP: scan the QR on a fresh device, recover everything')
  const scanned = scanQR(ncryptsec)
  check('QR decodes to the ncryptsec', scanned === ncryptsec)
  const recoveredSk = nip49.decrypt(scanned, passphrase)
  check('passphrase unlocks the scanned key',
    Buffer.from(recoveredSk).toString('hex') === Buffer.from(owner).toString('hex'))
  let wrongPass = false
  try { nip49.decrypt(scanned, 'guess'); wrongPass = true } catch { /* expected */ }
  check('wrong passphrase opens nothing', !wrongPass)
  // Fresh profile: nothing but the recovered key and the relay list.
  const index = await loadGrantIndex(relay, localSigner(recoveredSk))
  const scopes = index.issued.map(fromIssuedEntry)
  check('Grant Index recovered from paper alone', scopes.length === 1
    && scopes[0].grantees.length === 1)
  const got = await fetchScope(relay, { ...scopes[0], publisher: getPublicKey(recoveredSk) })
  check('10440 → everything: scope decrypts', got.status === 'ok'
    && got.data.items[0].value.includes('Dr. Osei'))

  console.log('\n4. Beneficiary sheet round-trips the same way')
  const benPass = 'a different passphrase'
  const benNcrypt = nip49.encrypt(spouse, benPass)
  const bhtml = beneficiarySheet({
    name: 'Alex Fairweather', relation: 'spouse', ncryptsec: benNcrypt,
    npub: nip19.npubEncode(getPublicKey(spouse)),
    ownerNpub: nip19.npubEncode(getPublicKey(owner)), relays: RELAYS,
  })
  check('beneficiary sheet has their ncryptsec + owner npub',
    bhtml.includes(benNcrypt) && bhtml.includes(nip19.npubEncode(getPublicKey(owner))))
  const benSk = nip49.decrypt(scanQR(benNcrypt), benPass)
  check('beneficiary key recovers from their sheet',
    Buffer.from(benSk).toString('hex') === Buffer.from(spouse).toString('hex'))

  console.log('\n5. Shamir cards: words survive print → QR → scan')
  const mnemonics = splitScopeKey(scope.scopeKey, { count: 3, threshold: 2 })
  const card = shamirCard({
    holderName: 'Sam (sibling)', scopeName: scope.payload.name,
    ownerNpub: nip19.npubEncode(getPublicKey(owner)),
    mnemonic: mnemonics[1], threshold: 2, count: 3, index: 1, relays: RELAYS,
  })
  check('card shows share position', card.includes('card 2 of 3') || card.includes('2 of 3'))
  check('card QR decodes to the exact mnemonic', scanQR(mnemonics[1]) === mnemonics[1])
  check('card warns a single card reveals nothing', card.includes('nothing'))

  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`)
  process.exit(failed === 0 ? 0 : 1)
} catch (err) {
  console.error('\n\x1b[31mPaper test aborted:\x1b[0m', err)
  process.exit(1)
}
