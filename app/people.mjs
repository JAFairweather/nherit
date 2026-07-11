// people.mjs — the beneficiary registry: who is named, how they hold keys,
// and what each person can read across the record (the person axis of the
// scope × person matrix; the scope axis lives in vault.mjs).
//
// Three onboarding paths, in the order estates actually meet them:
//   1. invite link (vault tab) — most heirs have no nostr key
//   2. mint-a-key-for-them + print their sheet — the executor/grandma path;
//      the key is born at print time and never stored
//   3. paste an npub — they're already on nostr

import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import * as nip49 from 'nostr-tools/nip49'
import { grant } from '../lib/nipxx.mjs'
import { sendNamedNotice } from '../shared/notices.mjs'
import { $, esc, short, state, syncIndex, load, personName } from './main.mjs'
import { rebuildDeposit } from './breakglass.mjs'
import { printBeneficiarySheet } from './paperkit.mjs'

export function renderPeople() {
  const el = $('people')
  el.innerHTML = `
    <div class="newbar">
      <input id="pp-name" placeholder="name" style="max-width:160px">
      <input id="pp-rel" placeholder="relation (spouse, executor…)" style="max-width:200px">
      <input id="pp-npub" placeholder="npub… / hex — or leave empty to mint a key for them" style="flex:1;font-family:var(--mono);font-size:12.5px">
      <button class="primary" id="pp-add">Add person</button>
    </div>
    <p class="msg" id="pp-msg">A person with no key gets one minted here — you print
      their recovery sheet, hand it over (or store it with the will), and the key
      is forgotten by this browser the moment the sheet prints. Prefer the invite
      link on a scope when you can reach them online.</p>
    ${state.people.length ? '' : '<div class="empty">Nobody named yet. Your spouse and executor are the usual first two.</div>'}
    ${state.people.map(card).join('')}`

  $('pp-add').onclick = addPerson
  for (const p of state.people) wire(el, p)
}

function card(p) {
  const scopes = state.myScopes.filter(s => !s.draft)
  const access = scopes.map(s => {
    const now = s.grantees.includes(p.pub)
    const escd = (state.escrow?.scopes?.[s.scopeId] ?? []).includes(p.pub)
    const sh = state.shamir[s.scopeId]?.holders?.some(h => h.pub === p.pub)
    if (now) return `<span class="chip on">${esc(s.payload?.name ?? s.scopeName)} · now</span>`
    if (escd) return `<span class="chip escrow">${esc(s.payload?.name ?? s.scopeName)} · at break-glass</span>`
    if (sh) return `<span class="chip tier3">${esc(s.payload?.name ?? s.scopeName)} · shareholder</span>`
    return `<span class="chip ghost" data-give="${s.scopeId}:${p.pub}">+ ${esc(s.payload?.name ?? s.scopeName)}</span>`
  }).join('')
  const escrowedOnly = !scopes.some(s => s.grantees.includes(p.pub))
    && scopes.some(s => (state.escrow?.scopes?.[s.scopeId] ?? []).includes(p.pub))
  return `
    <div class="card person" data-person="${p.pub}">
      <div class="who">
        <div class="name">${esc(p.name)}</div>
        <div class="rel">${esc(p.relation || '')}${p.managed ? ' · key minted here' : ''}</div>
        <div class="meta" title="${nip19.npubEncode(p.pub)}">${short(p.pub)}</div>
      </div>
      <div class="access">
        <div class="chips">${access || '<span class="msg">no scopes published yet</span>'}</div>
        <div class="actions">
          ${escrowedOnly && !p.notified ? `<button data-notify title="they learn THAT they're named — never what's inside">Tell them they're named</button>` : ''}
          ${p.notified ? '<span class="msg">notified they are named ✓</span>' : ''}
          <button class="icon" data-rmperson title="remove from registry (does not revoke grants)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2m1 0-1 14H8L7 6"/></svg>
          </button>
          <span class="msg" data-pmsg></span>
        </div>
      </div>
    </div>`
}

function wire(el, p) {
  const root = el.querySelector(`[data-person="${p.pub}"]`)
  const msg = (t) => { root.querySelector('[data-pmsg]').textContent = t }
  for (const chip of root.querySelectorAll('[data-give]'))
    chip.onclick = async () => {
      const [scopeId, pub] = chip.dataset.give.split(':')
      const s = state.myScopes.find(x => x.scopeId === scopeId)
      const when = confirm(`Share "${s.payload?.name ?? s.scopeName}" with ${p.name} NOW?\n\nOK = immediate (they can read it today).\nCancel = choose escrowed instead (released by the dead-man's switch).`)
      if (when) {
        msg('granting…')
        await grant(state.relay, state.signer, pub, { ...s, scopeName: s.payload?.name ?? s.scopeName })
        s.grantees.push(pub)
        await syncIndex()
      } else {
        state.escrow ??= { escrowPub: '', policy: null, challengeContacts: [], scopes: {} }
        ;(state.escrow.scopes[scopeId] ??= []).push(pub)
        await syncIndex()
        await rebuildDeposit(msg)
      }
      load()
    }
  root.querySelector('[data-notify]')?.addEventListener('click', async () => {
    msg('sending named-notice…')
    await sendNamedNotice(state.relay, state.signer, p.pub,
      `You are named in an estate vault. Keep the key this arrived at safe — access will arrive there when it's needed. Nothing further is required of you now.`)
    p.notified = true
    await syncIndex()
    renderPeople()
  })
  root.querySelector('[data-rmperson]').onclick = async () => {
    const holds = state.myScopes.some(s => s.grantees.includes(p.pub))
    if (holds && !confirm(`${p.name} still holds live grants — removing them from the registry does NOT revoke access (use × on the scope chips for that). Remove anyway?`)) return
    state.people = state.people.filter(x => x.pub !== p.pub)
    await syncIndex()
    renderPeople()
  }
}

async function addPerson() {
  const name = $('pp-name').value.trim()
  const relation = $('pp-rel').value.trim()
  const raw = $('pp-npub').value.trim()
  const msg = (t) => { $('pp-msg').textContent = t }
  if (!name) { msg('a name, at least — this is your ledger'); return }
  let pub, managed = false
  if (raw) {
    try {
      pub = /^[0-9a-f]{64}$/i.test(raw) ? raw.toLowerCase() : (() => {
        const d = nip19.decode(raw)
        if (d.type !== 'npub') throw new Error()
        return d.data
      })()
    } catch { msg('that is not an npub or hex pubkey'); return }
  } else {
    // Mint a key FOR them: passphrase → print sheet → forget the secret.
    const pass = prompt(`Minting a key for ${name}.\n\nChoose a passphrase for their sheet (they'll need it to use the key — tell them, or store it separately from the paper):`)
    if (!pass || pass.length < 8) { msg('passphrase of 8+ characters required'); return }
    const sk = generateSecretKey()
    pub = getPublicKey(sk)
    msg('encrypting their key (scrypt — a second or two)…')
    await new Promise(r => setTimeout(r, 30))
    const ncryptsec = nip49.encrypt(sk, pass)
    printBeneficiarySheet({ name, relation, ncryptsec, pub })
    managed = true
    msg(`sheet printed for ${name}; their secret key is not stored anywhere — the paper is it`)
  }
  if (state.people.some(x => x.pub === pub)) { msg('already in the registry'); return }
  state.people.push({ pub, name, relation, managed })
  await syncIndex()
  $('pp-name').value = ''; $('pp-rel').value = ''; $('pp-npub').value = ''
  renderPeople()
}
