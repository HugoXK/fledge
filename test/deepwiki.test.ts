import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const layout = readFileSync(new URL('../src/views/layout.ts', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8')
const script = readFileSync(new URL('../public/fledge-deepwiki.js', import.meta.url), 'utf8')
const style = readFileSync(new URL('../public/fledge-deepwiki.css', import.meta.url), 'utf8')

test('the console loads the DeepWiki assets on every page', () => {
  assert.match(layout, /fledge-deepwiki\.css/)
  assert.match(layout, /fledge-deepwiki\.js/)
  assert.match(layout, /data-fledge-auth="\$\{viewer !== undefined && viewer !== null \? 'in' : 'out'\}"/)
  assert.match(layout, /data-fledge-locale="\$\{locale\}"/)
  assert.match(layout, /data-fledge-path="\$\{escapeHtml\(path\)\}"/)
})

test('the page CSP allows only the DeepWiki MCP origin', () => {
  assert.match(app, /connect-src 'self' https:\/\/mcp\.deepwiki\.com;/)
})

test('DeepWiki is labelled third-party and model-generated in both locales', () => {
  assert.match(script, /DeepWiki 是第三方、模型生成的/)
  assert.match(script, /DeepWiki is third-party and model-generated/)
  assert.match(script, /^.*https:\/\/mcp\.deepwiki\.com\/mcp.*$/m)
  assert.match(script, /^.*https:\/\/deepwiki\.com\/.*$/m)
})

test('the DeepWiki panel uses the console design tokens', () => {
  assert.match(style, /var\(--accent\)/)
  assert.match(style, /var\(--space-/)
  assert.match(style, /var\(--touch\)/)
  assert.doesNotMatch(style, /#[0-9a-fA-F]{3,8}\b/)
})
