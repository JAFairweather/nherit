#!/usr/bin/env node
// nherit-escrow.mjs — the OPTIONAL tier-2 dead-man's-switch daemon.
//
// THE TRUST STATEMENT (verbatim, spec §6.2): "The escrow can't read
// anything. It can release early, late, or never. Choose an operator you'd
// trust as a timer — or self-host it." Self-hosting is this file; see
// ../README.md.
//
// What this process holds: its own escrow keypair, and sealed gift wraps it
// cannot open (test/escrow.mjs asserts undecryptability). What it does:
// watch owner npubs for silence, run the outreach pipeline, and after the
// policy's grace + veto windows, publish the sealed wraps — at which point
// beneficiaries' ordinary clients find them as ordinary grants.
//
//   NHERIT_ESCROW_NSEC=nsec1…  node escrow/bin/nherit-escrow.mjs
//   optional: NHERIT_RELAYS=wss://…,wss://…
//             NHERIT_DATA=escrow/data/store.json
//             NHERIT_INTERVAL_S=600         sweep period (default 10 min)
//             NHERIT_OUTREACH_URL=https://… POST {owner, contact, stage}
//             NHERIT_OUTREACH_CMD='…'       shell hook, OWNER/CONTACT/STAGE in env

import { nip19, getPublicKey } from 'nostr-tools'
import { LiveRelay } from '../../lib/liverelay.mjs'
import { localSigner } from '../../lib/nipxx.mjs'
import { openStore } from '../src/store.mjs'
import { sweep } from '../src/watch.mjs'
import { makeOutreach } from '../src/checkin.mjs'

const log = (...a) => console.error(`[nherit-escrow ${new Date().toISOString().slice(0, 19)}]`, ...a)

const raw = process.env.NHERIT_ESCROW_NSEC
if (!raw) {
  console.error('usage: NHERIT_ESCROW_NSEC=nsec1… node escrow/bin/nherit-escrow.mjs')
  console.error('This daemon is a trusted TIMER, not a trusted reader. Read the header.')
  process.exit(1)
}
let sk
if (/^[0-9a-f]{64}$/i.test(raw.trim())) sk = Uint8Array.from(raw.trim().match(/../g), h => parseInt(h, 16))
else {
  const { type, data } = nip19.decode(raw.trim())
  if (type !== 'nsec') { console.error('NHERIT_ESCROW_NSEC: expected nsec1… or 64-char hex'); process.exit(1) }
  sk = data
}

const relays = (process.env.NHERIT_RELAYS ?? 'wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net')
  .split(',').map(s => s.trim()).filter(Boolean)
const intervalMs = Math.max(10, Number(process.env.NHERIT_INTERVAL_S) || 600) * 1000
const relay = new LiveRelay(relays)
const signer = localSigner(sk)
const store = await openStore(process.env.NHERIT_DATA ?? new URL('../data/store.json', import.meta.url).pathname)
const outreach = makeOutreach({
  url: process.env.NHERIT_OUTREACH_URL, cmd: process.env.NHERIT_OUTREACH_CMD, log,
})

log(`escrow ${nip19.npubEncode(getPublicKey(sk))}`)
log(`owners deposit to that npub; relays ${relays.join(', ')}`)
log(`sweeping every ${intervalMs / 1000}s · ${Object.keys(store.data.deposits).length} deposit(s) on disk · ctrl-c to stop`)

async function run() {
  try {
    await sweep({ relay, signer, store, nowSec: Math.floor(Date.now() / 1000), outreach, log })
  } catch (err) { log(`sweep failed (will retry): ${err.message}`) }
}

await run()
setInterval(run, intervalMs)
