# HANDOFF — resuming work on Nherit

Point a fresh Claude Code session at this file to continue where the last
one left off. It is the committed, public-safe half of the handoff; deeper
owner context lives in gitignored local files (see §7).

## 1. What this project is

Nherit: family break-glass digital legacy vault on nostr. One encrypted,
self-maintained estate record; per-beneficiary scopes; revocable grants;
recovery from a single key printed on paper. Pure client of **NIP-DA
Scoped Data Grants** (draft, nostr-protocol/nips#2411; kinds
30440/440/441/10440 are placeholders — a kind-number change upstream will
touch `lib/nipxx.mjs` constants and nothing else).

**The protocol is frozen.** If a feature seems to need a protocol change,
stop and flag it to the owner instead of changing `lib/`.

- Repo: https://github.com/JAFairweather/nherit (public, MIT)
- Hosted app: https://jafairweather.github.io/nherit/ (GitHub Pages,
  main branch → gh-pages mirror; `.nojekyll`)
- Reference protocol repo: github.com/JAFairweather/nostr-scoped-data-grants
  — `SPEC.md` there is the source of truth; `lib/` here is vendored from it
  (`npm run sync-lib` when it's checked out as a sibling directory).
- Sibling apps (same family, same conventions): Nontact (contacts, :4444),
  Nvelope (documents, :4441 — Nherit reuses its pad/blossom/manifest
  modules VERBATIM), Notegate (:4442), Nvoy (:4443). **Nherit runs on
  :4445** (`npm run web`).

## 2. Architecture in 60 seconds

- Each scope (Medical / Spouse / Executor / per-child / Operations /
  custom) is one kind-30440 addressable event, encrypted under its own
  random 32-byte scope key (NIP-44 v2 payload, key used directly — no
  ECDH). Payload shape: `{nherit:1, name, template, note,
  items:[{label,value}], docs:[Nvelope file entries], updated_at}`.
- Editing republishes under the same key → every grantee current.
  Revoking rotates the key, bumps `v`, re-grants survivors, optionally
  sends a gift-wrapped kind-441 notice.
- Documents ride Nvelope's manifest pattern unchanged: ≤48 KB inline
  base64 inside the ciphertext; larger files padded (2^n × 64 KiB
  classes) → XChaCha20-Poly1305 under a per-file key → mirrored to
  Blossom hosts as ciphertext; the file key lives inside the
  scope-encrypted payload.
- Everything person-to-person rides NIP-59 gift wraps (kind 1059):
  grants, claims, revocation/named notices, escrow deposits/acks/
  warnings/vetoes, Shamir share delivery. Relays see ephemeral pubkeys
  delivering opaque blobs; every test suite ends with an adversarial
  observer assertion.
- The Grant Index (kind 10440, NIP-44-to-self) makes the whole estate
  recoverable from the owner key alone. App-level fields on it:
  `nherit_people`, `nherit_invites`, `nherit_escrow`, `nherit_shamir`
  (holders + generation, never mnemonics). `syncIndex()` in app/main.mjs
  preserves unknown fields — keep it that way.

### Break-glass tiers (cryptography can't verify death; these ARE the answer)

1. **Immediate** — grant now; they don't look until needed.
2. **Dead-man's switch** — `escrow/` daemon holds sealed 440 wraps it
   provably cannot open (`buildSealedGrant` in shared/escrowpkg.mjs makes
   real grant wraps without publishing; release = publish verbatim, so any
   ordinary NIP-DA client reads them). Liveness = any owner-signed event.
   State machine (pure, clock-injectable): alive → quiet (30d, outreach
   hook) → staged (60d more, challenge contacts warned) → released (7d
   veto window passes). Veto or owner activity resets. Trust statement
   (verbatim in escrow/README.md, SECURITY.md, and the UI): *the escrow
   can't read anything; it can release early, late, or never.*
3. **Shamir 2-of-3** — scope key (never the owner key) split as SLIP-39
   mnemonics; client-side combine ceremony; printable cards.

### Rotation cascades (app/vault.mjs `afterRotation`)

Rotating a scope re-seals + re-deposits any escrowed grants automatically,
and marks Shamir splits STALE (v:-1) — cards cannot be rebuilt silently;
the Break-glass tab then demands a re-split. Preserve this invariant in
any change that rotates keys.

## 3. Repo map

| path | role |
|---|---|
| `app/` | web UI, vanilla ESM, no build step. main (shell/sign-in/NIP-49/recover-from-paper/camera QR), vault (record editor + rotation cascades), people (registry, 3 onboarding paths incl. mint-key-and-print), breakglass (tier setup, arm/disarm, splits), claim (beneficiary view, veto, ceremony, invite opener), paperkit (print flows), settings, docs (attach/download), serve (:4445) |
| `shared/` | DOM-free logic: estate (templates/payload/reviewDue), wrap (NIP-59 + monotonic now), notices (441 + named), invite (bearer links), escrowpkg (wire + state machine), shamir, paper (sheet HTML + QR), pad/blossom/manifest (Nvelope verbatim), config |
| `lib/` | vendored NIP-DA reference lib (do not edit; `npm run sync-lib`) |
| `lib/vendor/` | slip39-js v0.1.9 ported to ESM with @noble/hashes — esm.sh's node:crypto shim lacks `pbkdf2Sync`, so upstream can't run in browsers. Same file runs in Node + browser. Don't replace with the npm package. |
| `escrow/` | optional operator daemon: src/{store,watch,checkin}.mjs + bin/nherit-escrow.mjs (env-driven; see escrow/README.md) |
| `test/` | 8 suites, ~130 assertions — see §4 |
| `SECURITY.md` | threat model; the NOT-protected half is deliberate product copy — keep its candor |

## 4. Verification state (all green as of 2026-07-11)

```
npm run smoke:local   # 17 — estate lifecycle, in-memory
npm run smoke         # 14 — same against live relays (damus, nos.lol, primal)
npm run escrow:test   # 23 + 15 — undecryptability audit + daemon lifecycle (fake clock)
npm run shamir        # 12 — split/combine/ceremony/blast-radius
npm run paper         # 15 — sheets + QR pixel-decode round trip + recovery
npm run invite        # 16 — bearer links: mint/open/claim/approve/forgery
npm run e2e           # 19 — full lifecycle incl. 800KB blob will (mock Blossom), simulated 98-day death, release, paper recovery
npm run egress        # 13 — static origin scan + import-time traps (negative planted-URL case verified)
```

Browser E2E was also performed against live relays (owner publish → grant
→ second-key read → edit propagation → revoke + 441 banner → escrow armed
against a real running daemon with ack round-trip → invite claim with all
cascades → in-browser 2-of-3 ceremony → full wipe + recover-from-paper).
The Pages deploy was verified working (sign-in, relay scan, vendored
SLIP-39, zero console errors).

After pulling changes: run `npm run egress` and `npm run smoke:local`
first — egress parses app/index.html's import map, so styling passes from
parallel sessions are covered too.

## 5. Current state / recent history

- Session 1 (2026-07-11): full build M1–M5 — protocol layer, escrow
  daemon, app, vendored SLIP-39, tests, SECURITY/README, published to
  GitHub + Pages. Commits dba1b1a → 978fa70.
- Parallel session: **Nave design system** restyle (1b46c92 → b96a8ac) —
  shared ink/gold tokens with per-app terracotta accent for Nherit, Nave
  seal favicon, Alby-branded NIP-07 sign-in bar, common footer, gh-pages
  mirror deploy. app/index.html CSS is now the Nave system; the module
  code was not restructured.
- Working tree should be clean; local main == origin/main. If they
  diverge, the other session may have pushed — pull before working.

## 6. Open items (owner decisions unless noted)

1. Brand/legal review of estate/will language before wider release
   (spec's own requirement). Every surface currently says "not legal
   advice, not a will."
2. Spec §11 open decisions were adopted as the spec's own proposals
   (30/60/7 escrow timings; "you are named" notices on, owner-triggered;
   memorized-passphrase-with-hint). Documented in README — revisit freely.
3. Escrow daemon and Nvoy's TTL daemon kept separate for v1 (recommended);
   merging into one hardened operator service is a live question.
4. Optional: re-run a live-Blossom blob test against real hosts (modules
   are byte-identical to Nvelope's, which passed 8/8 at 50 MB; Nherit's
   e2e uses real-HTTP mock hosts).
5. Kind numbers may change when NIP-DA lands — constants at the top of
   lib/nipxx.mjs; the alpha banner already warns users.

## 7. Conventions and where deeper context lives

- Fiatjaf-style minimalism: small files, no frameworks, no build step,
  plain ESM `.mjs`; nostr-tools + @noble + @paulmillr/qr only. **Never
  hand-roll crypto** — audited primitives only (the SLIP-39 vendor swaps
  exactly three call sites onto @noble/hashes and nothing else).
- Opaque scope ids in `d` tags; human names live inside ciphertext only.
- Never publish real personal data in tests: throwaway keys, `.invalid`
  addresses.
- Semantics in UI color: accent = act, green = live/sharing, amber =
  escrowed/stale/bearer, violet = tier-3 paper, red = revoke/destroy.
- Honest copy is a product feature: revoked parties keep what they read;
  escrow is a timer, not a reader; paper is a bearer instrument; free
  relays promise nothing for decades. Don't soften these.
- Gitignored, machine-local (not in the public repo): `CLAUDE.md` (full
  build-state notes and gotchas), `drafts/` (session context transfer,
  spec copy), `.claude/launch.json` (preview config), `escrow/data/`.
  If you are a fresh session on the owner's machine, read `CLAUDE.md`
  next — it holds the owner context and fine-grained gotchas that don't
  belong in a public file.
