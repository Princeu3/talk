// Helpers' ring rules against a set clock. db.ts opens DATA_DIR/talk.db on import, so it gets a temp dir first.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'talk-agents-'))
process.env.DATA_DIR = dir
const { inRingHours, ringRule } = await import('../server/agents.ts')
after(() => rmSync(dir, { recursive: true, force: true }))

const TZ = 'Asia/Kolkata' // UTC+5:30 all year
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR
const at = (h: number, m = 0) => Date.UTC(2026, 0, 15, h, m) - 330 * MIN // that wall time in Kolkata
const rule = (now: number, rings: { at: number; ask: number }[] = [], more = {}) => ringRule({ ask: 99, tz: TZ, rings, wrote: null, ...more }, now)

test('ring hours are 08:00 to 22:00 where the owner is', () => {
  assert.match(rule(at(7, 59))!, /Outside ring hours/)
  assert.equal(rule(at(8, 0)), undefined)
  assert.equal(rule(at(21, 59)), undefined)
  assert.match(rule(at(22, 0))!, /Outside ring hours/)
  assert.equal(inRingHours(TZ, at(3)), false)
  assert.equal(inRingHours(TZ, at(9)), true)
  assert.equal(inRingHours(null, at(9)), false)
})

test('one ring per ask, 10 minutes apart, 6 a day, none after a decline until the owner writes', () => {
  const noon = at(12)
  assert.match(rule(noon, [{ at: noon - 12 * HOUR, ask: 99 }])!, /already rang/)
  assert.match(rule(noon + 9 * MIN + 59_000, [{ at: noon, ask: 1 }])!, /less than 10 minutes/)
  assert.equal(rule(noon + 10 * MIN, [{ at: noon, ask: 1 }]), undefined)
  const six = [0, 1, 2, 3, 4, 5].map((i) => ({ at: at(14) - DAY + i * HOUR, ask: i })) // 14:00 to 19:00 yesterday
  assert.match(rule(at(13, 59), six)!, /6 times in the last day/)
  assert.equal(rule(at(14), six), undefined, 'the 14:00 ring is 24 h old now')
  assert.match(rule(noon, [], { declined: at(11), wrote: at(10) })!, /didn’t take the last ring/)
  assert.equal(rule(noon, [], { declined: at(10), wrote: at(11) }), undefined)
})
