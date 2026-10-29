import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bucket, clock } from '../src/lib/voice.ts'

test('bucket keeps peaks, scales to 0.1..1 and fills short input', () => {
  const bars = bucket([0, 0.5, 0, 0, 1, 0, 0, 0.25], 4)
  assert.equal(bars.length, 4)
  assert.equal(Math.max(...bars), 1) // the loudest bucket hits full height
  assert.ok(bars.every((b) => b >= 0.1 && b <= 1))
  assert.ok(bars[0] > bars[1]) // a short syllable survives inside its bucket
  assert.deepEqual(bucket([], 3), [0.1, 0.1, 0.1])
  assert.equal(bucket([0.2, 0.4], 6).length, 6) // fewer samples than bars still fills
})

test('clock formats m:ss', () => {
  assert.equal(clock(0), '0:00')
  assert.equal(clock(65.7), '1:05')
})
