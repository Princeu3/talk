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
`)

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

export const isMember = (convId: string, userId: string) =>
  !!db.prepare('select 1 from members where conv_id = ? and user_id = ?').get(convId, userId)

export const memberIds = (convId: string) =>
  (db.prepare('select user_id from members where conv_id = ?').all(convId) as { user_id: string }[]).map((r) => r.user_id)
