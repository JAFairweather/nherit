// breakglass.mjs — the one hard problem, stated honestly: cryptography
// cannot verify death. Three tiers, ascending trust-minimization; an owner
// mixes them per scope (spec §6). This tab is the owner-side setup — the
// beneficiary experience of each tier lives in "Shared with you".

import { nip19 } from 'nostr-tools'
import { buildSealedGrant, sendDeposit, sanitizePolicy } from '../shared/escrowpkg.mjs'
import { splitScopeKey, sendShare } from '../shared/shamir.mjs'
import { DEFAULT_POLICY } from '../shared/config.mjs'
import { $, esc, personName, state, syncIndex, load, config, RELAYS } from './main.mjs'
import { printOwnerSheet, printShamirCards, printedKit } from './paperkit.mjs'

const TIER_COPY = `
  <div class="card">
    <div class="name">How break-glass works — three honest options</div>
    <p class="note"><b>Tier 1 — trust the person.</b> An immediate grant; they simply
      don't look until needed. How shared password-manager vaults work today.
      Default for spouse and medical.</p>
    <p class="note"><b>Tier 2 — dead-man's switch.</b> Sealed grants sit with an escrow
      service that watches your npub for silence. <i>The escrow can't read anything.
      It can release early, late, or never. Choose an operator you'd trust as a
      timer — or self-host it.</i> Your normal nostr activity is the heartbeat;
      the Check in button counts too.</p>
    <p class="note"><b>Tier 3 — paper shares.</b> A scope key split 2-of-3 (SLIP-39)
      across e.g. executor, sibling, attorney. No service anywhere; the cost is a
      coordination ceremony when the time comes, and share-custody discipline until then.</p>
  </div>`

export function renderBreakglass() {
  const el = $('breakglass')
  const esc2 = state.escrow
  const plan = Object.entries(esc2?.scopes ?? {})
    .flatMap(([sid, pubs]) => pubs.map(pub => ({ sid, pub })))
  const scopeName = (sid) => {
    const s = state.myScopes.find(x => x.scopeId === sid)
    return s ? (s.payload?.name ?? s.scopeName) : sid
  }
  const ack = state.escrowAcks.filter(a => !a.warning && a.escrow === esc2?.escrowPub)
    .sort((a, b) => b.at - a.at)[0]
  const pol = sanitizePolicy(esc2?.policy ?? config.policy ?? DEFAULT_POLICY)
  const shamirScopes = state.myScopes.filter(s => !s.draft)

  el.innerHTML = `
    <div class="card ${printedKit() ? '' : ''}" id="bg-kit">
      <div class="head"><div class="name">The paper kit</div>
        <div class="grow"></div>
        ${printedKit() ? '<span class="badge live">printed ✓</span>' : '<span class="badge draft">not printed — setup unfinished</span>'}
      </div>
      <p class="note">Recovery is a piece of paper, not a support ticket. The owner
        sheet carries your passphrase-locked key (ncryptsec) — a found sheet alone
        exposes nothing. Print it, then treat it like the original will.</p>
      <div class="actions">
        <button class="primary" id="bg-print-owner">Print owner sheet</button>
        <span class="msg" id="bg-kit-msg"></span>
      </div>
    </div>

    ${TIER_COPY}

    <div class="card">
      <div class="head"><div class="name">Tier 2 — the dead-man's switch</div>
        <div class="grow"></div>
        ${ack ? `<span class="badge live">escrow holds ${ack.wrapCount} sealed grant(s) ✓</span>`
          : plan.length ? '<span class="badge stale">not armed</span>' : ''}
      </div>
      <div class="kv"><label>Escrow operator npub</label>
        <input class="wide" id="bg-escrow-pub" placeholder="npub of the operator (or your self-hosted daemon)"
          value="${esc2?.escrowPub ? esc(nip19.npubEncode(esc2.escrowPub)) : ''}"></div>
      <div class="kv"><label>Quiet days before outreach</label>
        <input type="number" id="bg-quiet" value="${pol.quiet_days}" min="1"></div>
      <div class="kv"><label>Grace days before staging</label>
        <input type="number" id="bg-grace" value="${pol.grace_days}" min="1"></div>
      <div class="kv"><label>Veto window (days)</label>
        <input type="number" id="bg-veto" value="${pol.veto_days}" min="1"></div>
      <div class="kv"><label>Out-of-band contact</label>
        <input class="wide" id="bg-contact" placeholder="email or URL the operator uses to reach you"
          value="${esc(esc2?.contact ?? '')}"></div>
      <div class="sect2">Challenge contacts — can pause a staged release</div>
      <div class="chips">
        ${(esc2?.challengeContacts ?? []).map(p => `
          <span class="chip on">${esc(personName(p))}<button class="x" data-unchal="${p}">×</button></span>`).join('')}
        <select id="bg-chal" style="font-size:12px">
          <option value="">+ contact…</option>
          ${state.people.filter(p => !(esc2?.challengeContacts ?? []).includes(p.pub))
            .map(p => `<option value="${p.pub}">${esc(p.name)}</option>`).join('')}
        </select>
      </div>
      <div class="sect2">Escrowed grants in the plan</div>
      <div class="chips">
        ${plan.length ? plan.map(x => `<span class="chip escrow">${esc(scopeName(x.sid))} → ${esc(personName(x.pub))}</span>`).join('')
          : '<span class="msg">none yet — add people to scopes as "at break-glass" in My record or People</span>'}
      </div>
      <div class="timeline">With these numbers: your last activity + <b>${pol.quiet_days} days</b> of
        silence → the operator tries to reach you · + <b>${pol.grace_days} more</b> →
        challenge contacts are warned · + <b>${pol.veto_days} days</b> with no veto →
        the sealed grants publish and your beneficiaries can read. Any activity —
        or one veto — resets everything.</div>
      <div class="actions">
        <button class="primary" id="bg-arm">${ack ? 'Re-arm (replace deposit)' : 'Arm the switch'}</button>
        ${plan.length ? '<button class="danger" id="bg-disarm">Disarm (cancel deposit)</button>' : ''}
        <span class="msg" id="bg-msg"></span>
      </div>
      ${ack ? `<p class="msg">Last acknowledged by the operator ${new Date(ack.at * 1000).toLocaleString()} —
        deposit ${esc(String(ack.depositId).slice(0, 12))}…</p>` : ''}
    </div>

    <div class="card">
      <div class="head"><div class="name">Tier 3 — paper shares (SLIP-39)</div></div>
      <p class="note">Split a scope's key across people; any 2 of 3 cards reconstitute
        that one scope, ever, with no service. Shares are delivered to holders with
        nostr keys AND printed as cards — cards are the ones that survive decades.</p>
      ${shamirScopes.map(s => {
        const sh = state.shamir[s.scopeId]
        return `<div class="kv" data-shamir="${s.scopeId}">
          <label>${esc(s.payload?.name ?? s.scopeName)}</label>
          ${sh ? `<span class="chip tier3">${sh.threshold}-of-${sh.count}: ${sh.holders.map(h => esc(h.name)).join(', ')}
              ${sh.v === s.generation ? '' : ' · <b>STALE — key rotated</b>'}</span>
            <button data-resplit="${s.scopeId}">${sh.v === s.generation ? 'Re-split + reprint' : 'Re-split now (required)'}</button>
            <button data-unsplit="${s.scopeId}">Remove</button>`
          : `<button data-split="${s.scopeId}">Split 2-of-3…</button>`}
        </div>`
      }).join('') || '<p class="msg">publish a scope first</p>'}
      <span class="msg" id="bg-sh-msg"></span>
    </div>`

  $('bg-print-owner').onclick = () => printOwnerSheet($('bg-kit-msg'))
  $('bg-chal')?.addEventListener('change', async (e) => {
    if (!e.target.value) return
    state.escrow ??= { escrowPub: '', policy: null, challengeContacts: [], scopes: {} }
    state.escrow.challengeContacts = [...(state.escrow.challengeContacts ?? []), e.target.value]
    await syncIndex(); renderBreakglass()
  })
  for (const b of el.querySelectorAll('[data-unchal]'))
    b.onclick = async () => {
      state.escrow.challengeContacts = state.escrow.challengeContacts.filter(p => p !== b.dataset.unchal)
      await syncIndex(); renderBreakglass()
    }
  $('bg-arm').onclick = () => armSwitch($('bg-msg'))
  $('bg-disarm')?.addEventListener('click', async () => {
    if (!confirm('Disarm the dead-man\'s switch?\n\nThe operator deletes the sealed grants; nothing will ever release automatically. Escrow plan entries stay listed so you can re-arm.')) return
    await collectEscrowForm()
    if (!state.escrow?.escrowPub) { $('bg-msg').textContent = 'no operator configured'; return }
    await sendDeposit(state.relay, state.signer, state.escrow.escrowPub,
      { wraps: [], policy: sanitizePolicy(state.escrow.policy), challengeContacts: [], contact: '' })
    state.escrow.armedAt = null
    await syncIndex()
    $('bg-msg').textContent = 'cancellation sent — the operator confirms by dropping the deposit'
  })
  for (const b of el.querySelectorAll('[data-split]')) b.onclick = () => splitFlow(b.dataset.split)
  for (const b of el.querySelectorAll('[data-resplit]')) b.onclick = () => splitFlow(b.dataset.resplit)
  for (const b of el.querySelectorAll('[data-unsplit]'))
    b.onclick = async () => {
      if (!confirm('Remove the paper-share arrangement for this scope?\n\nExisting cards keep working until the key rotates — rotate the scope (revoke someone or re-split) if the cards must die.')) return
      delete state.shamir[b.dataset.unsplit]
      await syncIndex(); renderBreakglass()
    }
}

async function collectEscrowForm() {
  const raw = $('bg-escrow-pub').value.trim()
  let pub = ''
  if (raw) {
    try { pub = /^[0-9a-f]{64}$/i.test(raw) ? raw.toLowerCase() : nip19.decode(raw).data }
    catch { throw new Error('operator npub unreadable') }
  }
  state.escrow ??= { escrowPub: '', policy: null, challengeContacts: [], scopes: {} }
  state.escrow.escrowPub = pub
  state.escrow.policy = sanitizePolicy({
    quiet_days: Number($('bg-quiet').value), grace_days: Number($('bg-grace').value),
    veto_days: Number($('bg-veto').value),
  })
  state.escrow.contact = $('bg-contact').value.trim()
}

async function armSwitch(msgEl) {
  const msg = (t) => { msgEl.textContent = t }
  try { await collectEscrowForm() } catch (err) { msg(err.message); return }
  if (!state.escrow.escrowPub) { msg('set the escrow operator npub first (or run your own: see escrow/README.md)'); return }
  const plan = Object.entries(state.escrow.scopes ?? {})
    .flatMap(([sid, pubs]) => pubs.map(pub => ({ sid, pub })))
  if (!plan.length) { msg('nothing to escrow — mark people "at break-glass" on scopes first'); return }
  msg(`sealing ${plan.length} grant(s)…`)
  const wraps = []
  for (const { sid, pub } of plan) {
    const s = state.myScopes.find(x => x.scopeId === sid)
    if (!s || s.draft) continue
    wraps.push(await buildSealedGrant(state.signer, pub,
      { scopeId: s.scopeId, generation: s.generation, scopeKey: s.scopeKey,
        scopeName: s.payload?.name ?? s.scopeName, relayHint: RELAYS[0] }))
  }
  msg('depositing with the operator…')
  await sendDeposit(state.relay, state.signer, state.escrow.escrowPub, {
    wraps, policy: state.escrow.policy,
    challengeContacts: state.escrow.challengeContacts ?? [], contact: state.escrow.contact ?? '',
  })
  state.escrow.armedAt = Math.floor(Date.now() / 1000)
  await syncIndex()
  msg(`deposit sent (${wraps.length} sealed grants) — the operator's ack appears here after its next sweep`)
}

/** Re-seal and re-deposit after anything that changes keys or the plan.
 *  Called from vault (rotation, escrow-plan edits) and people. No-op until
 *  an operator is configured — the plan is stored either way. */
export async function rebuildDeposit(msg = () => {}) {
  if (!state.escrow?.escrowPub) { msg('escrow plan saved — arm the switch in Break-glass when ready'); return }
  const plan = Object.entries(state.escrow.scopes ?? {})
    .flatMap(([sid, pubs]) => pubs.map(pub => ({ sid, pub })))
  const wraps = []
  for (const { sid, pub } of plan) {
    const s = state.myScopes.find(x => x.scopeId === sid)
    if (!s || s.draft) continue
    wraps.push(await buildSealedGrant(state.signer, pub,
      { scopeId: s.scopeId, generation: s.generation, scopeKey: s.scopeKey,
        scopeName: s.payload?.name ?? s.scopeName, relayHint: RELAYS[0] }))
  }
  await sendDeposit(state.relay, state.signer, state.escrow.escrowPub, {
    wraps, policy: sanitizePolicy(state.escrow.policy),
    challengeContacts: state.escrow.challengeContacts ?? [], contact: state.escrow.contact ?? '',
  })
  state.escrow.armedAt = Math.floor(Date.now() / 1000)
  msg(`escrow deposit rebuilt (${wraps.length} sealed grants)`)
}

async function splitFlow(scopeId) {
  const s = state.myScopes.find(x => x.scopeId === scopeId)
  const msg = (t) => { $('bg-sh-msg').textContent = t }
  const name = s.payload?.name ?? s.scopeName
  const holders = []
  for (let i = 0; i < 3; i++) {
    const who = prompt(`Shareholder ${i + 1} of 3 for "${name}" — a name (executor, sibling, attorney…). Card ${i + 1} prints for them; if they're in People, type the exact name to also deliver the share to their key:`)
    if (!who) { msg('split cancelled'); return }
    const known = state.people.find(p => p.name.toLowerCase() === who.trim().toLowerCase())
    holders.push({ name: who.trim(), pub: known?.pub })
  }
  msg('splitting the scope key 2-of-3…')
  const mnemonics = splitScopeKey(s.scopeKey, { count: 3, threshold: 2 })
  for (const [i, h] of holders.entries())
    if (h.pub) await sendShare(state.relay, state.signer, h.pub, {
      scopeId: s.scopeId, generation: s.generation, scopeName: name,
      mnemonic: mnemonics[i], threshold: 2, count: 3, index: i,
    })
  state.shamir[s.scopeId] = { threshold: 2, count: 3, holders, v: s.generation }
  await syncIndex()
  msg('printing the three cards — hand them out; the words are NOT stored anywhere')
  printShamirCards({ scope: s, holders, mnemonics, threshold: 2, count: 3 })
  renderBreakglass()
}
