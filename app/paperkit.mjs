// paperkit.mjs — printing the paper kit (spec §6.4). All sheet CONTENT comes
// from shared/paper.mjs (DOM-free, tested); this module owns the print-only
// div, the print CSS injection, and the "when is printing possible" rules:
// the owner sheet ships the ncryptsec, never the raw nsec, so a
// passphrase-protected key is a precondition, not a suggestion.

import { getPublicKey, nip19 } from 'nostr-tools'
import * as nip49 from 'nostr-tools/nip49'
import { ownerSheet, beneficiarySheet, shamirCard, PRINT_CSS } from '../shared/paper.mjs'
import { $, state, RELAYS, storedNcryptsec } from './main.mjs'

// print CSS rides in once, inside the @media print scope
const style = document.createElement('style')
style.textContent = `@media print { ${PRINT_CSS} }`
document.head.appendChild(style)

const KIT_KEY = 'nherit-kit-printed'
export const printedKit = () => !!localStorage.getItem(KIT_KEY)

function printHtml(html) {
  $('printcard').innerHTML = html
  window.print()
  $('printcard').innerHTML = ''      // keys do not linger in the DOM
}

/** Simple nsec card at key birth (before any passphrase exists). */
export function printKeyCard(sk) {
  const nsec = nip19.nsecEncode(sk)
  const npub = nip19.npubEncode(getPublicKey(sk))
  printHtml(`
    <div class="sheet">
      <h1>Nherit vault key</h1>
      <p>This key is the whole vault — there is no reset and no server copy.
         Sign in with the secret key on any device and everything reconstitutes.
         Once you've protected the key with a passphrase in the app, print the
         proper owner sheet (locked key) and destroy this card.</p>
      <div class="lbl">Secret key — keep on paper, never in email or chat</div>
      <div class="k">${nsec}</div>
      <div class="lbl">Public key — safe to give out</div>
      <div class="k">${npub}</div>
      <div class="bearer">⚠ This card is a bearer instrument: anyone holding it
        holds the vault. The owner sheet (printed after passphrase protection)
        is the safer long-term artifact.</div>
      <div class="foot">Printed ${new Date().toISOString().slice(0, 10)} · Nherit</div>
    </div>`)
}

/** The flagship artifact: passphrase-locked owner key + relays + instructions. */
export function printOwnerSheet(msgEl) {
  const msg = (t) => { if (msgEl) msgEl.textContent = t }
  let nc = storedNcryptsec()
  if (!nc) {
    // No protected key on this device. For a local key we can mint the
    // ncryptsec right here; a NIP-07 key never leaves the extension.
    const hex = sessionStorage.getItem('nherit-login')
    if (!hex || hex === 'nip07') {
      msg('your key lives in the NIP-07 extension — export/back up there, or sign in by nsec to print a sheet')
      return
    }
    const pass = prompt('The owner sheet carries your key LOCKED with a passphrase (a found sheet alone must be worthless).\n\nChoose the passphrase (8+ chars). Memorize it or store it separately from the paper:')
    if (!pass || pass.length < 8) { msg('passphrase of 8+ characters required'); return }
    nc = nip49.encrypt(Uint8Array.from(hex.match(/../g), h => parseInt(h, 16)), pass)
    localStorage.setItem('nherit-ncryptsec', nc)   // protecting and printing are the same fact
    sessionStorage.removeItem('nherit-login')
  }
  const hint = prompt('Optional passphrase HINT to print on the sheet (make it useless to a stranger; leave empty for none):') ?? ''
  printHtml(ownerSheet({
    ncryptsec: nc, npub: nip19.npubEncode(state.me), relays: RELAYS, passphraseHint: hint,
  }))
  localStorage.setItem(KIT_KEY, new Date().toISOString().slice(0, 10))
  msg('printed — store it like the original will. Setup checklist complete.')
}

/** Printed when the owner mints a key FOR a beneficiary (people.mjs). */
export function printBeneficiarySheet({ name, relation, ncryptsec, pub }) {
  printHtml(beneficiarySheet({
    name, relation, ncryptsec,
    npub: nip19.npubEncode(pub),
    ownerNpub: nip19.npubEncode(state.me),
    relays: RELAYS,
  }))
}

/** All N share cards in one print job — one page per shareholder. */
export function printShamirCards({ scope, holders, mnemonics, threshold, count }) {
  printHtml(holders.map((h, i) => shamirCard({
    holderName: h.name, scopeName: scope.payload?.name ?? scope.scopeName,
    ownerNpub: nip19.npubEncode(state.me),
    mnemonic: mnemonics[i], threshold, count, index: i, relays: RELAYS,
  })).join(''))
}
