import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { MongoClient } from 'mongodb'
import * as Y from '@y/y'
import { WebsocketProvider } from '@y/websocket'
import { applyInputChange, readText } from '../demo/src/editor-helpers.ts'

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

const waitFor = async (predicate, description, timeout = 10000) => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    if (await predicate()) return
    await wait(25)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

const findAvailablePort = async () => {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

const startServer = async (port, mongoUrl) => {
  const child = spawn(globalThis.process.execPath, ['--import', 'tsx', './server/index.ts'], {
    cwd: process.cwd(),
    env: { ...globalThis.process.env, HOST: '0.0.0.0', PORT: String(port), MONGO_URL: mongoUrl },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  let startupError = null
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.once('error', error => {
    startupError = error
    output += `${error.message}\n`
  })

  try {
    await waitFor(() => {
      if (startupError !== null) {
        throw new Error(`Could not start WebSocket server:\n${output}`)
      }
      if (child.exitCode !== null) {
        throw new Error(`WebSocket server exited with code ${child.exitCode}:\n${output}`)
      }
      return fetch(`http://127.0.0.1:${port}`).then(response => response.ok).catch(() => false)
    }, 'MongoDB-backed WebSocket server readiness', 30000)
  } catch (error) {
    child.kill()
    throw new Error(`${error.message}\nWebSocket server output:\n${output}`)
  }
  return child
}

const stopServer = async child => {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    wait(10000).then(() => { throw new Error('WebSocket server did not flush and stop') })
  ])
}

const connect = async (url, roomName) => {
  const doc = new Y.Doc()
  const title = doc.get('document-title')
  const content = doc.get('document-content')
  const provider = new WebsocketProvider(url, roomName, doc, {
    WebSocketPolyfill: globalThis.WebSocket,
    disableBc: true
  })
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out syncing room ${roomName}`)), 10000)
    provider.on('sync', isSynced => {
      if (isSynced) {
        clearTimeout(timeout)
        resolve()
      }
    })
    provider.on('connection-error', event => {
      clearTimeout(timeout)
      reject(new Error(`WebSocket connection failed: ${event.message || event.type}`))
    })
  })
  return { doc, title, content, provider }
}

const disconnect = ({ doc, provider }) => {
  provider.destroy()
  doc.destroy()
}

const mongoUrl = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/yjs'
const port = await findAvailablePort()
const url = `ws://127.0.0.1:${port}`
const roomName = `e2e-${Date.now()}-${Math.floor(Math.random() * 100000)}`
const mongo = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 5000 })
const database = mongo.db()
let serverProcess
let firstClient
let secondClient
let isolatedClient
let restoredClient
let mongoConnected = false

try {
  await mongo.connect()
  mongoConnected = true
  serverProcess = await startServer(port, mongoUrl)
  const health = await fetch(`http://127.0.0.1:${port}/health`)
  assert.deepEqual(await health.json(), { status: 'ok' })
  console.log('PASS: Express health endpoint responds')
  firstClient = await connect(url, roomName)
  secondClient = await connect(url, roomName)
  isolatedClient = await connect(url, `${roomName}-other`)

  applyInputChange(firstClient.content, 'Hello, shared world!')
  await waitFor(
    () => readText(secondClient.content) === 'Hello, shared world!',
    'document text to sync from peer one to peer two'
  )

  applyInputChange(secondClient.content, 'Hello, really shared world!')
  await waitFor(
    () => readText(firstClient.content) === 'Hello, really shared world!',
    'document text to sync back from peer two'
  )

  applyInputChange(firstClient.title, 'A shared document')
  await waitFor(
    () => readText(secondClient.title) === 'A shared document',
    'the document title to sync between peers'
  )
  assert.equal(readText(isolatedClient.title), '')
  assert.equal(readText(isolatedClient.content), '')
  console.log('PASS: document text and title synchronize between WebSocket clients')
  console.log('PASS: different room names keep documents separate')

  await waitFor(async () => await database.collection('updates').countDocuments({ room: roomName }) >= 3, 'MongoDB to persist the document updates')
  const roomResponse = await fetch(`http://127.0.0.1:${port}/api/rooms/${roomName}`)
  assert.equal(roomResponse.status, 200)
  const roomDetails = await roomResponse.json()
  assert.equal(roomDetails.title, 'A shared document')
  assert.equal(roomDetails.content, 'Hello, really shared world!')
  assert.equal(roomDetails.updates.length, 3)
  assert.equal(roomDetails.updates[0].summary, 'Text added')
  assert.match(roomDetails.updates[0].details[0], /Hello, shared world!/)
  assert.equal(roomDetails.updates[2].summary, 'Document name set')
  assert.match(roomDetails.updates[2].details[0], /A shared document/)
  assert.ok(roomDetails.updates.every(update => update.createdAt))
  assert.equal(roomDetails.updates[0].bsonType, 'Binary')
  assert.ok(roomDetails.updates[0].hex.length > 0)
  const payloadResponse = await fetch(`http://127.0.0.1:${port}/api/rooms/${roomName}/updates/1`)
  assert.equal(payloadResponse.status, 200)
  const payload = await payloadResponse.json()
  assert.equal(payload.bytes, roomDetails.updates[0].bytes)
  assert.equal(payload.hex.length, payload.bytes * 2)
  assert.ok(payload.base64.length > 0)
  const roomsResponse = await fetch(`http://127.0.0.1:${port}/api/rooms`)
  const rooms = await roomsResponse.json()
  assert.ok(rooms.some(room => room.name === roomName && room.updateCount === 3))
  console.log('PASS: database explorer reconstructs readable documents and binary update metadata')
  disconnect(secondClient)
  secondClient = null
  disconnect(isolatedClient)
  isolatedClient = null
  disconnect(firstClient)
  firstClient = null
  await wait(100)
  await stopServer(serverProcess)
  serverProcess = null

  serverProcess = await startServer(port, mongoUrl)
  restoredClient = await connect(url, roomName)
  assert.equal(readText(restoredClient.title), 'A shared document')
  assert.equal(readText(restoredClient.content), 'Hello, really shared world!')
  console.log('PASS: a server restart restores title and text from MongoDB')
} finally {
  if (restoredClient) disconnect(restoredClient)
  if (secondClient) disconnect(secondClient)
  if (isolatedClient) disconnect(isolatedClient)
  if (firstClient) disconnect(firstClient)
  if (serverProcess) await stopServer(serverProcess)
  if (mongoConnected) {
    await database.collection('updates').deleteMany({ room: roomName })
    await database.collection('room_states').deleteOne({ _id: roomName })
    await database.collection('updates').deleteMany({ room: `${roomName}-other` })
    await database.collection('room_states').deleteOne({ _id: `${roomName}-other` })
    await mongo.close()
  }
}
