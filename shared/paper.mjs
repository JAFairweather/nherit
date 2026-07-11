// paper.mjs — the paper kit (spec §6.4): printable recovery sheets as HTML
// strings for the print-only div. Paper is the recovery tier that outlives
// every company and every hard drive; each sheet is written for a stranger
// finding it in twenty years, carries the bearer warning on itself, and is
// dated.
//
// The owner sheet ships the ncryptsec — NOT the raw nsec — so a leaked
// sheet alone exposes nothing before death; the passphrase travels a
// different path (memorized, or split across two locations; see README).
//
// DOM-free: builders return HTML strings; test/paper.mjs round-trips the
// QR payloads without a browser.

import { encodeQR } from '@paulmillr/qr'

const esc = (s) => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export const qrSvg = (text) => encodeQR(text, 'svg', { ecc: 'medium', scale: 4 })

const today = () => new Date().toISOString().slice(0, 10)

const sheet = (title, inner) => `
  <div class="sheet">
    <h1>${esc(title)}</h1>
    ${inner}
    <div class="bearer">⚠ This paper is a bearer instrument. Anyone holding it
      (and its passphrase, where one applies) holds what it protects. Store it
      like the original will: a safe deposit box or a home safe — never a
      drawer, never a photo, never email.</div>
    <div class="foot">Printed ${today()} · Nherit — family legacy vault on nostr ·
      This sheet is self-contained: no company, no account, no server login is
      needed to use it.</div>
  </div>`

const qrBlock = (label, text) => `
  <div class="qrrow">
    <div class="qr">${qrSvg(text)}</div>
    <div class="qrside">
      <div class="lbl">${esc(label)}</div>
      <div class="k">${esc(text)}</div>
    </div>
  </div>`

/**
 * Owner recovery sheet: the single piece of paper the whole estate
 * reconstitutes from. Carries the passphrase-locked key (ncryptsec), the
 * relay list, and instructions for a stranger.
 */
export function ownerSheet({ ncryptsec, npub, relays, passphraseHint = '' }) {
  return sheet('Estate vault — owner recovery sheet', `
    <p><b>What this is.</b> The person who printed this maintained their estate
      record — medical directives, instructions for a spouse and executor,
      letters — encrypted on the nostr network, readable only with keys they
      controlled. This sheet recovers the <i>owner’s</i> master key.</p>
    <p><b>How to use it.</b> Open the Nherit app (or any NIP-DA client — the
      format is an open protocol, and the app is open source and can be run
      from a copy). Choose “Recover from paper”, scan or type the locked key
      below, and enter the passphrase. Everything reappears: every scope of
      the record, every person it was shared with.</p>
    ${qrBlock('Locked master key (ncryptsec — useless without the passphrase)', ncryptsec)}
    <div class="lbl">Public key (safe to share; identifies the vault)</div>
    <div class="k">${esc(npub)}</div>
    <div class="lbl">Relays holding the encrypted record</div>
    <div class="k">${relays.map(esc).join('<br>')}</div>
    <p><b>The passphrase is not on this sheet — deliberately.</b> A found or
      stolen sheet must be worthless on its own.
      ${passphraseHint ? `Passphrase hint: <i>${esc(passphraseHint)}</i>` : ''}</p>`)
}

/**
 * Beneficiary sheet (executor, spouse, child): THEIR key, locked, plus claim
 * instructions. Their key is where grants — immediate or released — arrive.
 */
export function beneficiarySheet({ name, relation, ncryptsec, npub, ownerNpub, relays }) {
  return sheet(`Estate access — recovery sheet for ${name}`, `
    <p><b>What this is.</b> ${esc(name)}${relation ? ` (${esc(relation)})` : ''} was
      named in an estate vault. Access arrives as encrypted grants readable
      only by the key on this sheet — some may already be readable, some are
      released by the vault’s break-glass arrangements.</p>
    <p><b>How to use it.</b> Open the Nherit app (or any NIP-DA client), choose
      “Recover from paper”, scan or type the locked key below, and enter your
      passphrase. Anything shared with you — now or since this was printed —
      appears. If nothing appears yet, keep this sheet: grants released later
      arrive at this same key.</p>
    ${qrBlock('Your locked key (ncryptsec — useless without your passphrase)', ncryptsec)}
    <div class="lbl">Your public key</div>
    <div class="k">${esc(npub)}</div>
    <div class="lbl">The vault owner’s public key</div>
    <div class="k">${esc(ownerNpub)}</div>
    <div class="lbl">Relays to look on</div>
    <div class="k">${relays.map(esc).join('<br>')}</div>`)
}

/**
 * Shamir share card (tier 3): one per shareholder. `threshold` cards
 * together open exactly one scope — never the whole estate.
 */
export function shamirCard({ holderName, scopeName, ownerNpub, mnemonic, threshold, count, index, relays }) {
  return sheet(`Estate share card ${index + 1} of ${count} — for ${holderName}`, `
    <p><b>What this is.</b> One share of a ${threshold}-of-${count} split
      protecting “${esc(scopeName)}” in an estate vault. This card alone
      reveals <i>nothing</i> — any ${threshold} of the ${count} cards,
      brought together in the Nherit app’s “Combine shares” ceremony, unlock
      that one section and no more.</p>
    <p><b>When the time comes.</b> Contact the other shareholders, open the
      Nherit app (or any NIP-DA client) on one device, and enter ${threshold}
      cards’ word lists. No company, no account, no service is involved.</p>
    ${qrBlock('Share words (SLIP-39)', mnemonic)}
    <div class="lbl">Vault owner’s public key</div>
    <div class="k">${esc(ownerNpub)}</div>
    <div class="lbl">Relays holding the encrypted record</div>
    <div class="k">${relays.map(esc).join('<br>')}</div>`)
}

/** Print CSS for the sheets — injected into the page's print-only styles. */
export const PRINT_CSS = `
  #printcard .sheet { page-break-after: always; color: #000;
    font: 14px/1.6 Georgia, 'Times New Roman', serif; max-width: 640px;
    margin: 0 auto; padding: 40px 20px; }
  #printcard h1 { font-size: 21px; border-bottom: 2px solid #000; padding-bottom: 8px; }
  #printcard .k { font-family: ui-monospace, Menlo, monospace; font-size: 12.5px;
    word-break: break-all; border: 1.5px solid #000; padding: 10px 12px; margin: 4px 0 14px; }
  #printcard .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
  #printcard .qrrow { display: flex; gap: 18px; align-items: flex-start; margin: 14px 0; }
  #printcard .qr { flex: 0 0 180px; }
  #printcard .qr svg { width: 180px; height: 180px; }
  #printcard .qrside { flex: 1; min-width: 0; }
  #printcard .bearer { border: 2px solid #000; padding: 10px 12px; font-size: 12.5px;
    margin-top: 18px; font-weight: 600; }
  #printcard .foot { font-size: 11.5px; color: #333; margin-top: 16px; }`
