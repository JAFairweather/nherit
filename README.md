# Nherit

**Family break-glass digital legacy vault on nostr.** One encrypted,
self-maintained estate record with per-beneficiary scopes; heirs and
executors hold revocable grants; the entire estate reconstitutes from a
single key printed on paper. No company between you and your family —
nothing that can be breached, acquired, or sunset while your heirs need it.

**The will stays current until the day it's needed, the wrong people can be
cut off cleanly, and recovery is a piece of paper — not a support ticket to
a company that may not exist in thirty years.**

Built as a pure client of
[NIP-DA Scoped Data Grants](https://github.com/nostr-protocol/nips/pull/2411)
(draft; kinds 30440/440/441/10440 are placeholders pending assignment).
Vanilla ESM, no build step, nostr-tools as the only runtime framework;
documents reuse [Nvelope](https://github.com/JAFairweather/nvelope)'s
encrypted-manifest + Blossom pattern verbatim.

## How it works

- **The record.** Each scope (Medical, Spouse, Executor, per-child, …) is one
  addressable event encrypted under its own random key. Editing republishes
  under the same key — every grantee is instantly current. *Unlike the copy
  of the will in the fireproof box, this is never out of date.*
- **People.** Beneficiaries hold their own keys. Onboard them by invite link
  (no key needed — claim upgrades them to a durable key), by minting a key
  for them and printing their recovery sheet, or by pasting an npub.
- **Break-glass** (cryptography cannot verify death; three honest tiers):
  1. **Trust the person** — immediate grant; they don't look until needed.
  2. **Dead-man's switch** — sealed grants sit with an escrow daemon that
     watches your npub for silence; staged release, challenge-contact veto.
     *The escrow can't read anything. It can release early, late, or never.
     Choose an operator you'd trust as a timer — or [self-host it](escrow/README.md).*
  3. **Paper shares** — a scope key split 2-of-3 (SLIP-39) across e.g.
     executor, sibling, attorney; a client-side ceremony reconstitutes it.
     No service anywhere.
- **Rotation** severs the estranged from every future version with one tap —
  and cascades: escrow deposits re-seal automatically; paper shares are
  flagged stale for re-split.
- **Recovery is paper.** The owner sheet carries the passphrase-locked key
  (ncryptsec QR, never the raw nsec) plus instructions written for a stranger
  finding it in twenty years. Fresh device + sheet + passphrase → the whole
  estate. Printing the kit is a setup gate, not a suggestion.

## Run it

```sh
npm install
npm run web            # http://localhost:4445/
npm run escrow         # the tier-2 daemon (see escrow/README.md)
```

## Tests

```sh
npm run smoke:local    # estate lifecycle, in-memory relay (17)
npm run smoke          # same against live public relays (14)
npm run escrow:test    # sealed-wrap undecryptability audit + daemon lifecycle (23 + 15)
npm run shamir         # SLIP-39 split/combine/ceremony (12)
npm run paper          # sheets + QR pixel-decode round trip + recovery (15)
npm run invite         # bearer links: mint/open/claim/approve (16)
npm run e2e            # the whole life of an estate in one run (19)
npm run egress         # zero-egress: static scan + import traps (13)
```

Every flow ends with an adversarial observer assertion: what did a hostile
relay operator actually learn? (Names, contents, beneficiary identities,
tier markers: nothing.)

Read [SECURITY.md](SECURITY.md) — the NOT-protected half is written with the
same care as the protected half.

## Design decisions adopted from the spec's open questions (§11)

Defaults chosen per the spec's own proposals — all owner-tunable, revisit
before any public release:

1. Escrow timings: 30 quiet days → outreach, 60 more → staged release,
   7-day veto window. Challenge contact defaults to whoever the owner picks
   (the UI suggests the spouse by listing People).
2. "You are named in a vault" visibility: **on by default** (owner-triggered
   per person) — heirs who don't know to look defeat the product.
3. Paper-kit passphrase strategy: memorized-with-hint is the shipped default;
   the sheet prints an optional hint and says why the passphrase is absent.
4. Escrow daemon and Nvoy's TTL scheduler remain **separate** in v1 — one
   repo each stays auditable; merging into one hardened operator service is
   a post-v1 decision (they share no state, only the pattern).
5. Brand/legal review of estate language: pending human review; every UI
   surface already says "not legal advice, not a will."

## Status

Alpha. Draft protocol, placeholder kind numbers, throwaway keys only.

MIT — app code. The vendored SLIP-39 implementation (lib/vendor/) is MIT,
(c) 2019 ilap; the vendored NIP-DA reference lib (lib/) is CC0 from
[nostr-scoped-data-grants](https://github.com/JAFairweather/nostr-scoped-data-grants).
