// claim.mjs — the beneficiary side: everything shared WITH you, in every
// tier. Live scopes render with an honest freshness line (v + last update);
// rotated-away scopes say so instead of silently vanishing; "you are named"
// notices tell heirs to keep their key; release warnings give challenge
// contacts a one-tap veto; and the Shamir ceremony reconstitutes a scope
// from paper cards. Plus the bearer-invite opener (logged-out flow).

import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { localSigner, receiveGrants, latestGrants, fetchScope } from '../lib/nipxx.mjs'
import { sendClaimRequest } from '../shared/invite.mjs'
import { sendVeto } from '../shared/escrowpkg.mjs'
import { combineShares, validShareWords } from '../shared/shamir.mjs'
import { LiveRelay } from '../lib/liverelay.mjs'
import { $, esc, short, fmtSize, personName, state, login, RELAYS } from './main.mjs'
import { docBytes, saveFile } from './docs.mjs'
import { printKeyCard } from './paperkit.mjs'

export function renderReceived() {
  const el = $('received')
  const live = state.incoming.filter(g => g.status === 'ok')
  const gone = state.incoming.filter(g => g.status !== 'ok')
  const warnings = state.escrowAcks.filter(a => a.warning)

  el.innerHTML = `
    ${warnings.map((w, i) => `
      <div class="banner">⚠ An escrow service has STAGED the release of
        ${esc(personName(w.ownerPub))}'s sealed grants — it believes they may have died
        or gone silent. If you know better, veto it:
        <button class="danger" data-veto="${i}">Veto the release</button>
        <span class="msg" data-vmsg="${i}"></span></div>`).join('')}
    ${state.notices.named.map(n => `
      <div class="banner green">You are named in ${esc(personName(n.owner))}'s vault.
        Nothing is readable yet — access arrives at this key when it's needed.
        Keep this key safe (paper sheet, passphrase); that is all that's asked of you.</div>`).join('')}
    ${state.notices.revocations.map(r => `
      <div class="banner">${esc(personName(r.owner))} ended your access to a scope
        ${r.reason ? `(“${esc(r.reason)}”)` : ''} — anything you already read stays with you;
        there will be no more updates.</div>`).join('')}
    ${state.myShares.length ? shareCeremonyCard() : ''}
    ${live.map(card).join('')}
    ${gone.map(g => `
      <div class="card">
        <div class="head"><span class="name">${esc(g.scopeName ?? 'a scope')}</span>
          <span class="badge stale">access ended</span>
          <div class="grow"></div><span class="meta">from ${esc(personName(g.publisher))}</span></div>
        <p class="note">The key you hold was rotated past. Your last-read copy is yours;
          this view no longer updates.</p>
      </div>`).join('')}
    ${!live.length && !gone.length && !state.myShares.length && !state.notices.named.length
      ? '<div class="empty">Nothing shared with you yet. When someone grants you a scope — now or by break-glass — it appears here, always current.</div>' : ''}`

  for (const g of live) wireCard(el, g)
  if (state.myShares.length) wireCeremony(el)
  for (const [i, w] of warnings.entries()) {
    el.querySelector(`[data-veto="${i}"]`)?.addEventListener('click', async (e) => {
      const m = el.querySelector(`[data-vmsg="${i}"]`)
      m.textContent = 'sending veto…'
      await sendVeto(state.relay, state.signer, w.escrow, w.ownerPub, 'challenged by contact')
      m.textContent = 'veto sent — the countdown resets; the operator confirms on its next sweep'
      e.target.disabled = true
    })
  }
}

function card(g) {
  const p = g.data
  return `
    <div class="card" data-in="${g.publisher}:${g.scopeId}">
      <div class="head">
        <span class="name">${esc(p.name)}</span>
        <span class="badge live">v${g.generation} · live</span>
        <div class="grow"></div>
        <span class="meta">from ${esc(personName(g.publisher))} ·
          updated ${p.updated_at ? new Date(p.updated_at * 1000).toLocaleDateString() : '—'}</span>
      </div>
      <div class="items">
        ${p.items.filter(i => i.value).map(i => `
          <div class="item"><span class="lbl">${esc(i.label)}</span><span class="val">${esc(i.value)}</span></div>`).join('')}
      </div>
      ${p.note ? `<p class="note">${esc(p.note)}</p>` : ''}
      <div class="docs">
        ${(p.docs ?? []).map((d, i) => `
          <div class="doc"><span class="fname">${esc(d.name)}</span>
            <span class="fsize">${fmtSize(d.size)}</span>
            <a data-dl="${i}">download</a></div>`).join('')}
      </div>
      <p class="msg">This is the owner's authoritative current record, decrypted in your
        browser — not a copy. If they edit it, you see the edit.</p>
      <div class="msg" data-msg></div>
    </div>`
}

function wireCard(el, g) {
  const root = el.querySelector(`[data-in="${g.publisher}:${g.scopeId}"]`)
  const msg = (t) => { root.querySelector('[data-msg]').textContent = t }
  for (const a of root.querySelectorAll('[data-dl]'))
    a.onclick = async () => {
      const d = g.data.docs[Number(a.dataset.dl)]
      msg(`fetching ${d.name} (hash-verified)…`)
      try { saveFile(d.name, d.mime, await docBytes(d)); msg('') }
      catch (err) { msg(`download failed: ${err.message}`) }
    }
}

// --- the Shamir ceremony ----------------------------------------------------------

function shareCeremonyCard() {
  return `
    <div class="card cere" id="ceremony">
      <div class="head"><div class="name">Paper shares you hold</div></div>
      ${state.myShares.map(s => `
        <p class="note">Share ${s.index + 1} of ${s.count} for “${esc(s.scopeName)}”
          from ${esc(personName(s.owner))} — any ${s.threshold} shares open it.
          <a data-showshare="${s.owner}:${s.scopeId}:${s.index}">show words</a>
          <a data-printshare="${s.owner}:${s.scopeId}:${s.index}" style="margin-left:8px">print card</a></p>
        <div class="phrase" style="display:none" data-words="${s.owner}:${s.scopeId}:${s.index}">${esc(s.mnemonic)}</div>`).join('')}
      <div class="sect2">Combine shares — the ceremony</div>
      <p class="note">Gather ${state.myShares[0]?.threshold ?? 2} shareholders on this one
        device. Enter each card's words (yours can be prefilled). The key reconstitutes
        here in the browser, opens that one scope, and is forgotten on reload.</p>
      <textarea id="cere-words" rows="4" placeholder="one share per line — twenty words each"></textarea>
      <div class="actions">
        <button id="cere-prefill">Prefill my share</button>
        <button class="primary" id="cere-go">Reconstitute</button>
        <span class="msg" id="cere-msg"></span>
      </div>
      <div id="cere-out"></div>
    </div>`
}

function wireCeremony(el) {
  for (const a of el.querySelectorAll('[data-showshare]'))
    a.onclick = () => {
      const w = el.querySelector(`[data-words="${a.dataset.showshare}"]`)
      w.style.display = w.style.display === 'none' ? '' : 'none'
    }
  for (const a of el.querySelectorAll('[data-printshare]'))
    a.onclick = async () => {
      const [owner, scopeId, index] = a.dataset.printshare.split(':')
      const s = state.myShares.find(x => x.owner === owner && x.scopeId === scopeId && String(x.index) === index)
      const { shamirCard } = await import('../shared/paper.mjs')
      $('printcard').innerHTML = shamirCard({
        holderName: 'me', scopeName: s.scopeName, ownerNpub: nip19.npubEncode(s.owner),
        mnemonic: s.mnemonic, threshold: s.threshold, count: s.count, index: s.index, relays: RELAYS,
      })
      window.print()
      $('printcard').innerHTML = ''
    }
  $('cere-prefill').onclick = () => {
    const t = $('cere-words')
    const mine = state.myShares[0]?.mnemonic ?? ''
    if (mine && !t.value.includes(mine)) t.value = (t.value ? t.value.trimEnd() + '\n' : '') + mine + '\n'
  }
  $('cere-go').onclick = async () => {
    const msg = (t) => { $('cere-msg').textContent = t }
    const lines = $('cere-words').value.split('\n').map(l => l.trim()).filter(Boolean)
    const bad = lines.find(l => !validShareWords(l))
    if (bad) { msg(`this line isn't a valid share: “${bad.slice(0, 40)}…”`); return }
    if (lines.length < 2) { msg('enter at least two shares'); return }
    let key
    try { key = combineShares(lines) } catch (err) { msg(`shares don't combine: ${err.message}`); return }
    // which scope? trust the holder's own share record for the pointer
    const ref = state.myShares[0]
    msg('key reconstituted — fetching the scope…')
    const got = await fetchScope(state.relay, {
      publisher: ref.owner, scopeId: ref.scopeId, generation: Number.MAX_SAFE_INTEGER, scopeKey: key,
    })
    if (got.status !== 'ok') { msg('the scope did not decrypt — cards may be stale (key rotated since printing)'); return }
    msg('')
    $('cere-out').innerHTML = `
      <div class="banner green">Reconstituted “${esc(got.data.name)}” — shown below. Nothing was stored.</div>
      <div class="items">${got.data.items.filter(i => i.value).map(i => `
        <div class="item"><span class="lbl">${esc(i.label)}</span><span class="val">${esc(i.value)}</span></div>`).join('')}</div>
      ${got.data.note ? `<p class="note">${esc(got.data.note)}</p>` : ''}
      <div class="docs">${(got.data.docs ?? []).map((d, i) => `
        <div class="doc"><span class="fname">${esc(d.name)}</span>
          <span class="fsize">${fmtSize(d.size)}</span><a data-ceredl="${i}">download</a></div>`).join('')}</div>`
    for (const a of $('cere-out').querySelectorAll('[data-ceredl]'))
      a.onclick = async () => {
        const d = got.data.docs[Number(a.dataset.ceredl)]
        saveFile(d.name, d.mime, await docBytes(d))
      }
  }
}

// --- bearer invite opener (logged out; key in memory only) --------------------------

export async function openInvite({ sk, relays }) {
  $('login').style.display = 'none'
  const el = $('invite')
  el.style.display = ''
  el.innerHTML = '<div class="empty">opening the invitation…</div>'
  const relay = new LiveRelay(relays.length ? relays : RELAYS)
  const grants = latestGrants(await receiveGrants(relay, sk))
  if (!grants.length) {
    el.innerHTML = `<div class="empty">This link isn't active — it may have been
      revoked, already claimed, or superseded. Ask whoever sent it for a fresh one.</div>`
    return
  }
  const g = grants[0]
  const got = await fetchScope(relay, g)
  if (got.status !== 'ok') {
    el.innerHTML = `<div class="empty">This link is no longer active
      (${got.status === 'stale' ? 'it was revoked or claimed' : 'the record is gone'}).</div>`
    return
  }
  const p = got.data
  el.innerHTML = `
    <div class="banner">You're viewing by bearer link — anyone holding this URL sees
      the same. Claim it below to move access onto a key that's yours alone.</div>
    <div class="card">
      <div class="head"><span class="name">${esc(p.name)}</span>
        <span class="badge live">live</span>
        <div class="grow"></div><span class="meta">shared by ${short(g.publisher)}</span></div>
      <div class="items">${p.items.filter(i => i.value).map(i => `
        <div class="item"><span class="lbl">${esc(i.label)}</span><span class="val">${esc(i.value)}</span></div>`).join('')}</div>
      ${p.note ? `<p class="note">${esc(p.note)}</p>` : ''}
      <div class="docs">${(p.docs ?? []).map((d, i) => `
        <div class="doc"><span class="fname">${esc(d.name)}</span>
          <span class="fsize">${fmtSize(d.size)}</span><a data-invdl="${i}">download</a></div>`).join('')}</div>
      <div class="actions">
        <button class="primary" id="inv-claim">Claim this — make it mine</button>
        <span class="msg" id="inv-msg"></span>
      </div>
      <div id="inv-out"></div>
    </div>`
  for (const a of el.querySelectorAll('[data-invdl]'))
    a.onclick = async () => {
      const d = p.docs[Number(a.dataset.invdl)]
      const cipherOrBytes = await docBytes(d)
      saveFile(d.name, d.mime, cipherOrBytes)
    }
  $('inv-claim').onclick = async () => {
    const rSk = generateSecretKey()
    $('inv-msg').textContent = 'requesting your durable key be let in…'
    await sendClaimRequest(relay, sk, g.publisher, g.scopeId, getPublicKey(rSk))
    $('inv-out').innerHTML = `
      <div class="phrase">${nip19.nsecEncode(rSk)}</div>
      <p class="warn">This new key is YOURS — the sender approves the claim and access
        moves onto it (this link then dies). Write the key down or print it; it is the
        only way back in.</p>
      <div class="actions">
        <button id="inv-copy">Copy</button>
        <button id="inv-print">Print card</button>
        <button class="primary" id="inv-continue">Continue with this key</button>
      </div>`
    $('inv-copy').onclick = async (e) => {
      await navigator.clipboard.writeText(nip19.nsecEncode(rSk))
      e.target.textContent = 'Copied ✓'
    }
    $('inv-print').onclick = () => printKeyCard(rSk)
    $('inv-continue').onclick = () => {
      el.style.display = 'none'
      login(localSigner(rSk), Array.from(rSk, x => x.toString(16).padStart(2, '0')).join(''))
    }
  }
}
