// main.mjs — Nherit shell: sign-in via nave-connect (NIP-07 extension or
// NIP-46 bunker as the front door; the local vault key with its NIP-49
// protect offer stays as a gated advanced path, the paper sheet as the
// recovery path), tabs, shared state. Pure client of NIP-DA — the vault is
// the key.
//
// Boot order: an invite link beats everything (the opener flow runs
// logged-out, bearer key in memory only); then any tab-session sign-in
// (nave-connect parses all three kinds — a bare-hex legacy remember still
// reads as `local`; nip46 remembers carry the bunker URI + client key, so a
// reload re-pairs the SAME bunker session without re-approval); then a
// protected key (ncryptsec present → passphrase prompt).

import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import * as nip49 from 'nostr-tools/nip49'
import { decodeQR } from '@paulmillr/qr/decode.js'
import { LiveRelay } from '../lib/liverelay.mjs'
import {
  localSigner, receiveGrants, latestGrants, fetchScope,
  loadGrantIndex, saveGrantIndex, fromIssuedEntry,
} from '../lib/nipxx.mjs'
import { nip07Signer, nip46Signer, serializeSession, parseSession, signerFromSession } from '../lib/nave-connect.mjs'
import { parseInviteFragment, pollClaims } from '../shared/invite.mjs'
import { receiveNotices } from '../shared/notices.mjs'
import { receiveAcks } from '../shared/escrowpkg.mjs'
import { receiveShares } from '../shared/shamir.mjs'
import { loadConfig } from '../shared/config.mjs'
import { renderVault } from './vault.mjs'
import { renderPeople } from './people.mjs'
import { renderBreakglass } from './breakglass.mjs'
import { renderReceived } from './claim.mjs'
import { openInvite } from './claim.mjs'
import { renderSettings } from './settings.mjs'
import { printKeyCard } from './paperkit.mjs'

// Bearer-link hygiene: capture the fragment and scrub the URL bar before
// anything else can observe location.
const inviteLink = parseInviteFragment(location.hash)
if (inviteLink) history.replaceState(null, '', location.pathname + location.search)

export const config = loadConfig()
export const RELAYS = config.relays
export const SERVERS = config.servers.map(s => s.url)

export const $ = (id) => document.getElementById(id)
export const esc = (s) => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
export const short = (pk) => { const n = nip19.npubEncode(pk); return n.slice(0, 12) + '…' + n.slice(-4) }
export const fmtSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`
export const hexOf = (b) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')

export const state = {
  relay: null, signer: null, me: null,
  myIndex: { issued: [], received: [] },
  myScopes: [],          // { scopeId, scopeName, generation, scopeKey, grantees, payload, draft?, lost? }
  people: [],            // registry: { pub, name, relation, managed?, notified? }
  invites: [],           // bearer ledger: { pub, scope, name?, created_at, claimed_by? }
  escrow: null,          // { escrowPub, policy, challengeContacts, scopes: {scopeId: [pub]}, depositedAt }
  shamir: {},            // { scopeId: { threshold, count, holders: [{pub?, name}], v } }
  incoming: [],          // beneficiary side: { ...grantRecord, status, data? }
  notices: { revocations: [], named: [] },
  myShares: [],          // shamir shares held BY me
  escrowAcks: [],        // acks + release warnings from escrow operators
  pendingClaims: [],
  profiles: new Map(),
}

function parseKey(input) {
  const s = input.trim()
  if (/^[0-9a-f]{64}$/i.test(s)) return Uint8Array.from(s.match(/../g), h => parseInt(h, 16))
  const { type, data } = nip19.decode(s)
  if (type !== 'nsec') throw new Error('not an nsec')
  return data
}

const TABS = ['vault', 'people', 'breakglass', 'received', 'settings']
function showTab(t) {
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === t)
  for (const id of TABS) $(id).style.display = t === id ? '' : 'none'
  if (t === 'settings') renderSettings()
  location.hash = t
}
for (const b of document.querySelectorAll('.tab')) b.onclick = () => showTab(b.dataset.tab)

export async function login(signer, remember) {
  state.signer = signer
  try { state.me = await signer.getPublicKey() }   // nip46: first use → lazy bunker connect
  catch (err) {
    state.signer = null
    try { await signer.close?.() } catch { /* best effort */ }
    $('err').textContent = `sign-in failed: ${err.message}`
    return
  }
  if (remember) sessionStorage.setItem('nherit-login', remember)
  state.relay ??= new LiveRelay(RELAYS)
  for (const id of ['login', 'unlock', 'recover', 'invite']) $(id).style.display = 'none'
  $('me').style.display = 'flex'
  $('tabs').style.display = 'flex'
  showTab(TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'vault')
  const npub = nip19.npubEncode(state.me)
  $('my-npub').textContent = npub.slice(0, 12) + '…' + npub.slice(-4)
  $('my-npub').onclick = () => navigator.clipboard.writeText(npub)
  $('me-kind').textContent =
    { nip07: 'extension', nip46: 'bunker', local: 'local key' }[signer.kind] ?? 'local key'
  if (remember && parseSession(remember)?.kind === 'local') offerProtect(remember)
  load()
}

// --- NIP-49: passphrase-protected key at rest ---------------------------------
// The ncryptsec in localStorage is the ONLY persisted secret; it is also the
// exact string the paper kit prints, so protecting the key and printing the
// sheet are the same fact in two media.

const NC_KEY = 'nherit-ncryptsec'
export const storedNcryptsec = () => localStorage.getItem(NC_KEY)

function offerProtect(hex) {
  if (localStorage.getItem(NC_KEY) || sessionStorage.getItem('nherit-no-protect')) return
  $('protect').style.display = 'flex'
  $('protect-go').onclick = async () => {
    const pass = $('protect-pass').value
    if (pass.length < 8) { $('protect-msg').textContent = 'use at least 8 characters'; return }
    $('protect-msg').textContent = 'encrypting key (scrypt — a second or two)…'
    await new Promise(r => setTimeout(r, 30))
    const sk = Uint8Array.from(hex.match(/../g), h => parseInt(h, 16))
    localStorage.setItem(NC_KEY, nip49.encrypt(sk, pass))
    sessionStorage.removeItem('nherit-login')
    $('protect-pass').value = ''
    $('protect').style.display = 'none'
    $('status').textContent = 'Key protected. Next visit asks for the passphrase; the nsec still works anywhere. You can now print the owner sheet from Break-glass.'
    renderVault()
  }
  $('protect-pass').onkeydown = (e) => { if (e.key === 'Enter') $('protect-go').onclick() }
  $('protect-skip').onclick = () => {
    sessionStorage.setItem('nherit-no-protect', '1')
    $('protect').style.display = 'none'
  }
}

function showUnlock(ncryptsec) {
  $('login').style.display = 'none'
  $('unlock').style.display = ''
  $('unlock-pass').focus()
  $('unlock-go').onclick = async () => {
    $('unlock-err').textContent = 'decrypting (scrypt — a second or two)…'
    await new Promise(r => setTimeout(r, 30))
    try {
      const sk = nip49.decrypt(ncryptsec, $('unlock-pass').value)
      $('unlock-pass').value = ''
      login(keySigner(sk), null)                             // nothing new persisted
    } catch { $('unlock-err').textContent = 'wrong passphrase' }
  }
  $('unlock-pass').onkeydown = (e) => { if (e.key === 'Enter') $('unlock-go').onclick() }
  $('unlock-forget').onclick = () => {
    if (!confirm('Forget the protected key stored on this device?\n\nThis deletes the only local copy — make sure a paper sheet or the nsec exists; it is the only way back into the vault.')) return
    localStorage.removeItem(NC_KEY)
    $('unlock').style.display = 'none'
    $('login').style.display = ''
  }
}

// --- recover from paper ---------------------------------------------------------

let scanStream = null
function stopScan() {
  scanStream?.getTracks().forEach(t => t.stop())
  scanStream = null
  $('scanner').style.display = 'none'
}

async function scanLoop() {
  const video = $('scanner')
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
  } catch { $('rec-err').textContent = 'camera unavailable — type the key from the sheet instead'; return }
  video.srcObject = scanStream
  video.style.display = ''
  await video.play()
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const tick = () => {
    if (!scanStream) return
    if (video.videoWidth) {
      canvas.width = video.videoWidth; canvas.height = video.videoHeight
      ctx.drawImage(video, 0, 0)
      try {
        const text = decodeQR(ctx.getImageData(0, 0, canvas.width, canvas.height))
        if (text.startsWith('ncryptsec1')) {
          $('rec-ncryptsec').value = text
          $('rec-err').textContent = 'scanned ✓ — now the passphrase'
          stopScan()
          $('rec-pass').focus()
          return
        }
      } catch { /* no code in frame yet */ }
    }
    requestAnimationFrame(tick)
  }
  tick()
}

$('show-recover').onclick = () => { $('login').style.display = 'none'; $('recover').style.display = '' }
$('rec-back').onclick = () => { stopScan(); $('recover').style.display = 'none'; $('login').style.display = '' }
$('rec-scan').onclick = scanLoop
$('rec-go').onclick = async () => {
  const nc = $('rec-ncryptsec').value.trim()
  if (!nc.startsWith('ncryptsec1')) { $('rec-err').textContent = 'expected ncryptsec1… from a recovery sheet'; return }
  $('rec-err').textContent = 'decrypting (scrypt — a second or two)…'
  await new Promise(r => setTimeout(r, 30))
  try {
    const sk = nip49.decrypt(nc, $('rec-pass').value)
    stopScan()
    // The sheet's ncryptsec becomes this device's protected key — recovery
    // and device-setup are the same act.
    localStorage.setItem(NC_KEY, nc)
    $('rec-pass').value = ''; $('rec-ncryptsec').value = ''
    login(keySigner(sk), null)
  } catch { $('rec-err').textContent = 'wrong passphrase (or damaged key)' }
}
$('rec-pass').onkeydown = (e) => { if (e.key === 'Enter') $('rec-go').onclick() }

// --- load: the whole world from the key ------------------------------------------

export async function load() {
  const { relay, signer, me } = state
  $('status').textContent = 'scanning relays for your record, grants, and notices…'
  try {
    const [index, grants, notices, myShares, escrowAcks] = await Promise.all([
      loadGrantIndex(relay, signer),
      receiveGrants(relay, signer),
      receiveNotices(relay, signer),
      receiveShares(relay, signer),
      receiveAcks(relay, signer),
    ])
    state.myIndex = index
    state.people = index.nherit_people ?? []
    state.invites = index.nherit_invites ?? []
    state.escrow = index.nherit_escrow ?? null
    state.shamir = index.nherit_shamir ?? {}
    state.notices = notices
    state.myShares = myShares
    state.escrowAcks = escrowAcks
    const drafts = state.myScopes.filter(s => s.draft)
    const [mine, incoming, pendingClaims] = await Promise.all([
      Promise.all(index.issued.map(async e => {
        const s = { ...fromIssuedEntry(e), publisher: me }
        const res = await fetchScope(relay, s)
        return { ...s, payload: res.status === 'ok' ? res.data : null, lost: res.status !== 'ok' }
      })),
      Promise.all(latestGrants(grants).map(async g => ({ ...g, ...await fetchScope(relay, g) }))),
      pollClaims(relay, signer, index.nherit_invites),
    ])
    state.myScopes = [...mine, ...drafts]
    state.incoming = incoming.filter(g => g.publisher !== me)
    state.pendingClaims = pendingClaims
    // profiles for anyone we reference
    const pubs = [...new Set([
      ...state.people.map(p => p.pub),
      ...state.incoming.map(g => g.publisher),
      ...state.notices.named.map(n => n.owner),
      ...state.myShares.map(s => s.owner),
    ])].filter(p => p && p !== me)
    state.profiles = new Map()
    if (pubs.length)
      for (const ev of await relay.query({ kinds: [0], authors: pubs, limit: pubs.length * 3 }))
        if (!state.profiles.has(ev.pubkey)) {
          try { state.profiles.set(ev.pubkey, JSON.parse(ev.content)) } catch { /* skip */ }
        }
    const nRecv = state.incoming.filter(i => i.status === 'ok').length
      + state.notices.named.length + state.myShares.length
    $('recv-bub').innerHTML = nRecv ? ` <span class="bub">${nRecv}</span>` : ''
    $('status').textContent =
      `${state.myScopes.length} scope${state.myScopes.length === 1 ? '' : 's'} in your record · ` +
      `${state.people.length} ${state.people.length === 1 ? 'person' : 'people'} · ` +
      (pendingClaims.length ? `${pendingClaims.length} invite claim${pendingClaims.length === 1 ? '' : 's'} awaiting approval · ` : '') +
      `everything is dereferenced live — nothing here is a stored copy.`
    renderVault()
    renderPeople()
    renderBreakglass()
    renderReceived()
  } catch (err) { $('status').textContent = `relay error: ${err.message}` }
}

export const personName = (pk) =>
  state.people.find(p => p.pub === pk)?.name
  || state.profiles.get(pk)?.display_name || state.profiles.get(pk)?.name || short(pk)

/** Persist the index, preserving every app-level field in one place. */
export async function syncIndex() {
  const { toIssuedEntry } = await import('../lib/nipxx.mjs')
  state.myIndex = {
    ...state.myIndex,
    issued: state.myScopes.filter(s => !s.draft).map(s => toIssuedEntry(s, s.grantees)),
    nherit_people: state.people,
    nherit_invites: state.invites,
    nherit_escrow: state.escrow,
    nherit_shamir: state.shamir,
  }
  await saveGrantIndex(state.relay, state.signer, state.myIndex)
}

// --- header actions ---------------------------------------------------------------

$('checkin').onclick = async () => {
  // A check-in is just a signed event: the daemon counts ANY owner activity.
  await syncIndex()
  $('status').textContent = 'Checked in — the dead-man\'s switch clock starts over from now.'
}
$('refresh').onclick = () => load()
$('logout').onclick = () => {
  try { state.signer?.close?.() } catch { /* best effort */ }   // drop a live bunker pairing
  sessionStorage.removeItem('nherit-login'); location.hash = ''; location.reload()
}

// nave-connect supplies nip07 + nip46; local keys stay on nipxx's localSigner.
// (The module's own localSigner has no nip44, and everything here — the Grant
// Index, grants, notices, shares — rides NIP-44; signerFromSession returning
// null for `local` is the module telling the app to rebuild from its own key
// material. The ncryptsec at rest is also the exact string the paper kit
// prints, so the NIP-49 layer stays bespoke and untouched.)
export function keySigner(sk) { return { kind: 'local', ...localSigner(sk) } }

// NIP-46: the bunker may want a one-time interactive approval — surface its
// auth_url as a link rather than window.open (popup blockers eat those).
function onAuthUrl(url) {
  $('bunker-auth').style.display = ''
  $('bunker-auth').innerHTML = `The bunker asks for a one-time approval:
    <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">open its dashboard</a>,
    approve, then return here.`
}

$('bunker-go').onclick = async () => {
  const uri = $('bunker-uri').value.trim()
  if (!uri) { $('err').textContent = 'Paste the bunker:// URI from your remote signer first.'; return }
  $('err').textContent = 'connecting to the bunker over its relays… (approve there if asked)'
  $('bunker-go').disabled = true
  try {
    const signer = nip46Signer(uri, { onAuthUrl })
    await login(signer, serializeSession('nip46', { uri, clientSecretHex: signer.clientSecretHex }))
    if (state.me) { $('err').textContent = ''; $('bunker-auth').style.display = 'none' }
  } finally { $('bunker-go').disabled = false }
}
$('bunker-uri').onkeydown = (e) => { if (e.key === 'Enter') $('bunker-go').onclick() }

// The local key is deliberately not a headline option (Director, nact#16):
// it stays available, behind this explicit reveal.
$('advanced-toggle').onclick = () => {
  const open = $('advanced').style.display === 'none'
  $('advanced').style.display = open ? '' : 'none'
  $('advanced-toggle').textContent = open
    ? 'Hide the local-key option'
    : 'Advanced: use a local key in this tab (new vault / raw nsec)'
  if (open) $('nsec').focus()
}

$('go').onclick = () => {
  try { const k = parseKey($('nsec').value); login(keySigner(k), hexOf(k)) }
  catch { $('err').textContent = 'Expected nsec1… or 64 hex chars.' }
}
$('nsec').onkeydown = (e) => { if (e.key === 'Enter') $('go').onclick() }
$('gen').onclick = () => {
  const k = generateSecretKey()
  $('err').textContent = ''
  $('newkey').style.display = ''
  $('newkey-nsec').textContent = nip19.nsecEncode(k)
  $('newkey-copy').onclick = async () => {
    await navigator.clipboard.writeText(nip19.nsecEncode(k))
    $('newkey-copy').textContent = 'Copied ✓'
    setTimeout(() => { $('newkey-copy').textContent = 'Copy' }, 2000)
  }
  $('newkey-print').onclick = () => printKeyCard(k)
  $('newkey-continue').onclick = () => login(keySigner(k), hexOf(k))
}
$('nip07').onclick = () => {
  if (!window.nostr?.nip44) { $('err').textContent = 'No NIP-07 extension found (needs nip44 support — Alby or nos2x).'; return }
  login(nip07Signer(), 'nip07')
}

// --- boot -------------------------------------------------------------------------

const saved = sessionStorage.getItem('nherit-login')
const sess = parseSession(saved)
if (inviteLink) openInvite(inviteLink)
else if (sess?.kind === 'nip07') setTimeout(() => { if (window.nostr?.nip44) login(nip07Signer(), 'nip07') }, 250)
else if (sess?.kind === 'nip46') login(signerFromSession(sess, { onAuthUrl }), saved)
else if (sess?.kind === 'local') login(keySigner(parseKey(sess.hexKey)), saved)
else if (localStorage.getItem(NC_KEY)) showUnlock(localStorage.getItem(NC_KEY))
