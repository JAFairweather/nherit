// checkin.mjs — the out-of-band outreach pipeline. Nostr can't email the
// owner ("are you alive?" must leave the network the owner went silent on),
// so outreach is a pluggable hook: a webhook POST, a shell command, or just
// the daemon log. Operators wire their own SMTP/SMS through either — the
// daemon deliberately ships no mail stack.
//
//   NHERIT_OUTREACH_URL   POST {owner, contact, stage} as JSON
//   NHERIT_OUTREACH_CMD   run with OWNER/CONTACT/STAGE in the environment
//
// `stage` is 'quiet' (start of outreach), 'staged' (release countdown
// running — final warning), or 'released' (it happened).

import { execFile } from 'node:child_process'

export function makeOutreach({ url, cmd, log = () => {} }) {
  return async ({ owner, contact, stage }) => {
    log(`outreach [${stage}] owner=${owner.slice(0, 12)}… contact=${contact || '(none on file)'}`)
    if (url) {
      try {
        await fetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ owner, contact, stage }),
          signal: AbortSignal.timeout(15_000),
        })
      } catch (err) { log(`outreach webhook failed: ${err.message}`) }
    }
    if (cmd) {
      await new Promise((resolve) => {
        execFile('/bin/sh', ['-c', cmd], {
          env: { ...process.env, OWNER: owner, CONTACT: contact, STAGE: stage },
          timeout: 30_000,
        }, (err) => { if (err) log(`outreach command failed: ${err.message}`); resolve() })
      })
    }
  }
}
