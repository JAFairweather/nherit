// watch.mjs — one escrow sweep: ingest mail, refresh liveness, advance each
// deposit's state machine, and perform whatever the transition demands.
// Everything injectable (relay, clock, outreach hook) so test/escrow-daemon
// runs 90 days in microseconds; the bin wires the real world in.
//
// Liveness is elegant on nostr: ANY new event signed by the owner npub
// counts as alive — normal posting activity is the heartbeat, and an
// explicit check-in is just the app saving its Grant Index.

import {
  evaluateDeposit, markSeen, receiveEscrowMail, sendDepositAck, sendReleaseWarning,
} from '../../shared/escrowpkg.mjs'
import { ingest } from './store.mjs'

export async function sweep({ relay, signer, store, nowSec, outreach, log = () => {} }) {
  // 1. mail: new deposits, cancellations, vetoes
  ingest(store, await receiveEscrowMail(relay, signer), log)

  const owners = Object.keys(store.data.deposits)
  if (!owners.length) { log('no deposits held'); return }

  // 2. liveness: any owner-signed event since lastSeen
  for (const owner of owners) {
    const dep = store.data.deposits[owner]
    const events = await relay.query({ authors: [owner], since: dep.lastSeen + 1, limit: 1 })
    if (events.length) {
      const at = Math.max(...events.map(e => e.created_at))
      Object.assign(dep, markSeen(dep, Math.min(at, nowSec)))
      log(`owner ${owner.slice(0, 12)}… seen on relays — alive`)
    }
  }

  // 3. state machine + actions
  for (const owner of owners) {
    const dep = store.data.deposits[owner]
    if (!dep.acked) {
      await sendDepositAck(relay, signer, owner,
        { depositId: dep.id, policy: dep.policy, wrapCount: dep.wraps.length })
      dep.acked = true
    }
    const next = evaluateDeposit(dep, nowSec)
    Object.assign(dep, next)
    if (next.action === 'outreach') {
      log(`owner ${owner.slice(0, 12)}… quiet past ${dep.policy.quiet_days}d — outreach`)
      await outreach?.({ owner, contact: dep.contact, stage: 'quiet', dep })
    } else if (next.action === 'warn') {
      log(`owner ${owner.slice(0, 12)}… staged for release — warning ${dep.challengeContacts.length} challenge contact(s), veto window ${dep.policy.veto_days}d`)
      for (const c of dep.challengeContacts)
        await sendReleaseWarning(relay, signer, c, { ownerPub: owner, releaseAt: nowSec + dep.policy.veto_days * 86400 })
      await outreach?.({ owner, contact: dep.contact, stage: 'staged', dep })
    } else if (next.action === 'release') {
      log(`RELEASING ${dep.wraps.length} sealed grant(s) for ${owner.slice(0, 12)}… — veto window passed`)
      for (const w of dep.wraps) await relay.publish(w)
      dep.releasedAt = nowSec
      await outreach?.({ owner, contact: dep.contact, stage: 'released', dep })
    }
  }
  await store.save?.()
}
