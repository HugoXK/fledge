import test from 'node:test'
import assert from 'node:assert/strict'
import { errorClass, errorMessage } from '../src/lib/errorText.js'

// #666: a failure recorded after a command committed is read months later from a
// row, not from a log. The class has to distinguish "the store refused the write"
// (SQLiteError) from "the code threw" (TypeError), and a class must never come
// back empty: an Error with no name still has to say something.

test('the class is the thrown Error name, so a store refusal and a code bug differ', () => {
  class SQLiteError extends Error {
    override name = 'SQLiteError'
  }
  assert.equal(errorClass(new SQLiteError('database is locked')), 'SQLiteError')
  assert.equal(errorClass(new TypeError('x is not a function')), 'TypeError')
})

test('an Error with an empty name still yields a usable class', () => {
  const error = new Error('anonymous')
  error.name = ''
  assert.equal(errorClass(error), 'unknown')
})

test('a thrown string keeps its own marker and a thrown object is unknown', () => {
  assert.equal(errorClass('permission denied'), 'string')
  assert.equal(errorClass({ code: 'EACCES' }), 'unknown')
  assert.equal(errorClass(undefined), 'unknown')
})

test('the message is the Error message and never the class or an object dump', () => {
  assert.equal(errorMessage(new Error('the row disappeared')), 'the row disappeared')
  assert.equal(errorMessage('permission denied'), 'permission denied')
  assert.equal(errorMessage({ code: 'EACCES' }), '')
})
