# Nherit — threat model, in plain language

Nherit is a family break-glass legacy vault built as a pure client of NIP-DA
(Scoped Data Grants, draft). One person — the owner — maintains one encrypted
estate record, split into scopes (medical, spouse, executor, per-child, …),
each with its own key and its own audience. Relays and blob hosts store only
ciphertext. There is no server-side account and no company in the loop:
nothing to breach, acquire, or sunset while your heirs need it.

## What IS protected

- **Estate contents.** Every scope payload and every attached document is
  encrypted in the browser before anything touches the network. Relays see
  NIP-44 ciphertext under random scope keys; Blossom hosts see padded
  ciphertext whose size reveals only a bucket class.
- **Who your beneficiaries are.** Grants, escrow deposits, vetoes, share
  deliveries, and notices all travel inside NIP-59 gift wraps: the relay sees
  an ephemeral pubkey delivering an opaque blob. *Who inherits what* is
  itself sensitive, and it is not on the wire. The e2e suite asserts this
  with an adversarial observer after every flow.
- **Revocation on estrangement or divorce.** Rotating a scope re-keys it and
  re-grants only survivors: the revoked party is severed from all future
  versions with one tap. The dangerous artifact in estate fights is a *stale*
  copy in hostile hands — rotation prevents exactly that.
- **Recovery.** The whole estate reconstitutes from the owner key alone
  (Grant Index, kind 10440). The paper kit carries that key
  passphrase-locked (ncryptsec); a found sheet alone is worthless.

## What is NOT protected — read this half just as carefully

- **A revoked beneficiary keeps whatever they already read.** This is the
  protocol's standing honest caveat, and physics: you cannot unread a page.
  What rotation buys is that their copy stops being current — like any paper
  they were once handed, but with a visible "no longer maintained" marker.
- **The escrow service controls release timing, not content.** *The escrow
  can't read anything. It can release early, late, or never. Choose an
  operator you'd trust as a timer — or self-host it.* Sealed grants are
  gift-wrapped to each beneficiary's key; `npm run escrow:test` proves the
  escrow's stored material decrypts nothing. But it could release early,
  refuse to release, or collude with a beneficiary about timing. It also
  necessarily learns: your pubkey, your beneficiaries' pubkeys, the wrap
  count, the timing policy, and your outreach contact. It is a trusted
  timer, not a trusted reader.
- **Paper artifacts are bearer instruments.** The owner sheet, beneficiary
  sheets, and Shamir cards must be treated like the original will: safe
  deposit box or home safe. Every sheet prints this warning on itself. The
  owner sheet ships the ncryptsec — never the raw nsec — so paper alone
  exposes nothing before death; keep the passphrase on a different path.
- **Post-death, nobody can rotate.** Whatever access exists when the owner
  dies is final. This is why printing the paper kit is a setup *gate*, and
  why the design minimizes what any single leaked artifact exposes.
- **Shamir shares demand custody discipline.** Any `threshold` of the cards
  open that one scope, forever (until the owner rotates it). A single card
  reveals nothing; collusion of `threshold` holders is the model's floor.
- **Traffic metadata.** A relay sees that *some* pubkey published an
  addressable ciphertext and that gift wraps flowed to *some* pubkeys. Gift
  wraps hide senders, not recipients — the beneficiary's pubkey is the
  wrap's routing tag. An observer correlating wraps over time learns
  activity patterns, not contents or relationships to the owner.
- **No persistence guarantee from free infrastructure.** Public relays and
  blob hosts promise nothing measured in decades. The Settings tab says
  this; the answer is a paid/self-run relay and Blossom host for the estate
  horizon — and paper, which needs no operator.
- **Code delivery.** The app is static files plus pinned esm.sh modules. A
  tampered CDN or hosting could serve different code than what was audited.
  `npm run egress` pins every shipped origin and proves nothing phones home
  at module load; run the app from your own copy for the strongest stance.
- **This is not legal advice and not a will.** Nherit stores and delivers;
  it does not make documents legally operative. The scanned will lives here
  *alongside* the original, not instead of it.

## The three break-glass tiers, honestly

| Tier | Mechanism | You trust |
|---|---|---|
| 1 — immediate | Grant now; they don't look until needed | The person |
| 2 — dead-man's switch | Escrow holds sealed wraps, watches for silence, staged release with challenge-contact veto | An operator, as a timer only |
| 3 — Shamir 2-of-3 | SLIP-39 cards; client-side ceremony | No service; `threshold` holders not to collude |

Cryptography cannot verify death. These tiers are the design's whole answer;
there is deliberately no death-certificate API in v1.

## Reporting

This is alpha software on a draft NIP whose kind numbers may change. Use
throwaway keys. Issues: https://github.com/JAFairweather/nherit/issues
