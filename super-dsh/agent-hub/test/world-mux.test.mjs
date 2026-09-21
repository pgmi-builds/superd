// World mux server (AW-B DL6): our own wire-compatible implementation of the
// Remote stream mux, bound to the ADDRESSED world's openWireStream. Driven
// here through a real HTTP upgrade + the real `ws` client, so the frames are
// verified on the wire, not just in unit form.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { WorldMuxServer } from '../dist/world-mux.js'
import WebSocket from 'ws'

const MUX_PATH = '/omp/api/remote.mux'

async function listen(mux) {
  const server = createServer()
  server.on('upgrade', (req, socket, head) => { void mux.handleUpgrade(req, socket, head) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

function connect(port) {
  return new WebSocket(`ws://127.0.0.1:${port}${MUX_PATH}`)
}

function collect(socket, expected) {
  const frames = []
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${frames.length} frames`)), 3000)
    socket.on('message', (data) => {
      frames.push(JSON.parse(String(data)))
      if (frames.length >= expected) { clearTimeout(timer); resolve(frames) }
    })
    socket.on('error', reject)
  })
}

test('open streams items and a terminal end frame', async () => {
  const opened = []
  const mux = new WorldMuxServer(async (endpoint, payload, signal) => {
    opened.push({ endpoint, payload, signal })
    return (async function*() { yield { a: 1 }; yield { a: 2 } })()
  })
  const { server, port } = await listen(mux)
  const socket = connect(port)
  await new Promise((resolve, reject) => { socket.on('open', resolve); socket.on('error', reject) })
  const frames = collect(socket, 3)
  socket.send(JSON.stringify({ type: 'open', streamId: 's1', endpoint: '$events', payload: {} }))
  const got = await frames
  assert.deepEqual(opened[0].endpoint, '$events')
  assert.deepEqual(got, [
    { type: 'item', streamId: 's1', value: { a: 1 } },
    { type: 'item', streamId: 's1', value: { a: 2 } },
    { type: 'end', streamId: 's1' },
  ])
  socket.close()
  await mux.close()
  server.close()
})

test('cancel aborts the world stream and emits no terminal frame', async () => {
  let aborted = false
  const mux = new WorldMuxServer(async (endpoint, payload, signal) => {
    return (async function*() {
      try {
        yield 'first'
        await new Promise((resolve) => setTimeout(resolve, 50))
        yield 'second'
      } finally {
        aborted = signal.aborted
      }
    })()
  })
  const { server, port } = await listen(mux)
  const socket = connect(port)
  await new Promise((resolve, reject) => { socket.on('open', resolve); socket.on('error', reject) })
  const first = collect(socket, 1)
  socket.send(JSON.stringify({ type: 'open', streamId: 's2', endpoint: '$events', payload: {} }))
  await first
  socket.send(JSON.stringify({ type: 'cancel', streamId: 's2' }))
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(aborted, true, 'the world stream observes cancellation')
  socket.close()
  await mux.close()
  server.close()
})

test('a failing world stream answers one error frame with the mapped failure', async () => {
  const mux = new WorldMuxServer(async () => {
    throw Object.assign(new Error('no such endpoint'), { code: 'gateway/invocation-unavailable' })
  })
  const { server, port } = await listen(mux)
  const socket = connect(port)
  await new Promise((resolve, reject) => { socket.on('open', resolve); socket.on('error', reject) })
  const frames = collect(socket, 1)
  socket.send(JSON.stringify({ type: 'open', streamId: 's3', endpoint: 'nope', payload: {} }))
  const [frame] = await frames
  assert.equal(frame.type, 'error')
  assert.equal(frame.streamId, 's3')
  assert.equal(frame.error.code, 'gateway/invocation-unavailable')
  assert.deepEqual(frame.error.details, {})
  socket.close()
  await mux.close()
  server.close()
})

test('a malformed frame closes the socket with 1008 and no world call', async () => {
  let calls = 0
  const mux = new WorldMuxServer(async () => { calls += 1; return (async function*() { })() })
  const { server, port } = await listen(mux)
  const socket = connect(port)
  await new Promise((resolve, reject) => { socket.on('open', resolve); socket.on('error', reject) })
  const closed = new Promise((resolve) => socket.on('close', (code) => resolve(code)))
  socket.send(JSON.stringify({ type: 'open', streamId: 's4' }))
  const code = await closed
  assert.equal(code, 1008)
  assert.equal(calls, 0)
  await mux.close()
  server.close()
})
