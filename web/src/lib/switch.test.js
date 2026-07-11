import test from 'node:test'
import assert from 'node:assert/strict'
import { switchThumbPosition } from './switch.js'

test('anchors the switch thumb and keeps the enabled position inside a 36px track', () => {
  assert.equal(switchThumbPosition(false), 'left-1 translate-x-0')
  assert.equal(switchThumbPosition(true), 'left-1 translate-x-4')
})
