# The Nherit escrow daemon (tier-2 dead-man's switch)

> **The trust statement — read it before running or choosing an operator:**
> *The escrow can't read anything. It can release early, late, or never.
> Choose an operator you'd trust as a timer — or self-host it.*

The escrow is a **trusted timer, not a trusted reader**. What it holds are
NIP-59 gift wraps sealed by the owner to each beneficiary's public key — the
scope keys inside are NIP-44 encrypted to the *beneficiaries*, and the escrow
key cannot open them (`node test/escrow.mjs` asserts exactly this against the
stored artifact format). What it *can* do is control timing: release the
wraps early, refuse to release them, or collude with a beneficiary about
*when*. That is the entire trust surface, and it is why self-hosting is fully
supported: the paid tier and the self-hosted daemon are the same file.

What the escrow **learns**: the owner's pubkey, each beneficiary's pubkey
(it must know where to deliver), how many sealed grants exist, the timing
policy, and the out-of-band contact string the owner supplies for outreach.
Never contents, never scope names, never which scope a wrap belongs to.

## How it works

1. **Deposit.** The owner's client builds real kind-440 grants, gift-wraps
   them to each beneficiary, and sends the sealed wraps + release policy to
   the escrow npub inside another gift wrap, over ordinary relays. A newer
   deposit replaces the old wholesale; an empty one cancels the switch.
2. **Liveness.** Any new event signed by the owner npub counts as alive —
   normal nostr activity is the heartbeat. An explicit "check in" in the app
   is just a Grant Index save.
3. **Escalation.** After `quiet_days` of silence (default 30) the outreach
   pipeline fires — webhook or shell hook, below. After `grace_days` more
   (default 60) the release is *staged*: every challenge contact gets a
   gift-wrapped warning and can veto. A veto — or any owner activity —
   resets the clock entirely.
4. **Release.** If the `veto_days` window (default 7) passes in silence, the
   daemon publishes the sealed wraps to the relays. Beneficiaries' ordinary
   NIP-DA clients find them as ordinary grants; nothing special is needed on
   the receiving end, which is the point — the daemon's obligations end at
   publication.

## Self-hosting

```sh
NHERIT_ESCROW_NSEC=nsec1…  node escrow/bin/nherit-escrow.mjs
```

Generate a keypair for the daemon (any nostr tool; it needs no funds and no
profile), give the npub to the owners who will deposit to you, and keep the
process running — a `systemd` unit or `launchd` plist pointing at the command
above is all it takes. State lives in one JSON file (`NHERIT_DATA`, default
`escrow/data/store.json`); back it up — losing it before a release loses the
deposits, and owners would need to re-deposit.

Optional environment:

| var | meaning |
|---|---|
| `NHERIT_RELAYS` | comma-separated relay list (default: damus, nos.lol, primal) |
| `NHERIT_DATA` | store path (default `escrow/data/store.json`) |
| `NHERIT_INTERVAL_S` | sweep period, seconds (default 600) |
| `NHERIT_OUTREACH_URL` | POST `{owner, contact, stage}` JSON on escalation |
| `NHERIT_OUTREACH_CMD` | shell hook; `OWNER`/`CONTACT`/`STAGE` in the env |

`stage` is `quiet` (start of outreach), `staged` (final warning; veto window
running), or `released`. Wire email or SMS through either hook — the daemon
ships no mail stack on purpose.

## Operator duties, stated honestly

- **Run the clock faithfully.** The whole product promise to the owner is
  that you release neither early nor never.
- **Guard the store file and the daemon nsec** — not because they decrypt
  anything (they don't), but because deleting them silently disarms
  someone's switch.
- **Answer outreach.** The `quiet` stage exists so a very-much-alive owner
  who lost their keys can be reached before their heirs get an early
  inheritance scare.
