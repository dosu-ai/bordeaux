// A board's files (spec 08, "Files"): bytes in R2, records in the board's Durable Object. Ported
// from upstream's src/server/blob.ts at the pinned commit, with what upstream keeps beside the bytes
// (each attachment's metadata, and a direct upload's ticket) kept as rows instead.
//
// Δ Direct uploads go to the board's own Worker, `PUT <board>/__bordeaux/uploads/<id>?t=<secret>`,
// which streams the bytes into R2 through its binding: no R2 API keys to keep, and it works the same
// on a local board. The Worker takes no more bytes than the upload's start said.
import { HttpError } from '@vercel/board'
import { Attachment, ATTACHMENT_BYTES_MAX, DIRECT_UPLOAD_BYTES_MAX, type Attachment as AttachmentType } from '../upstream/contract/schemas.ts'
import { mediaType } from '../upstream/contract/files.ts'
import { uploadName } from '../upstream/server/file-names.ts'
import { badRequest, notFound } from '../upstream/server/errors.ts'

/** How long a direct upload's URL takes bytes: long enough for 100 MB on a slow link (upstream's). */
const DIRECT_UPLOAD_TTL_MS = 30 * 60 * 1000

type Row = { id: string; name: string; type: string; size: number; uploaded_by: string | null; stored: number; secret: string | null; expires_at: number | null }

const noFiles = () => new HttpError(501, 'no_files', 'this board keeps no files: bind an R2 bucket as FILES')
export const attachmentNotFound = (id: string) => notFound(`no attachment: ${id}`, 'attachment_not_found')

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

/** 128 random bits, base64url, drawn again when they'd start with `-`, which a command line reads as a flag. */
function attachmentId(): string {
  for (;;) {
    const id = base64url(crypto.getRandomValues(new Uint8Array(16)))
    if (!id.startsWith('-')) return id
  }
}

const sha256 = async (text: string) => base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))

export function createFileTables(storage: DurableObjectStorage) {
  storage.sql.exec(`create table if not exists bx_files (
  id text primary key,
  name text not null,
  type text not null,
  size integer not null,
  uploaded_by text,
  stored integer not null,
  secret text,
  expires_at integer
)`)
  // When it was uploaded, for retention: rows from before this column are stamped on their first gc.
  if (!storage.sql.exec<{ name: string }>('pragma table_info(bx_files)').toArray().some((column) => column.name === 'created_at')) storage.sql.exec('alter table bx_files add column created_at integer')
}

export class Files {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly bucket: R2Bucket | null,
    /** Where this board's files sit in the bucket: its Durable Object's ID, which never changes. */
    private readonly prefix: string,
  ) {}

  private bucketOrFail(): R2Bucket {
    if (!this.bucket) throw noFiles()
    return this.bucket
  }

  key(id: string) {
    return `boards/${this.prefix}/attachments/${id}`
  }

  private row(id: string): Row | null {
    if (!Attachment.shape.id.safeParse(id).success) return null
    return (this.storage.sql.exec<Row>('select * from bx_files where id = ?', id).toArray()[0] as Row | undefined) ?? null
  }

  private attachment(row: Row): AttachmentType {
    return { id: row.id, name: row.name, type: row.type, size: Number(row.size) }
  }

  /**
   * Deletes the bytes and record of each file `gone` says may go (Δ retention, spec 02: upstream
   * never deletes bytes), and of each direct upload whose URL ran out before it finished.
   * `gone(id, uploadedAt)` decides for a stored file. Answers how many went.
   */
  async collect(gone: (id: string, uploadedAt: number) => Promise<boolean>, now = Date.now()): Promise<number> {
    this.storage.sql.exec('update bx_files set created_at = ? where created_at is null', now)
    const rows = this.storage.sql.exec<{ id: string; stored: number; expires_at: number | null; created_at: number }>('select id, stored, expires_at, created_at from bx_files').toArray()
    let collected = 0
    for (const row of rows) {
      const abandoned = Number(row.stored) === 0 && (row.expires_at ?? 0) < now
      if (!abandoned && !(Number(row.stored) === 1 && (await gone(row.id, Number(row.created_at))))) continue
      await this.bucket?.delete(this.key(row.id))
      this.storage.sql.exec('delete from bx_files where id = ?', row.id)
      collected++
    }
    return collected
  }

  /** Deletes a file's bytes and record now (redaction, spec 02). */
  async remove(id: string) {
    if (!this.row(id)) return false
    await this.bucket?.delete(this.key(id))
    this.storage.sql.exec('delete from bx_files where id = ?', id)
    return true
  }

  /** The bytes of every file kept here, and every direct upload started. */
  bytes(): number {
    const [row] = this.storage.sql.exec<{ n: number | null }>('select sum(size) as n from bx_files').toArray()
    return Number(row?.n ?? 0)
  }

  /** An upload sent in the request, up to 4 MB: stored under a fresh ID (upstream `writeUpload`). */
  async upload(input: { data: Uint8Array; name: string | null; type: string | null; uploadedBy: string }, max = ATTACHMENT_BYTES_MAX): Promise<AttachmentType> {
    const bucket = this.bucketOrFail()
    if (input.data.byteLength === 0) throw badRequest('the file is empty')
    if (input.data.byteLength > max) throw new HttpError(413, 'too_large', `attachments are at most ${max / 1024 / 1024} MB`)
    const attachment: AttachmentType = { id: attachmentId(), name: uploadName(input.name), type: mediaType(input.type), size: input.data.byteLength }
    await bucket.put(this.key(attachment.id), input.data, { httpMetadata: { contentType: attachment.type } })
    this.storage.sql.exec('insert into bx_files (id, name, type, size, uploaded_by, stored, created_at) values (?, ?, ?, ?, ?, 1, ?)', attachment.id, attachment.name, attachment.type, attachment.size, input.uploadedBy, Date.now())
    return attachment
  }

  /** Starts a direct upload, up to 100 MB: a fresh ID and a secret its URL carries (upstream `startUpload`). */
  async start(input: { name: string | null; type: string | null; size: number; uploadedBy: string }): Promise<{ id: string; secret: string; type: string; expiresAt: string }> {
    this.bucketOrFail()
    if (input.size > DIRECT_UPLOAD_BYTES_MAX) throw new HttpError(413, 'too_large', `direct uploads are at most ${DIRECT_UPLOAD_BYTES_MAX / 1024 / 1024} MB`)
    const id = attachmentId()
    const secret = base64url(crypto.getRandomValues(new Uint8Array(24)))
    const expiresAt = Date.now() + DIRECT_UPLOAD_TTL_MS
    const type = mediaType(input.type)
    this.storage.sql.exec(
      'insert into bx_files (id, name, type, size, uploaded_by, stored, secret, expires_at, created_at) values (?, ?, ?, ?, ?, 0, ?, ?, ?)',
      id,
      uploadName(input.name),
      type,
      input.size,
      input.uploadedBy,
      await sha256(secret),
      expiresAt,
      Date.now(),
    )
    return { id, secret, type, expiresAt: new Date(expiresAt).toISOString() }
  }

  /** Where the Worker puts a direct upload's bytes, while its URL is good and nothing's there yet. */
  async target(id: string, secret: string): Promise<{ key: string; size: number; type: string }> {
    const row = this.row(id)
    if (!row || row.stored || row.secret !== (await sha256(secret))) throw notFound(`no upload: ${id}`, 'upload_not_found')
    if ((row.expires_at ?? 0) < Date.now()) throw new HttpError(410, 'upload_expired', `the URL for ${id} has expired: start the upload again`)
    return { key: this.key(id), size: Number(row.size), type: row.type }
  }

  /** Finishes a direct upload once R2 has exactly the bytes its start said; only its uploader may (upstream `finishUpload`). */
  async finish(id: string, caller: string): Promise<AttachmentType> {
    const bucket = this.bucketOrFail()
    const row = this.row(id)
    if (!row || row.uploaded_by !== caller) throw notFound(`no upload: ${id}`, 'upload_not_found')
    // A second finish answers the same attachment.
    if (row.stored) return this.attachment(row)
    const stored = await bucket.head(this.key(id))
    if (!stored) throw new HttpError(409, 'not_uploaded', `nothing's been uploaded for ${id} yet: PUT the file to its URL first`)
    if (stored.size !== Number(row.size)) throw badRequest(`the store has ${stored.size} bytes for ${id}, but its upload said ${row.size}`, 'size_mismatch')
    this.storage.sql.exec('update bx_files set stored = 1, secret = null, expires_at = null where id = ?', id)
    return this.attachment(row)
  }

  /** An attachment the board has, and who uploaded it: null for none, or one not finished. */
  read(id: string): { attachment: AttachmentType; uploadedBy: string | null } | null {
    const row = this.row(id)
    return row && row.stored ? { attachment: this.attachment(row), uploadedBy: row.uploaded_by } : null
  }

  async body(id: string): Promise<ReadableStream<Uint8Array>> {
    const found = await this.bucketOrFail().get(this.key(id))
    if (!found) throw attachmentNotFound(id)
    return found.body
  }
}
