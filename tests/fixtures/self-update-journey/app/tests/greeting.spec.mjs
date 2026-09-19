import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GREETING, greeting } from '../src/greeting.mjs'

test('greets by name', () => {
  assert.equal(GREETING, 'Hello')
  assert.equal(greeting('Poise'), 'Hello, Poise!')
})
