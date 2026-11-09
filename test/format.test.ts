import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Conversation, Me, User } from '../shared/types.ts'
import { closedAsk, convName, readOnlyNote } from '../src/lib/format.ts'

const user = (id: string, more: Partial<User> = {}): User => ({ id, name: id, pubkey: '', ...more })
const me = (...users: User[]): Me => ({ user: user('me'), users: [user('me'), ...users], conversations: [], blocked: [], vapidPublicKey: '' })
const dm = (...members: string[]): Conversation =>
  ({ id: 'c', kind: 'dm', title: null, members, wrappedKey: '', wrappedBy: 'me', lastMessageAt: null, lastMessage: null, unread: 0 })
const removed = user('h', { name: 'Deleted account', owner: 'me', deleted: true })

test('a chat nobody can answer is read-only, with a note saying why', () => {
  assert.equal(readOnlyNote(me(user('bob')), dm('me', 'bob')), undefined)
  assert.equal(readOnlyNote(me(user('h', { owner: 'me' })), dm('me', 'h')), undefined) // a live helper
  assert.equal(readOnlyNote(me(removed), dm('me', 'h')), 'This helper was removed')
  assert.equal(readOnlyNote(me(user('bob', { deleted: true })), dm('me', 'bob')), 'This account was deleted')
  assert.equal(readOnlyNote(me(), dm('me')), 'This account was deleted') // a deleted account leaves the DM
  assert.equal(readOnlyNote(me(), dm('me', 'new')), undefined) // a peer not loaded yet isn't gone
  assert.equal(readOnlyNote(me(), { ...dm('me'), kind: 'group', title: 'Trip' }), undefined) // the rest left a group
})

test('a DM left with only you is named for the deleted account, not for you', () => {
  assert.equal(convName(me(), dm('me')), 'Deleted account')
  assert.equal(convName(me(user('bob', { name: 'Bob' })), dm('me', 'bob')), 'Bob')
})

test("a removed helper's open ask shows as closed", () => {
  const ask = { from: 'h', text: 'Run npm test?\nReply yes kxqzm or no kxqzm by 2:30 PM, or tap 👍\n\nin Messaging', ask: { code: 'kxqzm', expires: 1 } }
  assert.equal(closedAsk(me(removed), 'h', ask).text, 'Run npm test?\nClosed: helper removed\n\nin Messaging')
  assert.equal(closedAsk(me(user('h', { owner: 'me' })), 'h', ask), ask) // a live helper's ask stays open
  assert.equal(closedAsk(me(user('h', { deleted: true })), 'h', ask), ask) // only a helper asks
  const done = { from: 'h', text: 'Run npm test?\nApproved 2:03 PM' } // the closing edit drops `ask`
  assert.equal(closedAsk(me(removed), 'h', done), done)
})
