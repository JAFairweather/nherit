// notices.mjs — the app-level messages Nherit sends beside grants, all
// gift-wrapped rumors (relays see nothing):
//
//   kind 441  revocation notice (SPEC.md: optional, so a revoked party's
//             client can mark the data "no longer maintained" instead of
//             guessing from generation supersession)
//   kind 14   {nherit_named: 1}  — "you are named in this vault": an heir
//             who doesn't know to look defeats the product, so escrowed
//             beneficiaries learn THAT a grant exists, never what's in it.
//             Owner-configurable off (spec §5.3, default on per §11).
//
// DOM-free; tests drive these directly.

import { KIND_DATA_SET } from '../lib/nipxx.mjs'
import { asSigner, inbox, now, wrapRumor } from './wrap.mjs'

export const KIND_REVOCATION = 441
export const KIND_APP = 14           // kind-14-shape rumors, nherit_* markers

/** Tell a revoked beneficiary their access ended — gracious, not silent. */
export async function sendRevocationNotice(relay, signer, revokedPub, { scopeId, reason = '' }) {
  const s = asSigner(signer)
  const pub = await s.getPublicKey()
  const rumor = {
    pubkey: pub,
    kind: KIND_REVOCATION,
    created_at: now(),
    tags: [['a', `${KIND_DATA_SET}:${pub}:${scopeId}`]],
    content: reason,
  }
  return relay.publish(await wrapRumor(s, revokedPub, rumor))
}

/** Tell an escrowed beneficiary they are named — existence, not contents. */
export async function sendNamedNotice(relay, signer, beneficiaryPub, message = '') {
  const s = asSigner(signer)
  const rumor = {
    pubkey: await s.getPublicKey(),
    kind: KIND_APP,
    created_at: now(),
    tags: [['p', beneficiaryPub]],
    content: JSON.stringify({ nherit_named: 1, message }),
  }
  return relay.publish(await wrapRumor(s, beneficiaryPub, rumor))
}

/** Everything notice-shaped in this keyholder's gift wraps:
 *  { revocations: [{ owner, scopeId, reason, at }],
 *    named:       [{ owner, message, at }] } */
export async function receiveNotices(relay, signer) {
  const revocations = [], named = []
  for (const { rumor } of await inbox(relay, signer)) {
    if (rumor.kind === KIND_REVOCATION) {
      const a = rumor.tags.find(t => t[0] === 'a')?.[1] ?? ''
      const [kind, owner, scopeId] = a.split(':')
      if (Number(kind) !== KIND_DATA_SET || !scopeId) continue
      revocations.push({ owner, scopeId, reason: rumor.content, at: rumor.created_at })
    } else if (rumor.kind === KIND_APP) {
      let body
      try { body = JSON.parse(rumor.content) } catch { continue }
      if (body?.nherit_named !== 1) continue
      named.push({ owner: rumor.pubkey, message: body.message ?? '', at: rumor.created_at })
    }
  }
  return { revocations, named }
}
