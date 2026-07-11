// escrowpkg.mjs — everything two parties need to agree on for the tier-2
// dead-man's switch: sealed-grant construction, deposit/ack/veto/warning
// message formats, and the liveness state machine. All of it rides ordinary
// NIP-59 gift wraps over ordinary relays — the escrow daemon is just
// another nostr client.
//
// The trust statement, verbatim (spec §6.2 — keep in sync with SECURITY.md
// and the escrow README): "The escrow can't read anything. It can release
// early, late, or never. Choose an operator you'd trust as a timer — or
// self-host it."
//
// What the escrow HOLDS: gift wraps addressed to each beneficiary (sealed
// by the owner; the scope key inside is NIP-44 encrypted to the beneficiary
// — the escrow cannot decrypt it, and test/escrow.mjs asserts that), plus
// the release policy and the challenge-contact list. What the escrow LEARNS:
// the owner's pubkey, the beneficiaries' pubkeys (it must know where to
// deliver), how many sealed grants exist, and the timing policy. Never
// contents, never scope names, never which scope a wrap belongs to.
//
// DOM-free and clock-injectable: the state machine takes `nowSec` so tests
// simulate 90 days in microseconds.

import { getEventHash } from 'nostr-tools'
import { KIND_DATA_SET, KIND_GRANT } from '../lib/nipxx.mjs'
import { asSigner, inbox, now, wrapRumor } from './wrap.mjs'

export const KIND_APP = 14

// --- sealed grants (owner side) ------------------------------------------------

const b64 = (bytes) => btoa(String.fromCharCode(...bytes))

/**
 * Build a real kind-440 grant, gift-wrapped to the beneficiary, WITHOUT
 * publishing it. Byte-for-byte the construction the lib's grant() publishes
 * (same rumor shape), so when the escrow releases the wrap years later the
 * beneficiary's ordinary receiveGrants() finds it — release needs zero
 * cooperation from this app's future self.
 */
export async function buildSealedGrant(signer, beneficiaryPub,
    { scopeId, generation, scopeKey, scopeName, relayHint = '' }) {
  const s = asSigner(signer)
  const publisherPub = await s.getPublicKey()
  const rumor = {
    pubkey: publisherPub,
    kind: KIND_GRANT,
    created_at: now(),
    tags: [
      ['a', `${KIND_DATA_SET}:${publisherPub}:${scopeId}`, relayHint],
      ['v', String(generation)],
    ],
    content: JSON.stringify({ scope_key: b64(scopeKey), scope_name: scopeName }),
  }
  return wrapRumor(s, beneficiaryPub, rumor)
}

// --- deposit / ack / veto / warning ---------------------------------------------

/**
 * Deposit sealed wraps with an escrow operator. One live deposit per owner:
 * a newer deposit supersedes the old (rotation and beneficiary changes are
 * a fresh deposit), and an empty `wraps` cancels the switch entirely.
 * Policy days: quiet_days of silence start outreach; grace_days more of
 * silence stage the release; veto_days is the challenge window.
 */
export async function sendDeposit(relay, signer, escrowPub,
    { wraps, policy, challengeContacts = [], contact = '' }) {
  const s = asSigner(signer)
  const rumor = {
    pubkey: await s.getPublicKey(),
    kind: KIND_APP,
    created_at: now(),
    tags: [['p', escrowPub]],
    content: JSON.stringify({
      nherit_escrow: 1,
      policy,                                 // { quiet_days, grace_days, veto_days }
      challenge_contacts: challengeContacts,  // pubkeys who can veto a staged release
      contact,                                // out-of-band owner contact (email/URL) for outreach
      wraps,                                  // sealed 1059s, published verbatim on release
    }),
  }
  return relay.publish(await wrapRumor(s, escrowPub, rumor))
}

/** Escrow → owner: "I hold your deposit" — the visible heartbeat. */
export async function sendDepositAck(relay, escrowSigner, ownerPub, { depositId, policy, wrapCount }) {
  const s = asSigner(escrowSigner)
  const rumor = {
    pubkey: await s.getPublicKey(),
    kind: KIND_APP,
    created_at: now(),
    tags: [['p', ownerPub]],
    content: JSON.stringify({ nherit_escrow_ack: 1, deposit_id: depositId, policy, wrap_count: wrapCount }),
  }
  return relay.publish(await wrapRumor(s, ownerPub, rumor))
}

/** Escrow → challenge contact: "release staged; you can stop this." */
export async function sendReleaseWarning(relay, escrowSigner, contactPub, { ownerPub, releaseAt }) {
  const s = asSigner(escrowSigner)
  const rumor = {
    pubkey: await s.getPublicKey(),
    kind: KIND_APP,
    created_at: now(),
    tags: [['p', contactPub]],
    content: JSON.stringify({ nherit_release_warning: 1, owner_pub: ownerPub, release_at: releaseAt }),
  }
  return relay.publish(await wrapRumor(s, contactPub, rumor))
}

/** Challenge contact → escrow: veto. Resets the owner's liveness clock. */
export async function sendVeto(relay, signer, escrowPub, ownerPub, reason = '') {
  const s = asSigner(signer)
  const rumor = {
    pubkey: await s.getPublicKey(),
    kind: KIND_APP,
    created_at: now(),
    tags: [['p', escrowPub]],
    content: JSON.stringify({ nherit_veto: 1, owner_pub: ownerPub, reason }),
  }
  return relay.publish(await wrapRumor(s, escrowPub, rumor))
}

/** Escrow inbox scan: latest deposit per owner, all vetoes. A deposit is a
 *  bearer-of-the-owner's-signature instruction; a veto counts only from a
 *  pubkey the corresponding deposit lists as a challenge contact. */
export async function receiveEscrowMail(relay, escrowSigner) {
  const deposits = new Map(), vetoes = []
  for (const { rumor, wrap } of await inbox(relay, escrowSigner)) {
    if (rumor.kind !== KIND_APP) continue
    let body
    try { body = JSON.parse(rumor.content) } catch { continue }
    if (body?.nherit_escrow === 1 && Array.isArray(body.wraps)) {
      const prev = deposits.get(rumor.pubkey)
      if (!prev || rumor.created_at > prev.at)
        deposits.set(rumor.pubkey, {
          id: getEventHash(rumor), owner: rumor.pubkey, at: rumor.created_at,
          policy: sanitizePolicy(body.policy),
          challengeContacts: (body.challenge_contacts ?? []).filter(p => /^[0-9a-f]{64}$/.test(p)),
          contact: String(body.contact ?? '').slice(0, 200),
          wraps: body.wraps.filter(w => w?.kind === 1059),
          wrapId: wrap.id,
        })
    } else if (body?.nherit_veto === 1 && /^[0-9a-f]{64}$/.test(body.owner_pub ?? '')) {
      vetoes.push({ from: rumor.pubkey, owner: body.owner_pub, at: rumor.created_at, reason: body.reason ?? '' })
    }
  }
  return { deposits: [...deposits.values()], vetoes }
}

/** Owner inbox scan: acks from escrow operators. */
export async function receiveAcks(relay, signer) {
  const acks = []
  for (const { rumor } of await inbox(relay, signer)) {
    if (rumor.kind !== KIND_APP) continue
    let body
    try { body = JSON.parse(rumor.content) } catch { continue }
    if (body?.nherit_escrow_ack === 1)
      acks.push({ escrow: rumor.pubkey, depositId: body.deposit_id, policy: body.policy,
        wrapCount: body.wrap_count, at: rumor.created_at })
    else if (body?.nherit_release_warning === 1)
      acks.push({ escrow: rumor.pubkey, warning: true, ownerPub: body.owner_pub,
        releaseAt: body.release_at, at: rumor.created_at })
  }
  return acks
}

export function sanitizePolicy(p) {
  const d = (v, dflt) => Number.isInteger(v) && v >= 1 && v <= 3650 ? v : dflt
  return { quiet_days: d(p?.quiet_days, 30), grace_days: d(p?.grace_days, 60), veto_days: d(p?.veto_days, 7) }
}

// --- the liveness state machine (pure) -------------------------------------------
//
// alive → quiet (quiet_days of owner silence; outreach starts)
//       → staged (grace_days more of silence; challenge contacts warned)
//       → released (veto window passes with no veto)
// Any owner activity, or any veto from a listed challenge contact, resets
// the clock to alive. Post-release the deposit is spent.

const DAY = 86400

/**
 * One evaluation step. `dep` = { policy, lastSeen, state, stagedAt } where
 * lastSeen is the newest of: deposit time, owner activity, veto. Returns the
 * next { state, stagedAt, dueAt, action } — `action` is what the caller must
 * DO on this transition: 'outreach' | 'warn' | 'release' | null.
 */
export function evaluateDeposit(dep, nowSec) {
  const { quiet_days, grace_days, veto_days } = dep.policy
  const silent = nowSec - dep.lastSeen
  if (dep.state === 'released') return { ...dep, action: null }
  if (dep.state === 'staged') {
    // staged releases ride their own clock: the veto window from stagedAt
    if (nowSec - dep.stagedAt >= veto_days * DAY)
      return { ...dep, state: 'released', action: 'release' }
    return { ...dep, action: null, dueAt: dep.stagedAt + veto_days * DAY }
  }
  if (silent >= (quiet_days + grace_days) * DAY)
    return { ...dep, state: 'staged', stagedAt: nowSec, action: 'warn',
      dueAt: nowSec + veto_days * DAY }
  if (silent >= quiet_days * DAY) {
    const first = dep.state !== 'quiet'
    return { ...dep, state: 'quiet', action: first ? 'outreach' : null,
      dueAt: dep.lastSeen + (quiet_days + grace_days) * DAY }
  }
  return { ...dep, state: 'alive', action: null, dueAt: dep.lastSeen + quiet_days * DAY }
}

/** Owner activity or veto: the clock starts over. */
export function markSeen(dep, atSec) {
  return { ...dep, lastSeen: Math.max(dep.lastSeen, atSec), state: 'alive', stagedAt: null }
}
