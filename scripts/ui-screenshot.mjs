#!/usr/bin/env node
// Capture the console at three widths for a UI change. Development tool only:
// it talks to a locally started Fledge through the Chrome DevTools protocol, so
// no extra npm dependency is added. Usage:
//
//   npm run dev            # or: node dist/index.js
//   node scripts/ui-screenshot.mjs --out docs/images/ui-v1 \
//     --pages /,/dashboard --widths 1280,768,360
//
// A page that needs a session is reached through /auth/dev first; pass
// --login /auth/dev when DEV_LOGIN_LOGIN is set. The script never runs user
// code; it only loads pages this deployment already serves.

import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const value = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index === -1 ? fallback : (args[index + 1] ?? fallback)
}
const base = value('--base', 'http://127.0.0.1:8080').replace(/\/$/, '')
const out = value('--out', 'docs/images/ui')
const pages = value('--pages', '/,/dashboard').split(',').filter(Boolean)
const widths = value('--widths', '1280,768,360').split(',').map(Number).filter(Number.isFinite)
const login = value('--login', '')
const prefix = value('--prefix', '')
// JPEG keeps a full-page screenshot small enough to attach to a pull request.
const jpeg = args.includes('--jpeg')
const quality = Number(value('--quality', '78'))

function chromeBinary() {
  const candidates = [
    process.env.CHROME_PATH,
    join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell'),
    join(homedir(), '.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'),
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('no Chromium found; set CHROME_PATH')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.next = 1
    this.pending = new Map()
    this.events = []
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id)
        if (entry === undefined) return
        this.pending.delete(message.id)
        if (message.error) entry.reject(new Error(message.error.message))
        else entry.resolve(message.result)
        return
      }
      this.events.push(message)
    })
  }

  send(method, params = {}, sessionId) {
    const id = this.next++
    const payload = { id, method, params }
    if (sessionId !== undefined) payload.sessionId = sessionId
    this.socket.send(JSON.stringify(payload))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  async waitFor(method, sessionId, timeoutMs = 15000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const index = this.events.findIndex((event) => event.method === method && (sessionId === undefined || event.sessionId === sessionId))
      if (index !== -1) return this.events.splice(index, 1)[0]
      await sleep(40)
    }
    throw new Error(`timed out waiting for ${method}`)
  }
}

async function main() {
  mkdirSync(out, { recursive: true })
  const profile = mkdtempSync(join(tmpdir(), 'fledge-shot-'))
  const chrome = spawn(chromeBinary(), [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
    '--force-device-scale-factor=1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' })

  try {
    const portFile = join(profile, 'DevToolsActivePort')
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (existsSync(portFile)) break
      await sleep(100)
    }
    const [port, wsPath] = readFileSync(portFile, 'utf8').split('\n')
    const socket = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve)
      socket.addEventListener('error', () => reject(new Error('cannot open the DevTools socket')))
    })
    const cdp = new Cdp(socket)
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Network.enable', {}, sessionId)

    if (login !== '') {
      await cdp.send('Page.navigate', { url: `${base}${login}` }, sessionId)
      await cdp.waitFor('Page.loadEventFired', sessionId)
      await sleep(300)
    }

    for (const width of widths) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height: 900, deviceScaleFactor: 1, mobile: width <= 640,
      }, sessionId)
      for (const path of pages) {
        await cdp.send('Page.navigate', { url: `${base}${path}` }, sessionId)
        await cdp.waitFor('Page.loadEventFired', sessionId)
        await sleep(500)
        // Overflow report: the acceptance bar is document.scrollWidth === innerWidth.
        const probe = await cdp.send('Runtime.evaluate', {
          expression: `(() => {
            const width = ${width};
            const offenders = [...document.querySelectorAll('body *')]
              .filter((el) => {
                const rect = el.getBoundingClientRect();
                // The skip link is parked off-screen on purpose, and a clipped
                // table head keeps its cells wide without widening the page.
                if (el.classList.contains('skip-link') || el.closest('thead') !== null) return false;
                return rect.width > 0 && rect.right > width + 1;
              })
              .slice(0, 6)
              .map((el) => {
                const cls = typeof el.className === 'string' && el.className !== '' ? '.' + el.className.trim().split(/\s+/).join('.') : '';
                return el.tagName.toLowerCase() + cls + ' right=' + Math.round(el.getBoundingClientRect().right);
              });
            return JSON.stringify({ target: width, innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, offenders });
          })()`,
          returnByValue: true,
        }, sessionId)
        if (probe?.result?.value) {
          const report = JSON.parse(probe.result.value)
          const status = report.scrollWidth > report.target + 1 ? 'OVERFLOW' : 'ok'
          console.log(`  ${path} @${width}: scrollWidth=${report.scrollWidth} innerWidth=${report.innerWidth} ${status}${report.offenders.length === 0 ? '' : ' ' + report.offenders.join(' | ')}`)
        }
        const { data } = await cdp.send('Page.captureScreenshot', {
          format: jpeg ? 'jpeg' : 'png',
          ...(jpeg ? { quality } : {}),
          captureBeyondViewport: true,
        }, sessionId)
        const name = `${prefix}${path === '/' ? 'home' : path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}-${width}.${jpeg ? 'jpg' : 'png'}`
        writeFileSync(join(out, name), Buffer.from(data, 'base64'))
        console.log(`wrote ${join(out, name)}`)
      }
    }
    socket.close()
  } finally {
    chrome.kill()
    rmSync(profile, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(String(error.message ?? error))
  process.exitCode = 1
})
