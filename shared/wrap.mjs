// wrap.mjs — NIP-59 seal + gift wrap over the NIP-DA signer interface, plus
// the tiny helpers every app-level message module shares. Mirrored from the
// vendored lib's internal grant delivery (the lib doesn't export its
// helpers) — app code, not protocol surface. Nherit rides these rails for
// claims, escrow deposits, vetoes, revocation notices, named-in-vault
// notices, and Shamir share delivery: a relay sees only ephemeral pubkeys
// delivering opaque blobs.

import { finalizeEvent, generateSecretKey, getEventHash, nip44, verifyEvent } from 'nostr-tools'
import { localSigner } from '../lib/nipxx.mjs'

// Monotonic, like the lib's: two messages in the same second must not tie
// on created_at — newest-wins ordering (deposit replacement, cancellation)
// depends on strict ordering.
let lastTs = 0
export const now = () => (lastTs = Math.max(Math.floor(Date.now() / 1000), lastTs + 1))
const fuzz = () => now() - Math.floor(Math.random() * 2 * 24 * 60 * 60)
export const asSigner = (s) => s instanceof Uint8Array ? localSigner(s) : s

export async function wrapRumor(signer, recipientPub, rumor) {
  rumor.id = getEventHash(rumor)
  const seal = await signer.signEvent({
    kind: 13, created_at: fuzz(), tags: [],
    content: await signer.nip44Encrypt(recipientPub, JSON.stringify(rumor)),
  })
  const ephemeral = generateSecretKey()
  return finalizeEvent({
    kind: 1059, created_at: fuzz(), tags: [['p', recipientPub]],
    content: nip44.v2.encrypt(JSON.stringify(seal),
      nip44.v2.utils.getConversationKey(ephemeral, recipientPub)),
  }, ephemeral)
}

export async function unwrapRumor(signer, wrap) {
  const seal = JSON.parse(await signer.nip44Decrypt(wrap.pubkey, wrap.content))
  if (seal.kind !== 13 || !verifyEvent(seal)) throw new Error('bad seal')
  const rumor = JSON.parse(await signer.nip44Decrypt(seal.pubkey, seal.content))
  if (rumor.pubkey !== seal.pubkey) throw new Error('seal/rumor pubkey mismatch')
  return rumor
}

/** Unwrap every gift wrap addressed to this keyholder, dropping noise.
 *  Returns [{ rumor, wrap }] — callers filter by rumor kind and content. */
export async function inbox(relay, signer) {
  const s = asSigner(signer)
  const wraps = await relay.query({ kinds: [1059], '#p': [await s.getPublicKey()] })
  const out = []
  for (const wrap of wraps) {
    try { out.push({ rumor: await unwrapRumor(s, wrap), wrap }) } catch { continue }
  }
  return out
}
