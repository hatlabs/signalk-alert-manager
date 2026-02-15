/**
 * E2E Test Server Helper
 *
 * Provides lifecycle management for a real Signal K server instance
 * with the alert-manager plugin loaded, used for integration testing.
 */

import net from 'net'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(__dirname, '../../..')

export interface TestServer {
  /** Base URL of the running server (e.g., http://localhost:PORT) */
  host: string
  /** Port number the server is listening on */
  port: number
  /** Path to the temporary config directory */
  configDir: string
  /** Stop the server and clean up temp directory */
  stop: () => Promise<void>
  /** Send a delta to the server via WebSocket */
  sendDelta: (delta: object) => Promise<void>
}

export interface ManagedServer {
  host: string
  port: number
  stop: () => Promise<void>
}

/** Find an available TCP port. */
export function freeport(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    let port = 0

    server.on('listening', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine port'))
        return
      }
      port = address.port
      server.close()
    })

    server.once('close', () => {
      resolve(port)
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1')
  })
}

/** Create a temporary config directory with the plugin symlinked. */
export function createTempConfig(configDir: string): void {
  fs.mkdirSync(configDir, { recursive: true })

  // Create .npmrc to skip package-lock
  fs.writeFileSync(path.join(configDir, '.npmrc'), 'package-lock=false\n')

  // Create minimal package.json
  fs.writeFileSync(
    path.join(configDir, 'package.json'),
    JSON.stringify({
      name: 'signalk-server-config',
      version: '0.0.1',
      description: 'E2E test config for signalk-alert-manager',
      license: 'Apache-2.0'
    })
  )

  // Create plugin-config-data directory with plugin enabled
  const pluginConfigDir = path.join(configDir, 'plugin-config-data')
  fs.mkdirSync(pluginConfigDir, { recursive: true })
  fs.writeFileSync(
    path.join(pluginConfigDir, 'signalk-alert-manager.json'),
    JSON.stringify({
      enabled: true,
      configuration: {
        escalation: {
          warningToAlarm: { enabled: false }
        }
      }
    })
  )

  // Symlink the plugin into node_modules so the server discovers it
  const nodeModulesDir = path.join(configDir, 'node_modules')
  fs.mkdirSync(nodeModulesDir, { recursive: true })
  const symlinkTarget = path.join(nodeModulesDir, 'signalk-alert-manager')
  if (!fs.existsSync(symlinkTarget)) {
    fs.symlinkSync(PLUGIN_ROOT, symlinkTarget)
  }
}

/**
 * Connect a WebSocket to the SK server's stream endpoint.
 * Uses the native WebSocket API available in Node 22+.
 */
function connectWebSocket(port: number): Promise<{
  sendDelta: (delta: object) => Promise<void>
  close: () => void
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${String(port)}/signalk/v1/stream?subscribe=none`)

    ws.addEventListener('open', () => {
      resolve({
        sendDelta: (delta: object) => {
          ws.send(JSON.stringify(delta))
          return Promise.resolve()
        },
        close: () => {
          ws.close()
        }
      })
    })

    ws.addEventListener('error', () => {
      reject(new Error('WebSocket connection failed'))
    })
  })
}

/** Save env vars and set new values; returns a restore function. */
function setEnvWithRestore(vars: Record<string, string>): () => void {
  const saved: Record<string, string | undefined> = {}
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key]
    process.env[key] = vars[key]
  }
  return () => {
    for (const [key, original] of Object.entries(saved)) {
      if (original === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- standard pattern for env var removal
        delete process.env[key]
      } else {
        process.env[key] = original
      }
    }
  }
}

/** Boot a SK server instance against a given config directory. */
async function bootServer(configDir: string): Promise<{
  server: { stop: () => Promise<unknown>; app: Record<string, unknown> }
  port: number
  restoreEnv: () => void
}> {
  const port = await freeport()

  const restoreEnv = setEnvWithRestore({
    SIGNALK_NODE_CONFIG_DIR: configDir,
    SIGNALK_DISABLE_SERVER_UPDATES: 'true'
  })

  // Import the Server class (CJS module, default export)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Server = require('signalk-server') as new (opts: object) => {
    start: () => Promise<{ app: Record<string, unknown> }>
    stop: () => Promise<unknown>
    app: Record<string, unknown>
  }

  const server = new Server({
    config: {
      settings: {
        port,
        interfaces: { plugins: true },
        pipedProviders: []
      }
    }
  })

  await server.start()

  // Wait for the plugin to finish async initialization
  const plugins = server.app.plugins as
    | {
        id: string
        whenReady?: () => Promise<void>
      }[]
    | undefined

  const alertPlugin = plugins?.find((p) => p.id === 'signalk-alert-manager')
  if (alertPlugin?.whenReady) {
    await alertPlugin.whenReady()
  }

  restoreEnv()

  return { server, port, restoreEnv }
}

/**
 * Start a Signal K server with the alert-manager plugin loaded.
 *
 * The server runs with security disabled and no piped providers,
 * using a unique temporary config directory.
 */
export async function startServer(): Promise<TestServer> {
  const configDir = path.join(fs.mkdtempSync(path.join(PLUGIN_ROOT, '.e2e-test-')), '')
  createTempConfig(configDir)

  const { server, port } = await bootServer(configDir)
  const host = `http://localhost:${String(port)}`

  // Connect WebSocket for sending deltas
  const wsConn = await connectWebSocket(port)

  return {
    host,
    port,
    configDir,
    stop: async () => {
      wsConn.close()
      await server.stop()
      // Clean up temp directory
      fs.rmSync(configDir, { recursive: true, force: true })
    },
    sendDelta: wsConn.sendDelta
  }
}

/**
 * Start a server against an existing config directory.
 * Does not clean up the config dir on stop (caller manages lifecycle).
 */
export async function startServerFromConfig(configDir: string): Promise<ManagedServer> {
  const { server, port } = await bootServer(configDir)

  return {
    host: `http://localhost:${String(port)}`,
    port,
    stop: () => server.stop() as Promise<void>
  }
}
