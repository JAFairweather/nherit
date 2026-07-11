// shamir.mjs — tier 3, the trust-nothing tier: a scope key split into
// SLIP-39 mnemonic shares (2-of-3 by default) across e.g. executor, sibling,
// attorney. No service anywhere: reconstitution is a client-side ceremony —
// two shareholders enter or scan their shares, the key comes back, the
// scope decrypts. Shares are delivered as gift-wrapped events AND printable
// cards; the cost is a coordination ceremony and share-custody discipline,
// and the UI says so.
//
// SLIP-39 structure used: group_threshold = `threshold` of `count` groups,
// each group a single 1-of-1 member — i.e. plain T-of-N person shares, in
// the standard interoperable mnemonic format (hardware-wallet compatible).
//
// The split secret is the SCOPE key, never the owner key: a completed
// ceremony opens one scope, not the estate.

import slip39 from 'slip39'
import { KIND_DATA_SET } from '../lib/nipxx.mjs'
import { asSigner, inbox, now, wrapRumor } from './wrap.mjs'

export const KIND_APP = 14

/** Split a 32-byte scope key into `count` mnemonics, any `threshold` of
 *  which recover it. Passphrase '' — custody discipline lives in WHO holds
 *  the cards, not in a memorized word that dies with the owner. */
export function splitScopeKey(scopeKey, { count = 3, threshold = 2 } = {}) {
  if (!(scopeKey instanceof Uint8Array) || scopeKey.length !== 32)
    throw new Error('scope key must be 32 bytes')
  if (threshold < 1 || threshold > count || count > 16)
    throw new Error(`bad threshold ${threshold}-of-${count}`)
  const s = slip39.fromArray(Array.from(scopeKey), {
    passphrase: '', threshold, groups: Array.from({ length: count }, () => [1, 1]),
  })
  return Array.from({ length: count }, (_, i) => s.fromPath(`r/${i}`).mnemonics[0])
}

/** Ceremony: any `threshold` mnemonics → the 32-byte scope key. Throws on
 *  bad checksums, mixed sets, or too few shares. */
export function combineShares(mnemonics) {
  const bytes = slip39.recoverSecret(mnemonics.map(m => m.trim().replace(/\s+/g, ' ')), '')
  return Uint8Array.from(bytes)
}

export const validShareWords = (m) => {
  try { return slip39.validateMnemonic(m.trim().replace(/\s+/g, ' ')) } catch { return false }
}

// --- delivery ------------------------------------------------------------------

/** Give one shareholder their share: a gift-wrapped rumor carrying the
 *  mnemonic plus the pointer it opens. The relay sees an opaque blob. */
export async function sendShare(relay, signer, shareholderPub,
    { scopeId, generation, scopeName, mnemonic, threshold, count, index }) {
  const s = asSigner(signer)
  const pub = await s.getPublicKey()
  const rumor = {
    pubkey: pub,
    kind: KIND_APP,
    created_at: now(),
    tags: [['p', shareholderPub]],
    content: JSON.stringify({
      nherit_share: 1,
      a: `${KIND_DATA_SET}:${pub}:${scopeId}`, v: generation,
      scope_name: scopeName, mnemonic, threshold, count, index,
    }),
  }
  return relay.publish(await wrapRumor(s, shareholderPub, rumor))
}

/** Shares in this keyholder's gift wraps, newest per (owner, scope, index). */
export async function receiveShares(relay, signer) {
  const best = new Map()
  for (const { rumor } of await inbox(relay, signer)) {
    if (rumor.kind !== KIND_APP) continue
    let body
    try { body = JSON.parse(rumor.content) } catch { continue }
    if (body?.nherit_share !== 1 || !validShareWords(body.mnemonic ?? '')) continue
    const [kind, owner, scopeId] = String(body.a ?? '').split(':')
    if (Number(kind) !== KIND_DATA_SET || !scopeId) continue
    const k = `${owner}:${scopeId}:${body.index}`
    const rec = {
      owner, scopeId, generation: Number(body.v ?? 0), scopeName: body.scope_name ?? '',
      mnemonic: body.mnemonic, threshold: body.threshold, count: body.count,
      index: body.index, at: rumor.created_at,
    }
    if (!best.has(k) || rec.generation > best.get(k).generation) best.set(k, rec)
  }
  return [...best.values()]
}
