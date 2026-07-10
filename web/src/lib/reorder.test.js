import test from 'node:test'
import assert from 'node:assert/strict'
import { moveItem, moveTarget } from './reorder.js'

test('moves an item to the requested index without mutating the source', () => {
  const source = [1, 2, 3]

  assert.deepEqual(moveItem(source, 0, 2), [2, 3, 1])
  assert.deepEqual(source, [1, 2, 3])
})

test('returns the original ordering for invalid or unchanged positions', () => {
  const source = [1, 2, 3]

  assert.deepEqual(moveItem(source, 1, 1), source)
  assert.deepEqual(moveItem(source, -1, 1), source)
  assert.deepEqual(moveItem(source, 0, 3), source)
})

test('clamps a keyboard move target to the queue boundaries', () => {
  assert.equal(moveTarget(0, -1, 3), 0)
  assert.equal(moveTarget(2, 1, 3), 2)
  assert.equal(moveTarget(1, 1, 3), 2)
})
