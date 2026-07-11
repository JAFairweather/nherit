// store.mjs — escrow daemon persistence: one JSON file, atomic writes.
// What's in it: per-owner deposit records (sealed wraps + policy + liveness
// state). Nothing in this file can decrypt anything — see the trust
// statement in ../README.md — but it IS the switch, so treat the data dir
// like the daemon's own keys: back it up, restrict permissions.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export async function openStore(path) {
  let data
  try { data = JSON.parse(await readFile(path, 'utf8')) }
  catch { data = { deposits: {} } }
  const save = async () => {
    await mkdir(dirname(path), { recursive: true })
    const tmp = join(dirname(path), '.store.tmp')
    await writeFile(tmp, JSON.stringify(data, null, 2))
    await rename(tmp, path)
  }
  return { data, save }
}

/**
 * Fold freshly received mail into the store. A newer deposit for an owner
 * replaces the old one wholesale (rotation, beneficiary change, or policy
 * change is a re-deposit); an empty wraps list cancels the switch. A veto
 * counts only from a listed challenge contact and resets the clock.
 * Owner activity timestamps come from `seenAt` (relay scan, done by watch).
 */
export function ingest(store, { deposits = [], vetoes = [] }, log = () => {}) {
  for (const d of deposits) {
    const cur = store.data.deposits[d.owner]
    if (cur && cur.at >= d.at) continue
    if (!d.wraps.length) {
      if (cur) { delete store.data.deposits[d.owner]; log(`deposit cancelled for ${d.owner.slice(0, 12)}…`) }
      continue
    }
    store.data.deposits[d.owner] = {
      id: d.id, owner: d.owner, at: d.at, policy: d.policy,
      challengeContacts: d.challengeContacts, contact: d.contact, wraps: d.wraps,
      lastSeen: Math.max(d.at, cur?.lastSeen ?? 0),
      state: 'alive', stagedAt: null, acked: false,
      // a re-deposit while staged un-stages: the owner is plainly alive
    }
    log(`deposit ${cur ? 'replaced' : 'received'} for ${d.owner.slice(0, 12)}… (${d.wraps.length} sealed wraps)`)
  }
  for (const v of vetoes) {
    const dep = store.data.deposits[v.owner]
    if (!dep) continue
    if (!dep.challengeContacts.includes(v.from)) { log(`veto from unlisted ${v.from.slice(0, 12)}… ignored`); continue }
    if (v.at <= (dep.lastVeto ?? 0)) continue
    dep.lastVeto = v.at
    dep.lastSeen = Math.max(dep.lastSeen, v.at)
    if (dep.state !== 'released') { dep.state = 'alive'; dep.stagedAt = null }
    log(`veto for ${v.owner.slice(0, 12)}… from challenge contact — countdown reset`)
  }
}
