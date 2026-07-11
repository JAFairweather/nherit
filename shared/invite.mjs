// invite.mjs — bearer invite links (Nvelope's §4.3 pattern, reused: most
// heirs have no nostr key, so this is the DOMINANT beneficiary onboarding
// path). An invite is a normal NIP-DA grant issued to a throwaway keypair I
// whose nsec rides ONLY in a URL fragment — never in a query string (no
// request line, no Referer), never on a relay, never persisted. Whoever
// holds the link holds the key. Claiming upgrades the bearer to a durable
// keypair R via a gift-wrapped claim request, and approval rotates every
// outstanding bearer key out of the scope — a link that has served its
// purpose is dead.
//
// DOM-free on purpose: test/invite.mjs drives this module directly.

import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { grant, localSigner, rotateScope } from '../lib/nipxx.mjs'
import { asSigner, inbox, now, wrapRumor } from './wrap.mjs'

/** Claim requests are kind-14-shape rumors; they only ever exist inside a
 *  1059 gift wrap, so relays see neither the kind nor the claimer's pubkey. */
export const KIND_CLAIM = 14

// --- the link itself ---------------------------------------------------------

export const buildInviteUrl = (base, inviteSk, relays = []) =>
  `${base}#i=${nip19.nsecEncode(inviteSk)}` +
  (relays.length ? `&r=${encodeURIComponent(relays.join(','))}` : '')

/** Parse `#i=<nsec>&r=<relays>` → { sk, relays } or null. Pure — the caller
 *  is responsible for stripping the fragment from the URL bar immediately. */
export function parseInviteFragment(hash) {
  const m = /^#i=(nsec1[a-z0-9]+)(?:&r=([^&]+))?$/.exec(hash ?? '')
  if (!m) return null
  try {
    const { type, data } = nip19.decode(m[1])
    if (type !== 'nsec') return null
    return { sk: data, relays: m[2] ? decodeURIComponent(m[2]).split(',').filter(Boolean) : [] }
  } catch { return null }
}

// --- owner side ---------------------------------------------------------------

/**
 * Mint a bearer grant: a fresh keypair I gets a normal grant to the scope.
 * Returns { sk, pub }. The caller records `pub` in its invite ledger (an
 * app-level `nherit_invites` field on the Grant Index — the index payload
 * is app-extensible JSON, no lib change) and builds the URL from `sk`,
 * which is then forgotten: the link is the only copy of the secret.
 */
export async function createInvite(relay, signer, scope, relayHint = '') {
  const sk = generateSecretKey()
  const pub = getPublicKey(sk)
  await grant(relay, signer, pub, { ...scope, relayHint })
  return { sk, pub }
}

/**
 * Find pending claim requests among the owner's gift wraps. A claim counts
 * only if its rumor is signed by a live (unclaimed) invite key for the scope
 * it names — possession of the link IS the credential; anything else is
 * noise or forgery and is dropped without comment.
 */
export async function pollClaims(relay, signer, invites) {
  const live = (invites ?? []).filter(i => !i.claimed_by)
  if (!live.length) return []
  const claims = []
  for (const { rumor } of await inbox(relay, signer)) {
    if (rumor.kind !== KIND_CLAIM) continue
    let body
    try { body = JSON.parse(rumor.content) } catch { continue }
    if (body?.nherit_claim !== 1 || !/^[0-9a-f]{64}$/.test(body.r_pub ?? '')) continue
    if (!live.some(i => i.pub === rumor.pubkey && i.scope === body.scope)) continue
    if (claims.some(c => c.invitePub === rumor.pubkey && c.rPub === body.r_pub)) continue
    claims.push({ invitePub: rumor.pubkey, scope: body.scope, rPub: body.r_pub, requestedAt: rumor.created_at })
  }
  return claims
}

/**
 * Approve a claim: rotate the scope so R is in and EVERY outstanding bearer
 * key for it is out — bearer tokens don't outlive an upgrade, including
 * other unclaimed links to the same scope. Survivors = all non-invite
 * grantees + R. Returns the rotation result plus the survivor list; the
 * caller updates its scope record and invite ledger.
 */
export async function approveClaim(relay, signer, scope, invites, claim) {
  const bearerPubs = (invites ?? [])
    .filter(i => i.scope === scope.scopeId && !i.claimed_by).map(i => i.pub)
  const survivors = [
    ...scope.grantees.filter(p => !bearerPubs.includes(p) && p !== claim.rPub),
    claim.rPub,
  ]
  const rotated = await rotateScope(relay, signer, {
    scopeId: scope.scopeId, generation: scope.generation, scopeName: scope.scopeName,
    payload: scope.payload, survivors,
  })
  return { ...rotated, survivors, retired: bearerPubs }
}

// --- opener side ---------------------------------------------------------------

/**
 * From the link opener: ask the owner to move this bearer access onto the
 * durable pubkey rPub. Rides a gift wrap from I to the owner — the relay
 * sees an ephemeral pubkey delivering an opaque blob; rPub and the scope
 * are never exposed.
 */
export async function sendClaimRequest(relay, inviteSk, ownerPub, scopeId, rPub) {
  const signer = localSigner(inviteSk)
  const rumor = {
    pubkey: getPublicKey(inviteSk),
    kind: KIND_CLAIM,
    created_at: now(),
    tags: [['p', ownerPub]],
    content: JSON.stringify({ nherit_claim: 1, scope: scopeId, r_pub: rPub }),
  }
  const wrap = await wrapRumor(signer, ownerPub, rumor)
  return relay.publish(wrap)
}
