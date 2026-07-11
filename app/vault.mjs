// vault.mjs — "My record": the estate as ONE card, scopes as sections in
// canonical order (spec §3). Editing republishes under the same key — free
// update, every grantee current. Revoking rotates — new key, bumped v,
// survivors re-granted — and cascades to escrow deposits and Shamir splits,
// because those hold the OLD key material.

import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { newScopeKey, publishScope, grant, rotateScope, deleteScope } from '../lib/nipxx.mjs'
import { TEMPLATES, templateById, newScopePayload, scopeOrder, validateScopePayload, PASSWORD_HINT } from '../shared/estate.mjs'
import { sendRevocationNotice } from '../shared/notices.mjs'
import { buildInviteUrl, createInvite } from '../shared/invite.mjs'
import { $, esc, fmtSize, personName, state, syncIndex, load, RELAYS, storedNcryptsec } from './main.mjs'
import { attachFile, docBytes, saveFile } from './docs.mjs'
import { rebuildDeposit } from './breakglass.mjs'
import { printedKit } from './paperkit.mjs'

const rand = () => 'nh' + crypto.getRandomValues(new Uint8Array(6)).reduce((s, b) => s + (b % 36).toString(36), '')

const scopeTitle = (s) => s.payload?.name ?? s.scopeName

/** Which templates aren't on the record yet (perPerson ones always offered). */
const missingTemplates = () =>
  TEMPLATES.filter(t => t.perPerson || !state.myScopes.some(s => s.payload?.template === t.id || (s.draft && s.payload.template === t.id)))

export function renderVault() {
  const el = $('vault')
  const scopes = [...state.myScopes].sort((a, b) => scopeOrder(a.payload ?? { template: '', name: a.scopeName }, b.payload ?? { template: '', name: b.scopeName }))

  const kitBanner = !printedKit() && state.myScopes.some(s => !s.draft) ? `
    <div class="banner">Setup isn't finished until the paper kit is printed —
      if this browser dies, paper is the only way back. Print it from
      <a href="#breakglass" onclick="document.querySelector('[data-tab=breakglass]').click();return false"
         style="color:inherit">Break-glass</a>.</div>` : ''

  el.innerHTML = `
    ${kitBanner}
    <div class="newbar">
      <span class="msg">Add to your record:</span>
      ${missingTemplates().map(t => `<button data-tpl="${t.id}" title="${esc(t.hint)}">+ ${esc(t.name)}</button>`).join('')}
      <button data-tpl="custom">+ Custom…</button>
    </div>
    <div class="card" id="record">
      <div class="head">
        <div class="name">Your estate record</div>
        <div class="grow"></div>
        <span class="meta">${scopes.filter(s => !s.draft).length} published scope(s) · one authoritative copy, yours</span>
      </div>
      ${scopes.length ? '' : `<p class="note" style="margin-top:12px">Empty. Start with Medical —
        it's the scope someone may need while you're alive.</p>`}
      ${scopes.map(sec).join('')}
    </div>`

  for (const b of el.querySelectorAll('[data-tpl]')) b.onclick = () => addScope(b.dataset.tpl)
  for (const s of scopes) wireScope(el, s)
}

function sec(s) {
  const p = s.payload
  const id = s.scopeId
  if (s.lost) return `
    <div class="scope" data-scope="${id}">
      <div class="head"><span class="name">${esc(s.scopeName)}</span>
        <span class="badge stale">unreadable — key mismatch on relay</span></div>
      <p class="note">The published event doesn't decrypt with the indexed key.
        Republish from the index (rotate) or delete the scope.</p>
      <div class="actions"><button class="danger" data-del>Delete scope</button></div>
    </div>`
  const t = templateById(p.template)
  const tierOf = (pub) => state.escrow?.scopes?.[id]?.includes(pub) ? 'escrow' : 'on'
  const sh = state.shamir[id]
  return `
    <div class="scope" data-scope="${id}">
      <div class="head">
        <span class="name">${esc(p.name)}</span>
        ${s.draft ? '<span class="badge draft">draft — not on relays yet</span>'
          : `<span class="badge live">v${s.generation} live</span>`}
        <div class="grow"></div>
        <button data-edit>${s.editing ? 'Cancel' : 'Edit'}</button>
        ${s.editing || s.draft ? '<button class="primary" data-publish>Publish</button>' : ''}
        <button class="icon" data-del title="delete scope — destroys the ciphertext on conforming relays">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2m1 0-1 14H8L7 6"/></svg>
        </button>
      </div>
      ${t ? `<div class="hint">${esc(t.hint)}</div>` : ''}
      ${s.editing || s.draft ? editItems(p) : viewItems(p)}
      <div class="docs">
        ${p.docs.map((d, i) => `
          <div class="doc"><span class="fname">${esc(d.name)}</span>
            <span class="fsize">${fmtSize(d.size)}${d.servers ? ' · encrypted blob ×' + d.servers.length : ' · inline'}</span>
            <a data-dl="${i}">download</a>
            ${s.editing || s.draft ? `<button class="icon" data-rmdoc="${i}" title="remove">×</button>` : ''}
          </div>`).join('')}
      </div>
      ${s.editing || s.draft ? `<div class="drop" data-drop>drop scans here, or click — the will,
        deeds, policies. ≤48 KB rides inside the record; bigger files are encrypted
        onto public blob hosts.</div>` : ''}
      <div class="sect2">Who can read this ${s.draft ? '(grant after publishing)' : ''}</div>
      <div class="chips">
        ${s.grantees.filter(pub => !state.invites.some(i => i.pub === pub && !i.claimed_by)).map(pub => `
          <span class="chip ${tierOf(pub)}">${esc(personName(pub))}${tierOf(pub) === 'escrow' ? ' · escrowed' : ''}
            <button class="x" data-revoke="${pub}" title="revoke — rotates the key; they keep only what they already read">×</button></span>`).join('')}
        ${(state.escrow?.scopes?.[id] ?? []).filter(pub => !s.grantees.includes(pub)).map(pub => `
          <span class="chip escrow">${esc(personName(pub))} · escrowed
            <button class="x" data-unescrow="${pub}" title="remove from the escrow deposit">×</button></span>`).join('')}
        ${state.invites.filter(i => i.scope === id && !i.claimed_by).map(i => `
          <span class="chip invite">link${i.name ? ' for ' + esc(i.name) : ''} · unclaimed
            <button class="x" data-uninvite="${i.pub}" title="revoke this link (rotation)">×</button></span>`).join('')}
        ${sh ? `<span class="chip tier3">paper shares ${sh.threshold}-of-${sh.count}${sh.v < s.generation ? ' · STALE (re-split needed)' : ''}</span>` : ''}
        ${state.pendingClaims.filter(c => c.scope === id).map(c => `
          <span class="chip claim">claim from link
            <button class="approve" data-approve="${c.invitePub}:${c.rPub}">Approve</button></span>`).join('')}
        ${s.draft ? '' : `
          <select data-grantsel style="font-size:12px">
            <option value="">+ person…</option>
            ${state.people.filter(pp => !s.grantees.includes(pp.pub) && !(state.escrow?.scopes?.[id] ?? []).includes(pp.pub))
              .map(pp => `<option value="${pp.pub}">${esc(pp.name)} — now</option>
                          <option value="escrow:${pp.pub}">${esc(pp.name)} — at break-glass (escrow)</option>`).join('')}
          </select>
          <span class="chip ghost" data-mklink>+ invite link (no key needed)</span>`}
      </div>
      <div class="msg" data-msg></div>
      <div data-linkout></div>
    </div>`
}

const viewItems = (p) => `
  <div class="items">
    ${p.items.filter(i => i.value).map(i => `
      <div class="item"><span class="lbl">${esc(i.label)}</span><span class="val">${esc(i.value)}</span></div>`).join('')
    || '<p class="note">No entries yet — Edit to fill it in.</p>'}
  </div>
  ${p.note ? `<p class="note">${esc(p.note)}</p>` : ''}`

const editItems = (p) => `
  <div class="items" data-editor>
    ${p.items.map((i, n) => `
      <div class="item">
        <input class="lbl-in" data-il="${n}" value="${esc(i.label)}" placeholder="label">
        <input class="val-in" data-iv="${n}" value="${esc(i.value)}" placeholder="where it is / what to do">
        <button class="icon" data-irm="${n}">×</button>
      </div>`).join('')}
    <div class="actions"><button data-iadd>+ row</button></div>
    <div class="hint">${esc(PASSWORD_HINT)}</div>
    <textarea data-note rows="2" placeholder="free-form note for readers of this scope">${esc(p.note)}</textarea>
  </div>`

function wireScope(el, s) {
  const root = el.querySelector(`[data-scope="${s.scopeId}"]`)
  if (!root) return
  const msg = (t) => { const m = root.querySelector('[data-msg]'); if (m) m.textContent = t }

  root.querySelector('[data-edit]')?.addEventListener('click', () => {
    if (s.editing) { s.editing = false; load() } else { s.editing = true; renderVault() }
  })

  const collect = () => {
    const p = s.payload
    p.items = [...root.querySelectorAll('[data-il]')].map((lin, n) => ({
      label: lin.value.trim(),
      value: root.querySelector(`[data-iv="${n}"]`).value.trim(),
    })).filter(i => i.label || i.value)
    p.note = root.querySelector('[data-note]')?.value.trim() ?? p.note
  }
  root.querySelector('[data-iadd]')?.addEventListener('click', () => {
    collect(); s.payload.items.push({ label: '', value: '' }); renderVault()
  })
  for (const b of root.querySelectorAll('[data-irm]'))
    b.onclick = () => { collect(); s.payload.items.splice(Number(b.dataset.irm), 1); renderVault() }

  root.querySelector('[data-publish]')?.addEventListener('click', async () => {
    collect()
    const problems = validateScopePayload(s.payload)
    if (problems.length) { msg(problems.join('; ')); return }
    msg('publishing…')
    s.payload.updated_at = Math.floor(Date.now() / 1000)
    await publishScope(state.relay, state.signer, { ...s, payload: s.payload })
    s.draft = false; s.editing = false
    await syncIndex()
    msg('published — every grantee is current')
    load()
  })

  root.querySelector('[data-del]')?.addEventListener('click', async () => {
    if (!confirm(`Delete "${scopeTitle(s)}" from the record?\n\nThe ciphertext is destroyed on conforming relays. Grantees see it as revoked; anything they already read stays theirs (like any paper they were handed).`)) return
    if (!s.draft) {
      await deleteScope(state.relay, state.signer, s)
      await sendNoticesFor(s, s.grantees, 'scope deleted')
    }
    state.myScopes = state.myScopes.filter(x => x.scopeId !== s.scopeId)
    delete state.shamir[s.scopeId]
    if (state.escrow?.scopes?.[s.scopeId]) { delete state.escrow.scopes[s.scopeId]; await rebuildDeposit(msg) }
    state.invites = state.invites.filter(i => i.scope !== s.scopeId)
    await syncIndex()
    load()
  })

  // documents
  const drop = root.querySelector('[data-drop]')
  if (drop) {
    const pick = async (files) => {
      for (const f of files) {
        try {
          msg(`attaching ${f.name}…`)
          const entry = await attachFile(f, msg)
          s.payload.docs = s.payload.docs.filter(d => d.name !== f.name).concat(entry)
        } catch (err) { msg(err.message); return }
      }
      renderVault()
    }
    drop.onclick = () => {
      const inp = document.createElement('input')
      inp.type = 'file'; inp.multiple = true
      inp.onchange = () => pick([...inp.files])
      inp.click()
    }
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over') }
    drop.ondragleave = () => drop.classList.remove('over')
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); pick([...e.dataTransfer.files]) }
  }
  for (const a of root.querySelectorAll('[data-dl]'))
    a.onclick = async () => {
      const d = s.payload.docs[Number(a.dataset.dl)]
      msg(`fetching ${d.name}…`)
      try { saveFile(d.name, d.mime, await docBytes(d)); msg('') }
      catch (err) { msg(`download failed: ${err.message}`) }
    }
  for (const b of root.querySelectorAll('[data-rmdoc]'))
    b.onclick = () => { s.payload.docs.splice(Number(b.dataset.rmdoc), 1); renderVault() }

  // grants
  root.querySelector('[data-grantsel]')?.addEventListener('change', async (e) => {
    const v = e.target.value
    if (!v) return
    if (v.startsWith('escrow:')) {
      const pub = v.slice(7)
      state.escrow ??= { escrowPub: '', policy: null, challengeContacts: [], scopes: {} }
      ;(state.escrow.scopes[s.scopeId] ??= []).push(pub)
      await syncIndex()
      msg(`${personName(pub)} added to the escrow plan — arm the switch in Break-glass`)
      await rebuildDeposit(msg)
      renderVault()
    } else {
      msg(`granting to ${personName(v)}…`)
      await grant(state.relay, state.signer, v, { ...s, scopeName: scopeTitle(s) })
      s.grantees.push(v)
      await syncIndex()
      msg('granted — they can read it now')
      renderVault()
    }
  })

  root.querySelector('[data-mklink]')?.addEventListener('click', async () => {
    const name = prompt('Who is this link for? (a name for your ledger; optional)') ?? ''
    msg('minting bearer link…')
    const inv = await createInvite(state.relay, state.signer, { ...s, scopeName: scopeTitle(s) }, RELAYS[0])
    s.grantees.push(inv.pub)
    state.invites.push({ pub: inv.pub, scope: s.scopeId, name, created_at: Math.floor(Date.now() / 1000) })
    await syncIndex()
    const url = buildInviteUrl(location.origin + location.pathname, inv.sk, RELAYS)
    root.querySelector('[data-linkout]').innerHTML = `
      <div class="phrase">${esc(url)}</div>
      <p class="warn">Copy it NOW — the link is the only copy of its key and is not stored.
        Anyone holding it can read this scope until it's claimed or revoked.</p>
      <div class="actions"><button data-cplink>Copy link</button></div>`
    root.querySelector('[data-cplink]').onclick = async (e) => {
      await navigator.clipboard.writeText(url)
      e.target.textContent = 'Copied ✓'
    }
    msg('')
  })

  for (const b of root.querySelectorAll('[data-revoke]')) b.onclick = () => revoke(s, b.dataset.revoke, msg)
  for (const b of root.querySelectorAll('[data-uninvite]')) b.onclick = () => revoke(s, b.dataset.uninvite, msg, true)
  for (const b of root.querySelectorAll('[data-unescrow]'))
    b.onclick = async () => {
      state.escrow.scopes[s.scopeId] = state.escrow.scopes[s.scopeId].filter(p => p !== b.dataset.unescrow)
      if (!state.escrow.scopes[s.scopeId].length) delete state.escrow.scopes[s.scopeId]
      await syncIndex()
      await rebuildDeposit(msg)
      renderVault()
    }
  for (const b of root.querySelectorAll('[data-approve]'))
    b.onclick = async () => {
      const [invitePub, rPub] = b.dataset.approve.split(':')
      const claim = state.pendingClaims.find(c => c.invitePub === invitePub && c.rPub === rPub)
      msg('approving — rotating bearer keys out…')
      const { approveClaim } = await import('../shared/invite.mjs')
      const res = await approveClaim(state.relay, state.signer, { ...s, payload: s.payload }, state.invites, claim)
      Object.assign(s, { generation: res.generation, scopeKey: res.scopeKey, grantees: res.survivors })
      state.invites = state.invites.map(i => i.pub === invitePub
        ? { ...i, claimed_by: rPub, claimed_at: Math.floor(Date.now() / 1000) } : i)
      if (!state.people.some(p => p.pub === rPub)) {
        const inv = state.invites.find(i => i.pub === invitePub)
        state.people.push({ pub: rPub, name: inv?.name || 'claimed by link', relation: '' })
      }
      await afterRotation(s, msg)
      msg('claimed — their durable key reads it now; every outstanding link for this scope is dead')
      load()
    }
}

async function sendNoticesFor(s, pubs, reason) {
  for (const pub of pubs.filter(p => !state.invites.some(i => i.pub === p)))
    await sendRevocationNotice(state.relay, state.signer, pub, { scopeId: s.scopeId, reason })
}

/** Rotation invalidates escrowed wraps and Shamir shares for the scope —
 *  they hold the old key. Rebuild both, loudly. */
export async function afterRotation(s, msg = () => {}) {
  if (state.escrow?.scopes?.[s.scopeId]?.length) {
    msg('rotated — rebuilding the escrow deposit with the new key…')
    await rebuildDeposit(msg)
  }
  if (state.shamir[s.scopeId]) {
    // shares can't be rebuilt silently: holders must get new words + cards
    state.shamir[s.scopeId].v = -1   // mark stale; breakglass shows re-split
    msg('rotated — the paper shares for this scope are now STALE. Re-split in Break-glass and reprint the cards.')
  }
  await syncIndex()
}

async function revoke(s, pub, msg, isLink = false) {
  const who = isLink ? 'this link' : personName(pub)
  if (!confirm(`Cut ${who} off from "${scopeTitle(s)}"?\n\nThe key rotates: they keep only what they already read, and never see another update. This is the thing paper can't do.`)) return
  msg('rotating key, re-granting survivors…')
  const survivors = s.grantees.filter(p => p !== pub)
  const rotated = await rotateScope(state.relay, state.signer, {
    scopeId: s.scopeId, generation: s.generation, scopeName: scopeTitle(s),
    payload: s.payload, survivors,
  })
  Object.assign(s, { generation: rotated.generation, scopeKey: rotated.scopeKey, grantees: survivors })
  if (!isLink) await sendNoticesFor(s, [pub], 'access ended')
  state.invites = state.invites.filter(i => !(i.pub === pub && i.scope === s.scopeId))
  await afterRotation(s, msg)
  msg(`${who} revoked at v${s.generation}`)
  load()
}

async function addScope(tplId) {
  let name
  if (tplId === 'custom') {
    name = prompt('Name for this scope (only grantees ever see it):')
    if (!name) return
  } else if (templateById(tplId)?.perPerson) {
    name = prompt(`This scope is per person — whose is it? (e.g. "For Sam")`)
    if (!name) return
  }
  const payload = newScopePayload(tplId === 'custom' ? null : tplId, name)
  state.myScopes.push({
    scopeId: rand(), scopeName: payload.name, generation: 1, scopeKey: newScopeKey(),
    grantees: [], payload, draft: true, editing: true, publisher: state.me,
  })
  renderVault()
}
