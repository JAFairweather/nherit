// settings.mjs — per-device policy: relays, Blossom servers, escrow-timing
// defaults. Saving reloads the page so every module sees one consistent
// config snapshot. Estate horizon honesty: free public infrastructure makes
// no persistence promise measured in decades — say so, and document
// self-mirroring.

import { loadConfig, saveConfig, resetConfig, defaultConfig } from '../shared/config.mjs'
import { $, esc } from './main.mjs'

export function renderSettings() {
  const cfg = loadConfig()
  const el = $('settings')
  el.innerHTML = `
    <div class="banner">Estate horizon honesty: public relays and blob hosts are
      free-tier infrastructure with <b>no persistence guarantee measured in
      decades</b>. For a record meant to outlive you, add a relay/host you (or a
      paid operator) control — and keep the paper kit current either way: paper
      needs no operator.</div>
    <div class="card">
      <div class="name">Relays</div>
      <p class="note">Where the encrypted record and grants live. wss:// only.</p>
      <div id="cfg-relays">
        ${cfg.relays.map((r, i) => `
          <div class="row cfg"><input class="relay-url" value="${esc(r)}">
            <button class="icon" data-rmr="${i}">×</button></div>`).join('')}
      </div>
      <div class="actions"><button id="add-relay">+ relay</button></div>
    </div>
    <div class="card">
      <div class="name">Blob hosts (documents)</div>
      <p class="note">Encrypted document bodies mirror to every host listed. A
        "managed" host is one you expect to demand auth or payment.</p>
      <div id="cfg-servers">
        ${cfg.servers.map((s, i) => `
          <div class="row cfg"><input class="server-url" value="${esc(s.url)}">
            <label class="managed"><input type="checkbox" class="server-auth" ${s.requiresAuth ? 'checked' : ''}> managed</label>
            <button class="icon" data-rms="${i}">×</button></div>`).join('')}
      </div>
      <div class="actions"><button id="add-server">+ host</button></div>
    </div>
    <div class="card">
      <div class="name">Dead-man's switch defaults</div>
      <p class="note">Offered when arming the switch; each deposit carries its own copy.</p>
      <div class="kv"><label>Quiet days before outreach</label>
        <input type="number" id="cfg-quiet" value="${cfg.policy.quiet_days}" min="1"></div>
      <div class="kv"><label>Grace days before staging</label>
        <input type="number" id="cfg-grace" value="${cfg.policy.grace_days}" min="1"></div>
      <div class="kv"><label>Veto window (days)</label>
        <input type="number" id="cfg-veto" value="${cfg.policy.veto_days}" min="1"></div>
    </div>
    <div class="actions">
      <button class="primary" id="cfg-save">Save & reload</button>
      <button id="cfg-reset">Restore defaults</button>
      <span class="msg" id="cfg-msg"></span>
    </div>`

  $('add-relay').onclick = () => {
    $('cfg-relays').insertAdjacentHTML('beforeend',
      '<div class="row cfg"><input class="relay-url" placeholder="wss://…"><button class="icon" data-rmr>×</button></div>')
    wireRemoves()
  }
  $('add-server').onclick = () => {
    $('cfg-servers').insertAdjacentHTML('beforeend',
      '<div class="row cfg"><input class="server-url" placeholder="https://…"><label class="managed"><input type="checkbox" class="server-auth"> managed</label><button class="icon" data-rms>×</button></div>')
    wireRemoves()
  }
  function wireRemoves() {
    for (const b of el.querySelectorAll('[data-rmr],[data-rms]'))
      b.onclick = () => b.closest('.row').remove()
  }
  wireRemoves()

  $('cfg-save').onclick = () => {
    const relays = [...el.querySelectorAll('.relay-url')].map(i => i.value.trim()).filter(Boolean)
    const bad = relays.find(r => { try { return new URL(r).protocol !== 'wss:' } catch { return true } })
    if (bad) { $('cfg-msg').textContent = `not a wss:// relay: ${bad}`; return }
    const servers = [...el.querySelectorAll('#cfg-servers .row')].map(row => ({
      url: row.querySelector('.server-url').value.trim(),
      requiresAuth: row.querySelector('.server-auth').checked,
    })).filter(s => s.url)
    saveConfig({
      relays, servers, escrowPub: cfg.escrowPub,
      policy: {
        quiet_days: Number($('cfg-quiet').value), grace_days: Number($('cfg-grace').value),
        veto_days: Number($('cfg-veto').value),
      },
    })
    location.reload()
  }
  $('cfg-reset').onclick = () => {
    resetConfig()
    location.reload()
  }
}
