'use strict'

const fp = require('fastify-plugin')
const assert = require('assert')
const eventLoopDelay = require('event-loop-delay')

async function underPressure (fastify, opts) {
  opts = opts || {}

  // TODO: Deprecate opts.sampleInterval.
  const memorySampleInterval = opts.memorySampleInterval || opts.sampleInterval || 5
  const maxEventLoopDelay = opts.maxEventLoopDelay || 0
  const maxHeapUsedBytes = opts.maxHeapUsedBytes || 0
  const maxRssBytes = opts.maxRssBytes || 0
  const healthCheck = opts.healthCheck || false
  const healthCheckInterval = opts.healthCheckInterval || -1

  const checkMaxEventLoopDelay = maxEventLoopDelay > 0
  const checkMaxHeapUsedBytes = maxHeapUsedBytes > 0
  const checkMaxRssBytes = maxRssBytes > 0

  var heapUsed = 0
  var rssBytes = 0
  var eventLoopDelayMs = 0
  var eventLoopSampler = eventLoopDelay()
  // TODO: Get rid of setInterval. It's not a good way to measure things during event loop delay.
  const timer = setInterval(updateMemoryUsage, memorySampleInterval)
  timer.unref()

  var externalsHealthy = false
  var externalHealthCheckTimer
  if (healthCheck) {
    assert(typeof healthCheck === 'function', 'opts.healthCheck should be a function that returns a promise that resolves to true or false')
    assert(healthCheckInterval > 0 || opts.exposeStatusRoute, 'opts.healthCheck requires opts.healthCheckInterval or opts.exposeStatusRoute')

    const doCheck = async () => {
      try {
        externalsHealthy = await healthCheck()
      } catch (error) {
        externalsHealthy = false
        fastify.log.error({ error }, 'external healthCheck function supplied to `under-pressure` threw an error. setting the service status to unhealthy.')
      }
    }

    await doCheck()

    if (healthCheckInterval > 0) {
      externalHealthCheckTimer = setInterval(doCheck, healthCheckInterval)
      externalHealthCheckTimer.unref()
    }
  } else {
    externalsHealthy = true
  }

  fastify.decorate('memoryUsage', memoryUsage)
  fastify.decorate('eventLoopDelay', checkEventLoopDelay)
  fastify.addHook('onClose', onClose)

  if (opts.exposeStatusRoute) {
    fastify.route({
      url: opts.exposeStatusRoute === true ? '/status' : opts.exposeStatusRoute,
      method: 'GET',
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' }
            }
          }
        }
      },
      handler: onStatus
    })
  }

  if (checkMaxEventLoopDelay === false &&
    checkMaxHeapUsedBytes === false &&
    checkMaxRssBytes === false &&
    healthCheck === false) {
    return
  }

  const serviceUnavailableError = new Error(opts.message || 'Service Unavailable')
  const retryAfter = opts.retryAfter || 10

  fastify.addHook('onRequest', onRequest)

  function updateMemoryUsage () {
    var mem = process.memoryUsage()
    heapUsed = mem.heapUsed
    rssBytes = mem.rss
  }

  function onRequest (req, reply, next) {
    eventLoopDelayMs = eventLoopSampler.delay

    if (checkMaxEventLoopDelay && eventLoopDelayMs > maxEventLoopDelay) {
      sendError(reply, next)
      return
    }

    if (checkMaxHeapUsedBytes && heapUsed > maxHeapUsedBytes) {
      sendError(reply, next)
      return
    }

    if (checkMaxRssBytes && rssBytes > maxRssBytes) {
      sendError(reply, next)
      return
    }

    if (!externalsHealthy) {
      sendError(reply, next)
      return
    }

    next()
  }

  function sendError (reply, next) {
    reply.status(503).header('Retry-After', retryAfter)
    next(serviceUnavailableError)
  }

  function memoryUsage () {
    return {
      rssBytes,
      heapUsed
    }
  }

  function checkEventLoopDelay () {
    return {
      'delay': eventLoopSampler.delay,
      'accumulatedDelay': eventLoopSampler.accumulatedDelay,
      'time': eventLoopSampler.time,
      'count': eventLoopSampler.count
    }
  }

  async function onStatus (req, reply) {
    if (healthCheck) {
      try {
        if (!await healthCheck()) {
          req.log.error('external health check failed')
          reply.status(503).header('Retry-After', retryAfter)
          throw serviceUnavailableError
        }
      } catch (err) {
        req.log.error({ err }, 'external health check failed with error')
        reply.status(503).header('Retry-After', retryAfter)
        throw serviceUnavailableError
      }
    }
    return { status: 'ok' }
  }

  function onClose (fastify, done) {
    clearInterval(timer)
    clearInterval(externalHealthCheckTimer)
    done()
  }
}

function now () {
  var ts = process.hrtime()
  return (ts[0] * 1e3) + (ts[1] / 1e6)
}

module.exports = fp(underPressure, {
  fastify: '>=2.0.0',
  name: 'under-pressure'
})
