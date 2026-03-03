/**
 * REST API Routes
 *
 * Express route handlers for alert operations.
 * Registered via plugin.registerWithRouter().
 *
 * @see docs/SPEC.md Section 6.1 for endpoint specifications
 */

import type { IRouter, Request, Response } from 'express'
import type { AlertManager } from '../core/AlertManager.js'
import type {
  AlertFilter,
  AlertPriority,
  AlertState,
  HistoryEventType,
  IHistoryStore
} from '../types.js'

/** SK server auth middleware adds these properties to the request. */
interface SKPrincipal {
  identifier: string
  permissions: string
}

const VALID_PRIORITIES: AlertPriority[] = ['emergency', 'alarm', 'warning', 'caution']
const VALID_STATES: AlertState[] = [
  'normal',
  'unacknowledged',
  'acknowledged',
  'rtn-unacknowledged'
]
const VALID_EVENT_TYPES: HistoryEventType[] = [
  'raise',
  'acknowledge',
  'silence',
  'unsilence',
  'clear',
  'escalate'
]

const MAX_MESSAGE_LENGTH = 1000

export interface RouteDependencies {
  getAlertManager(): AlertManager | undefined
  getHistoryStore(): IHistoryStore | undefined
  getUiConfig(): {
    minAudiblePriority: 'off' | 'emergency' | 'alarm' | 'warning'
    enableSimulation: boolean
  }
}

/**
 * Register all REST API routes on the given router.
 *
 * Authentication is handled by the Signal K server's middleware, which
 * applies adminAuthenticationMiddleware to all `/plugins` routes before
 * they reach these handlers. Unauthenticated requests receive 401 from
 * the server layer and never reach this code.
 *
 * Static paths (/alerts/history, /alerts/silence-all) are registered
 * before parametric paths (/alerts/:id) to avoid Express matching issues.
 */
export function registerRoutes(router: IRouter, deps: RouteDependencies): void {
  // --- Config routes ---

  router.get('/config/ui', (_req: Request, res: Response) => {
    res.json(deps.getUiConfig())
  })

  // --- Static routes (must come before :id) ---

  router.get('/alerts/history', (req: Request, res: Response) => {
    const historyStore = deps.getHistoryStore()
    if (!historyStore) {
      res.status(503).json({ error: 'Alert manager not ready' })
      return
    }

    const { alertId, from, to, eventType, limit, offset } = req.query

    // Validate limit
    if (limit !== undefined) {
      const limitNum = Number(limit)
      if (!Number.isInteger(limitNum) || limitNum < 0) {
        res.status(400).json({ error: 'limit must be a non-negative integer' })
        return
      }
    }

    // Validate offset
    if (offset !== undefined) {
      const offsetNum = Number(offset)
      if (!Number.isInteger(offsetNum) || offsetNum < 0) {
        res.status(400).json({ error: 'offset must be a non-negative integer' })
        return
      }
    }

    // Validate from/to as parseable dates
    if (typeof from === 'string' && isNaN(Date.parse(from))) {
      res.status(400).json({ error: 'from must be a valid ISO 8601 date' })
      return
    }
    if (typeof to === 'string' && isNaN(Date.parse(to))) {
      res.status(400).json({ error: 'to must be a valid ISO 8601 date' })
      return
    }

    // Validate eventType
    let parsedEventTypes: HistoryEventType[] | undefined
    if (typeof eventType === 'string') {
      const types = eventType.split(',')
      for (const t of types) {
        if (!VALID_EVENT_TYPES.includes(t as HistoryEventType)) {
          res.status(400).json({ error: `Invalid eventType: ${t}` })
          return
        }
      }
      parsedEventTypes = types as HistoryEventType[]
    }

    historyStore
      .query({
        alertId: typeof alertId === 'string' ? alertId : undefined,
        from: typeof from === 'string' ? from : undefined,
        to: typeof to === 'string' ? to : undefined,
        eventType: parsedEventTypes,
        limit: limit !== undefined ? Number(limit) : undefined,
        offset: offset !== undefined ? Number(offset) : undefined
      })
      .then((result) => {
        res.json(result)
      })
      .catch(() => {
        res.status(500).json({ error: 'Internal server error' })
      })
  })

  router.post('/alerts/silence-all', (_req: Request, res: Response) => {
    const manager = deps.getAlertManager()
    if (!manager) {
      res.status(503).json({ error: 'Alert manager not ready' })
      return
    }

    manager
      .silenceAll()
      .then(() => {
        res.json({ ok: true })
      })
      .catch(() => {
        res.status(500).json({ error: 'Internal server error' })
      })
  })

  // --- Collection routes ---

  router.get('/alerts', (req: Request, res: Response) => {
    const manager = deps.getAlertManager()
    if (!manager) {
      res.status(503).json({ error: 'Alert manager not ready' })
      return
    }

    const filter: AlertFilter = {}

    if (typeof req.query.state === 'string') {
      const states = req.query.state.split(',') as AlertState[]
      for (const s of states) {
        if (!VALID_STATES.includes(s)) {
          res.status(400).json({ error: `Invalid state: ${s}` })
          return
        }
      }
      filter.state = states.length === 1 ? states[0] : states
    }

    if (typeof req.query.priority === 'string') {
      const priorities = req.query.priority.split(',') as AlertPriority[]
      for (const p of priorities) {
        if (!VALID_PRIORITIES.includes(p)) {
          res.status(400).json({ error: `Invalid priority: ${p}` })
          return
        }
      }
      filter.priority = priorities.length === 1 ? priorities[0] : priorities
    }

    if (typeof req.query.category === 'string') {
      filter.category = req.query.category
    }

    if (typeof req.query.stale === 'string') {
      if (req.query.stale !== 'true' && req.query.stale !== 'false') {
        res.status(400).json({ error: 'stale must be "true" or "false"' })
        return
      }
      filter.stale = req.query.stale === 'true'
    }

    res.json(manager.getAlerts(filter))
  })

  router.post('/alerts', (req: Request, res: Response) => {
    const manager = deps.getAlertManager()
    if (!manager) {
      res.status(503).json({ error: 'Alert manager not ready' })
      return
    }

    const body = req.body as Record<string, unknown>

    // Validate required fields
    if (body.path === undefined || body.path === null) {
      res.status(400).json({ error: 'path is required' })
      return
    }
    if (typeof body.path !== 'string') {
      res.status(400).json({ error: 'path must be a string' })
      return
    }
    if (body.path.length === 0) {
      res.status(400).json({ error: 'path must not be empty' })
      return
    }
    if (!body.priority) {
      res.status(400).json({ error: 'priority is required' })
      return
    }
    if (
      typeof body.priority !== 'string' ||
      !VALID_PRIORITIES.includes(body.priority as AlertPriority)
    ) {
      res.status(400).json({
        error: `Invalid priority: ${typeof body.priority === 'string' ? body.priority : typeof body.priority}. Must be one of: ${VALID_PRIORITIES.join(', ')}`
      })
      return
    }
    if (body.message === undefined || body.message === null) {
      res.status(400).json({ error: 'message is required' })
      return
    }
    if (typeof body.message !== 'string') {
      res.status(400).json({ error: 'message must be a string' })
      return
    }
    if (body.message.length === 0) {
      res.status(400).json({ error: 'message must not be empty' })
      return
    }
    if (body.message.length > MAX_MESSAGE_LENGTH) {
      res.status(400).json({
        error: `message exceeds maximum length of ${String(MAX_MESSAGE_LENGTH)} characters`
      })
      return
    }

    manager
      .raiseAlert({
        path: body.path,
        $source: typeof body.$source === 'string' ? body.$source : 'rest-api',
        priority: body.priority as AlertPriority,
        message: body.message,
        category: typeof body.category === 'string' ? body.category : undefined,
        data:
          body.data && typeof body.data === 'object' && !Array.isArray(body.data)
            ? (body.data as Record<string, unknown>)
            : undefined,
        latching: typeof body.latching === 'boolean' ? body.latching : undefined
      })
      .then((alert) => {
        res.status(201).json(alert)
      })
      .catch(() => {
        res.status(500).json({ error: 'Internal server error' })
      })
  })

  // --- Parametric routes ---

  router.get('/alerts/:id', (req: Request, res: Response) => {
    const manager = deps.getAlertManager()
    if (!manager) {
      res.status(503).json({ error: 'Alert manager not ready' })
      return
    }

    const alert = manager.getAlert(String(req.params.id))
    if (!alert) {
      res.status(404).json({ error: 'Alert not found' })
      return
    }

    res.json(alert)
  })

  router.post('/alerts/:id/acknowledge', (req: Request, res: Response) => {
    const manager = deps.getAlertManager()
    if (!manager) {
      res.status(503).json({ error: 'Alert manager not ready' })
      return
    }

    const userId = (req as Request & { skPrincipal?: SKPrincipal }).skPrincipal?.identifier

    manager
      .acknowledgeAlert(String(req.params.id), userId)
      .then((result) => {
        res.json({
          alert: result.alert,
          cleared: result.cleared,
          previousState: result.previousState
        })
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.message === 'Alert not found') {
          res.status(404).json({ error: 'Alert not found' })
          return
        }
        res.status(500).json({ error: 'Internal server error' })
      })
  })

  router.post('/alerts/:id/silence', (req: Request, res: Response) => {
    const manager = deps.getAlertManager()
    if (!manager) {
      res.status(503).json({ error: 'Alert manager not ready' })
      return
    }

    const body = req.body as Record<string, unknown> | undefined

    let durationMs: number | undefined
    if (body?.duration !== undefined) {
      if (
        typeof body.duration !== 'number' ||
        !Number.isFinite(body.duration) ||
        body.duration <= 0
      ) {
        res.status(400).json({ error: 'duration must be a finite positive number (seconds)' })
        return
      }
      durationMs = body.duration * 1000
    }

    manager
      .silenceAlert(String(req.params.id), durationMs)
      .then((alert) => {
        res.json(alert)
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.message === 'Alert not found') {
          res.status(404).json({ error: 'Alert not found' })
          return
        }
        res.status(500).json({ error: 'Internal server error' })
      })
  })

  router.put('/alerts/:id/condition', (req: Request, res: Response) => {
    const manager = deps.getAlertManager()
    if (!manager) {
      res.status(503).json({ error: 'Alert manager not ready' })
      return
    }

    const body = req.body as Record<string, unknown>

    if (typeof body.active !== 'boolean') {
      res.status(400).json({ error: 'active must be a boolean' })
      return
    }

    if (body.active) {
      // Setting condition to active is a no-op for existing alerts
      // (re-raising would require full alert params)
      const alert = manager.getAlert(String(req.params.id))
      if (!alert) {
        res.status(404).json({ error: 'Alert not found' })
        return
      }
      res.json({ alert, cleared: false, previousState: alert.state })
      return
    }

    manager
      .clearCondition(String(req.params.id))
      .then((result) => {
        res.json({
          alert: result.alert,
          cleared: result.cleared,
          previousState: result.previousState
        })
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.message === 'Alert not found') {
          res.status(404).json({ error: 'Alert not found' })
          return
        }
        res.status(500).json({ error: 'Internal server error' })
      })
  })
}
