// estate.mjs — the estate record: scope templates (spec §3) and the payload
// that rides inside each kind-30440 ciphertext. An estate is four-plus
// scopes, each with its own key and grantee set; this module is the shared
// vocabulary between the vault editor, the beneficiary view, and the tests.
//
// A scope payload:
//   { nherit: 1, name, template, note,
//     items: [{ label, value }],          // pointers and instructions
//     docs:  [<Nvelope file entries>],    // manifest pattern verbatim (§3)
//     updated_at }
//
// Documents use Nvelope's file-entry format (shared/manifest.mjs) unchanged —
// inline base64 for small files, encrypted Blossom blobs for large ones.
// Zero new formats.
//
// Content rule enforced with copy, not code: Nherit stores WHERE things are
// and WHAT TO DO — the UI discourages raw secrets (see PASSWORD_HINT).

export const NHERIT_VERSION = 1

/** UI copy shown wherever free text is entered. Pointers, not passwords. */
export const PASSWORD_HINT =
  'Store where things are and what to do — not the secrets themselves. ' +
  'Good: "password manager emergency kit is in envelope B in the safe." ' +
  'Bad: the master password.'

/** Grant timing per scope: how access is expected to be delivered. */
export const TIERS = {
  immediate: 'Immediate — they can read it today (tier 1: trust the grantee)',
  escrow: 'Escrowed — released by a dead-man’s switch (tier 2)',
  shamir: 'Threshold — reconstituted from paper shares, 2-of-3 (tier 3)',
}

// The shipped templates (spec §3), all user-editable. `suggested` items are
// prefilled with empty values — prompts, not content. `timing` is the
// default grant tier offered when sharing the scope.
export const TEMPLATES = [
  {
    id: 'medical',
    name: 'Medical',
    timing: 'immediate',
    hint: 'Must be readable before death — advance directive, organ donation, medications, physicians.',
    suggested: ['Advance directive location', 'Organ donation decision',
      'Current medications', 'Primary physician', 'Health proxy'],
  },
  {
    id: 'spouse',
    name: 'Spouse',
    timing: 'immediate',
    hint: 'Everything: account inventory, password-vault pointer, wishes, finances.',
    suggested: ['Account inventory', 'Password vault pointer',
      'Financial adviser', 'Insurance policies', 'Wishes'],
  },
  {
    id: 'executor',
    name: 'Executor',
    timing: 'escrow',
    hint: 'Will location, attorney contact, asset list, institution contacts — no credentials.',
    suggested: ['Will location (original)', 'Attorney contact',
      'Asset list', 'Institutions to notify', 'Safe deposit box'],
  },
  {
    id: 'kid',
    name: 'Child',
    timing: 'escrow',
    perPerson: true,          // one scope per child, named for them
    hint: 'Letters, sentimental instructions, personal bequest notes.',
    suggested: ['Letter', 'Bequest notes', 'Family history to pass on'],
  },
  {
    id: 'operations',
    name: 'Operations',
    timing: 'immediate',
    hint: 'Property and caretaker handoff — who mows, who feeds, where the shutoff valves are.',
    suggested: ['Property caretakers', 'Utility shutoffs',
      'Service contracts', 'Recurring obligations'],
  },
]

export const templateById = (id) => TEMPLATES.find(t => t.id === id)

/** Canonical display order: template order, customs last, stable by name. */
export function scopeOrder(a, b) {
  const ia = TEMPLATES.findIndex(t => t.id === a.template)
  const ib = TEMPLATES.findIndex(t => t.id === b.template)
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || (a.name > b.name ? 1 : -1)
}

export function newScopePayload(templateId, name) {
  const t = templateById(templateId)
  return {
    nherit: NHERIT_VERSION,
    name: name ?? t?.name ?? 'Custom',
    template: t?.id ?? 'custom',
    note: '',
    items: (t?.suggested ?? []).map(label => ({ label, value: '' })),
    docs: [],
    updated_at: 0,
  }
}

/** Annual review (spec §5.2): true when the freshest scope edit is over a
 *  year old — time to re-confirm beneficiaries and refresh document scans.
 *  The whole product premise is "never out of date"; this is its nag. */
export function reviewDue(payloads, nowSec = Math.floor(Date.now() / 1000)) {
  const newest = Math.max(0, ...payloads.map(p => p?.updated_at ?? 0))
  return newest > 0 && nowSec - newest > 365 * 86400
}

/** Minimal structural validation; returns a list of problems (empty = ok). */
export function validateScopePayload(p) {
  const problems = []
  if (p?.nherit !== NHERIT_VERSION) problems.push('unknown nherit version')
  if (typeof p?.name !== 'string' || !p.name) problems.push('missing name')
  if (!Array.isArray(p?.items)) problems.push('items not an array')
  for (const [i, it] of (p?.items ?? []).entries())
    if (typeof it?.label !== 'string' || typeof it?.value !== 'string')
      problems.push(`item[${i}]: label/value not strings`)
  if (!Array.isArray(p?.docs)) problems.push('docs not an array')
  for (const [i, f] of (p?.docs ?? []).entries()) {
    if (!f.name) problems.push(`doc[${i}]: no name`)
    if (!f.inline && !f.servers?.length) problems.push(`doc[${i}]: neither inline nor servers`)
    if (f.servers?.length && !(f.sha256_cipher && f.filekey)) problems.push(`doc[${i}]: blob entry missing hash/key`)
  }
  return problems
}
