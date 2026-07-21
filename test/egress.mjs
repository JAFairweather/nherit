// egress.mjs — the zero-egress guarantee, enforced at the strongest level
// that is feasible without a headless browser:
//
//   1. STATIC SCAN: every absolute URL in shipped code (app/, shared/, lib/,
//      escrow/, the root redirect page) must resolve to an allowed origin.
//      Network origins are exactly the configured relays, the default
//      Blossom hosts, and esm.sh (pinned module CDN). github.com is allowed
//      ONLY as an <a href> in HTML (user-initiated navigation, not egress);
//      w3.org is allowed ONLY as an XML namespace identifier (never
//      fetched); localhost/URL-parse bases are allowed ONLY in the dev
//      server. The escrow daemon's operator-configured outreach webhook is
//      server-side self-hosted policy, read from env — no URL ships.
//   2. CONSISTENCY: the allowlist is cross-checked against the live
//      configuration module — DEFAULT_SERVERS, DEFAULT_RELAYS, and
//      defaultConfig() (all imported from shipped code) must be subsets of
//      it, so the list can't drift. Endpoints the USER configures in
//      Settings (localStorage) are that user's own policy, not shipped
//      egress — the sanitize path is asserted here so garbage config can
//      never widen the default surface silently.
//   3. IMPORT-TIME INTERCEPTION: fetch / WebSocket / XMLHttpRequest are
//      replaced with recording traps, then every DOM-free module is
//      imported; zero network calls may occur at module load. Nothing
//      phones home just by being loaded.
//
// What this does NOT cover (documented, not hidden): runtime calls in a real
// browser (nostr-tools opens sockets only to the relay URLs we pass it — the
// static scan pins those; browser behavior is additionally verified against
// the preview server's network log during development), and a tampered CDN
// serving different code than audited (see SECURITY.md, "code delivery").
//
//   node test/egress.mjs

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0, failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? passed++ : failed++
}

// The one and only egress allowlist.
const NETWORK = new Set([
  'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net',  // relays
  'https://nostr.download', 'https://cdn.hzrd149.com',                // Blossom
  'https://esm.sh',                                                   // pinned modules
])
const LINK_ONLY = new Set(['https://github.com'])       // <a href> in HTML only
const NAMESPACE = new Set(['http://www.w3.org'])        // svg xmlns, never fetched
const DEV_ONLY = new Set(['http://localhost:4445', 'http://x', 'http://127.0.0.1'])
// RFC 6761/2606 reserved names (".example", ".invalid") are placeholder copy
// in UI hints and tests — guaranteed unresolvable, so they cannot be egress.
const RESERVED = (host) => host === 'example.com' || host.endsWith('.example') || host.endsWith('.invalid')

console.log('\n1. Static scan: every URL in shipped code resolves to an allowed origin')
const files = [
  join(root, 'index.html'),
  ...readdirSync(join(root, 'app')).filter(f => /\.(mjs|html)$/.test(f)).map(f => join(root, 'app', f)),
  ...readdirSync(join(root, 'shared')).filter(f => f.endsWith('.mjs')).map(f => join(root, 'shared', f)),
  ...readdirSync(join(root, 'lib')).filter(f => f.endsWith('.mjs')).map(f => join(root, 'lib', f)),
  ...readdirSync(join(root, 'lib', 'vendor')).map(f => join(root, 'lib', 'vendor', f)),
  ...readdirSync(join(root, 'escrow', 'src')).map(f => join(root, 'escrow', 'src', f)),
  join(root, 'escrow', 'bin', 'nherit-escrow.mjs'),
]
const urlRx = /\b(?:https?|wss?):\/\/[^\s"'`<>\\)\]{},]*/g
const offenders = []
let scanned = 0, found = 0
for (const file of files) {
  const src = readFileSync(file, 'utf8')
  scanned++
  for (const raw of src.match(urlRx) ?? []) {
    let origin, host
    try { ({ origin, host } = new URL(raw)) } catch { origin = raw; host = '' }
    if (!host) continue                       // bare "wss://" in prose, not a destination
    found++
    const rel = file.slice(root.length + 1)
    if (NETWORK.has(origin)) continue
    if (RESERVED(host)) continue
    if (LINK_ONLY.has(origin) && rel.endsWith('.html')
        && new RegExp(`href="${origin}[^"]*"`).test(src)) continue
    if (NAMESPACE.has(origin) && (src.includes(`xmlns='${origin}`) || src.includes(`xmlns:svg="${origin}`) || src.includes(`xmlns="${origin}`))) continue
    if ([...DEV_ONLY].some(d => origin.startsWith(d)) && rel === 'app/serve.mjs') continue
    if (origin.startsWith('http://127.0.0.1') && rel.startsWith('test/')) continue
    if (raw.startsWith('https://github.com') && rel.endsWith('.mjs')
        && new RegExp(`// .*${raw.replace(/[/.]/g, '\\$&')}`).test(src)) continue  // provenance comments
    offenders.push(`${rel}: ${raw}`)
  }
}
check(`no unexpected origins in ${scanned} files (${found} URLs found)`,
  offenders.length === 0, offenders.join(' | '))
check('the scan itself sees the expected surface', found >= 10,
  'regex or file list broke if this number collapses')

console.log('\n2. Consistency: the allowlist matches the live configuration')
const cfgSrc = readFileSync(join(root, 'shared', 'config.mjs'), 'utf8')
const relays = cfgSrc.match(/wss:\/\/[a-z0-9.-]+/g) ?? []
check('every default relay is allowlisted', relays.length >= 3
  && relays.every(r => NETWORK.has(r)), relays.join(', '))
const htmlSrc = readFileSync(join(root, 'app', 'index.html'), 'utf8')
const importMap = htmlSrc.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1] ?? ''
const imports = Object.values(JSON.parse(importMap).imports).map(u => new URL(u).origin)
check('import map points only at esm.sh', imports.length >= 3
  && imports.every(o => o === 'https://esm.sh'), [...new Set(imports)].join(', '))

console.log('\n3. Import-time interception: nothing phones home on module load')
const calls = []
globalThis.fetch = (u) => { calls.push(String(u)); return Promise.reject(new Error('egress blocked')) }
globalThis.XMLHttpRequest = class { open(m, u) { calls.push(String(u)) } send() { throw new Error('egress blocked') } setRequestHeader() {} }
globalThis.WebSocket = class { constructor(u) { calls.push(String(u)); throw new Error('egress blocked') } }
const modules = ['../shared/pad.mjs', '../shared/blossom.mjs', '../shared/manifest.mjs',
  '../shared/estate.mjs', '../shared/wrap.mjs', '../shared/notices.mjs', '../shared/invite.mjs',
  '../shared/escrowpkg.mjs', '../shared/shamir.mjs', '../shared/paper.mjs', '../shared/config.mjs',
  '../lib/nipxx.mjs', '../lib/liverelay.mjs', '../lib/relay.mjs', '../lib/nave-connect.mjs',
  '../lib/vendor/slip39.mjs',
  '../escrow/src/store.mjs', '../escrow/src/watch.mjs', '../escrow/src/checkin.mjs']
let importErr = null
let blossom, config
try {
  for (const m of modules) {
    const mod = await import(m)
    if (m.includes('blossom')) blossom = mod
    if (m.includes('config')) config = mod
  }
} catch (err) { importErr = err }
check('all shipped modules import cleanly under the traps', importErr === null, importErr?.message ?? '')
check('zero network calls at import time', calls.length === 0, calls.join(', '))
check('DEFAULT_SERVERS are allowlisted',
  blossom.DEFAULT_SERVERS.length >= 2 && blossom.DEFAULT_SERVERS.every(s => NETWORK.has(new URL(s).origin)),
  blossom.DEFAULT_SERVERS.join(', '))

console.log('\n4. Live config: shipped defaults stay inside the allowlist; garbage cannot widen them')
const dflt = config.defaultConfig()
check('defaultConfig relays ⊆ allowlist', dflt.relays.length >= 3
  && dflt.relays.every(r => NETWORK.has(r)), dflt.relays.join(', '))
check('defaultConfig servers ⊆ allowlist', dflt.servers.length >= 2
  && dflt.servers.every(s => NETWORK.has(new URL(s.url).origin)), dflt.servers.map(s => s.url).join(', '))
check('loadConfig without storage = defaults', JSON.stringify(config.loadConfig()) === JSON.stringify(dflt))
const bad = { getItem: () => JSON.stringify({ relays: ['javascript:alert(1)', 'http://evil.example'], servers: [{ url: 'ftp://evil.example' }, 'not a url'], escrowPub: 'not-a-key', policy: { quiet_days: -4 } }) }
check('invalid schemes/keys/policies sanitize back to defaults',
  JSON.stringify(config.loadConfig(bad)) === JSON.stringify(dflt))
const store = new Map()
const stub = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) }
config.saveConfig({ relays: ['wss://my.relay.example/'], servers: [{ url: 'https://my.blossom.example/', requiresAuth: true }], policy: { quiet_days: 14, grace_days: 30, veto_days: 3 } }, stub)
const mine = config.loadConfig(stub)
check('user config round-trips (trailing slash stripped, flags and policy kept)',
  mine.relays[0] === 'wss://my.relay.example' && mine.servers[0].url === 'https://my.blossom.example'
  && mine.servers[0].requiresAuth === true && mine.policy.quiet_days === 14)
check('resetConfig restores defaults', (config.resetConfig(stub),
  JSON.stringify(config.loadConfig(stub)) === JSON.stringify(dflt)))

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`)
process.exit(failed === 0 ? 0 : 1)
