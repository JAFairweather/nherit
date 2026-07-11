// docs.mjs — document attach/download for scope payloads, both sides of the
// wire. Nvelope's pattern verbatim: ≤48 KB rides inline (base64 inside the
// scope ciphertext); bigger bodies are padded, encrypted under a fresh
// per-file key, and mirrored to Blossom as ciphertext — the entry carries
// {servers, sha256_cipher, filekey} and the scope key gates everything.

import { inlineFileEntry, inlineBytes, blobFileEntry, blobKey } from '../shared/manifest.mjs'
import { newFileKey, encryptBlob, decryptBlob, uploadBlob, fetchBlob } from '../shared/blossom.mjs'
import { SERVERS, state, fmtSize } from './main.mjs'

export const INLINE_MAX = 48 * 1024
export const FILE_MAX = 250 * 1024 * 1024

/** File → manifest entry, uploading to Blossom when it can't ride inline.
 *  onMsg gets progress copy for the status line. */
export async function attachFile(file, onMsg = () => {}) {
  if (file.size > FILE_MAX) throw new Error(`${file.name} is over the 250 MB cap`)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const mime = file.type || 'application/octet-stream'
  if (bytes.length <= INLINE_MAX)
    return inlineFileEntry({ name: file.name, mime, bytes })
  onMsg(`encrypting ${file.name} (${fmtSize(bytes.length)})…`)
  const filekey = newFileKey()
  const cipher = encryptBlob(filekey, bytes)
  onMsg(`uploading ${fmtSize(cipher.length)} ciphertext to ${SERVERS.length} host(s)…`)
  const desc = await uploadBlob(SERVERS, state.signer, cipher)
  if (desc.failures?.length)
    onMsg(`mirrored to ${desc.servers.length}/${SERVERS.length} — ${desc.failures.map(f => `${new URL(f.server).host}: ${f.message}`).join('; ')}`)
  return blobFileEntry({ name: file.name, mime, size: bytes.length, filekey, desc })
}

/** Manifest entry → plaintext bytes, hash-verified when it comes off Blossom. */
export async function docBytes(entry) {
  if (entry.inline) return inlineBytes(entry)
  const cipher = await fetchBlob(entry.servers, entry.sha256_cipher)
  return decryptBlob(blobKey(entry), cipher)
}

export function saveFile(name, mime, bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
  const a = document.createElement('a')
  a.href = url; a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
