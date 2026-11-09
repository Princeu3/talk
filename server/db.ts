import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

// Railway volume in production, ./data locally.
export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data')
export const BLOB_DIR = path.join(DATA_DIR, 'blobs')
mkdirSync(BLOB_DIR, { recursive: true })

export const db = new DatabaseSync(path.join(DATA_DIR, 'talk.db'))

db.exec(`
  pragma journal_mode = wal;
  pragma foreign_keys = on;

  create table if not exists users (
    id text primary key,
    name text not null unique collate nocase,
    pubkey text not null,
    auth_hash text not null,
    created_at integer not null
  );
  create table if not exists invites (
    code text primary key,
    created_by text not null references users(id),
    expires_at integer not null
  );
  create table if not exists conversations (
    id text primary key,
    kind text not null check (kind in ('dm', 'group')),
    title text,
    created_at integer not null
  );
  create table if not exists members (
    conv_id text not null references conversations(id),
    user_id text not null references users(id),
    wrapped_key text not null,
    wrapped_by text not null references users(id),
    last_read integer not null default 0,
    primary key (conv_id, user_id)
  );
  create table if not exists messages (
    id integer primary key autoincrement,
    conv_id text not null references conversations(id),
    sender_id text not null references users(id),
    body text not null,
    created_at integer not null
  );
  create index if not exists messages_by_conv on messages (conv_id, id);
  create table if not exists attachments (
    id text primary key,
    conv_id text not null references conversations(id),
    size integer not null,
    created_at integer not null
  );
  create table if not exists push_subs (
    endpoint text primary key,
    user_id text not null references users(id),
    sub text not null
  );
  create table if not exists settings (
    key text primary key,
    value text not null
  );
  create table if not exists devices (
    token text primary key, -- APNs device token, hex
    user_id text not null references users(id),
    kind text not null check (kind in ('alert', 'voip')),
    env text not null check (env in ('sandbox', 'production')),
    created_at integer not null
  );
  create table if not exists blocks (
    user_id text not null references users(id),
    blocked_id text not null references users(id),
    primary key (user_id, blocked_id)
  );
  create table if not exists reports (
    id integer primary key autoincrement,
    reporter_id text not null references users(id),
    user_id text not null references users(id),
    conv_id text,
    note text,
    created_at integer not null
  );
  -- One per person per message; the emoji is sealed like a message body.
  create table if not exists reactions (
    message_id integer not null references messages(id) on delete cascade,
    user_id text not null references users(id),
    body text not null,
    primary key (message_id, user_id)
  );
`)

const addColumn = (table: string, column: string, def: string) => {
  if (!(db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column))
    db.exec(`alter table ${table} add column ${column} ${def}`)
}
addColumn('messages', 'edited_at', 'integer')
addColumn('members', 'muted', 'integer not null default 0')
addColumn('members', 'pinned', 'integer not null default 0')
// The app's protocol version on that phone: 2 and up know group calls.
addColumn('devices', 'v', 'integer not null default 1')

// Deleted accounts stay as a row with only the public key, so conversation
// keys they sealed for others can still be opened.
if (!(db.prepare('pragma table_info(users)').all() as { name: string }[]).some((c) => c.name === 'deleted_at'))
  db.exec('alter table users add column deleted_at integer')

// Seen messages (answered call logs) never count as unread.
if (!(db.prepare('pragma table_info(messages)').all() as { name: string }[]).some((c) => c.name === 'seen'))
  db.exec('alter table messages add column seen integer not null default 0')

// Client-made id, so an outbox resend after a lost ack stores nothing new.
// Old clients send none; nulls never collide in a unique index.
if (!(db.prepare('pragma table_info(messages)').all() as { name: string }[]).some((c) => c.name === 'cid'))
  db.exec('alter table messages add column cid text')
db.exec('create unique index if not exists messages_by_cid on messages (sender_id, cid)')

// Helpers: an owner-only account. owner_id is null for people.
addColumn('users', 'owner_id', 'text')
addColumn('users', 'agent', 'text') // helpers only: JSON AgentInfo (server/agents.ts)
// People who linked a helper: their IANA time zone, for their helpers' ring hours. Null for everyone else.
addColumn('users', 'tz', 'text')
addColumn('invites', 'agent', 'integer') // 1 on a 10-minute helper link, null on person invites

// Secrets live in the DB (on the volume) so a fresh deploy needs no config;
// an env var with the same name overrides.
export function setting(key: string, make: () => string): string {
  if (process.env[key]) return process.env[key]
  const row = db.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined
  if (row) return row.value
  const value = make()
  db.prepare('insert into settings (key, value) values (?, ?)').run(key, value)
  return value
}

export const SESSION_SECRET = setting('SESSION_SECRET', () => randomBytes(32).toString('hex'))

export const userExists = (id: string) => !!db.prepare('select 1 from users where id = ? and deleted_at is null').get(id)

export const isMember = (convId: string, userId: string) =>
  !!db.prepare('select 1 from members where conv_id = ? and user_id = ?').get(convId, userId)

// Has `owner` blocked `other`?
export const blocks = (owner: string, other: string) =>
  !!db.prepare('select 1 from blocks where user_id = ? and blocked_id = ?').get(owner, other)

export const memberIds = (convId: string) =>
  (db.prepare('select user_id from members where conv_id = ?').all(convId) as { user_id: string }[]).map((r) => r.user_id)

export const kindOf = (convId: string) =>
  (db.prepare('select kind from conversations where id = ?').get(convId) as { kind: string } | undefined)?.kind

export const mutedIds = (convId: string) =>
  new Set((db.prepare('select user_id from members where conv_id = ? and muted').all(convId) as { user_id: string }[]).map((r) => r.user_id))

// Members who get what `from` does in this chat: everyone but those who blocked
// them, and in a DM only `from` once either side has blocked.
export const audience = (convId: string, from: string) =>
  dmRefusal(convId, from) ? [from] : memberIds(convId).filter((u) => !blocks(u, from))

// In a DM, a block either way stops messages, reactions and calls.
export function dmRefusal(convId: string, me: string): string | undefined {
  if (kindOf(convId) !== 'dm') return
  const other = memberIds(convId).find((u) => u !== me)
  if (other && blocks(me, other)) return 'Unblock this person to message them.'
  if (other && blocks(other, me)) return 'This person isn’t taking messages from you.'
}
