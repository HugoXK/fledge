import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { log } from './lib/log.js'

const config = loadConfig()
const built = await buildApp({ config })

try {
  await built.app.listen({ port: config.port, host: config.host })
  log.info('fledge ready', {
    baseUrl: config.baseUrl,
    host: config.host,
    port: config.port,
    runner: config.runner.mode,
    mail: config.mail.transport,
  })
} catch (error) {
  log.error('fledge failed to listen', { error: String(error) })
  await built.close()
  process.exit(1)
}

let closing = false
const shutdown = async (signal: string): Promise<void> => {
  if (closing) return
  closing = true
  log.info('fledge stopping', { signal })
  await built.close()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
