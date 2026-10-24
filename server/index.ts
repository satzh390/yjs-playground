import { Binary, MongoClient, type Document } from 'mongodb'
import express from 'express'
import { createServer } from 'node:http'
import * as Y from '@y/y'
import type { BinaryPayload, RoomDetails, RoomSummary, RoomUpdate } from '../shared/api-types.js'
import { createYjsWebSocketServer } from './websocket.js'

interface StoredUpdate extends Document {
  room: string
  sequence: number
  createdAt?: Date
  update: Binary | Buffer
}

interface RoomState extends Document {
  _id: string
  sequence: number
}

interface AggregatedRoomSummary {
  _id: string
  updateCount: number
  updateBytes: number
  latestSequence: number
  lastUpdated?: Date
}

interface TextChange {
  summary: string
  details: string
}

const mongoUrl = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/yjs'
const client = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 10000 })
await client.connect()
const database = client.db()
const updates = database.collection<StoredUpdate>('updates')
const roomStates = database.collection<RoomState>('room_states')
await updates.createIndex({ room: 1, sequence: 1 }, { unique: true })

const toUpdateBuffer = (update: StoredUpdate['update']): Buffer => {
  if (Buffer.isBuffer(update)) return update
  if (update instanceof Binary) return Buffer.from(update.value())
  throw new Error('Invalid MongoDB update record: update is not BSON binary data')
}

const readSharedText = (sharedText: ReturnType<Y.Doc['get']>): string => sharedText.toDelta().toJSON().children
  ?.flatMap(operation => 'insert' in operation && typeof operation.insert === 'string' ? [operation.insert] : [])
  .join('') || ''

const describeTextChange = (before: string, after: string): TextChange | null => {
  if (before === after) return null
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix++
  }
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++
  }
  const removed = before.slice(prefix, before.length - suffix)
  const inserted = after.slice(prefix, after.length - suffix)
  const excerpt = (text: string): string => {
    const readable = text.replace(/\s+/g, ' ').trim()
    return readable.length > 100 ? `${readable.slice(0, 97)}…` : readable
  }
  if (removed && inserted) {
    return { summary: 'Text edited', details: `Replaced “${excerpt(removed)}” with “${excerpt(inserted)}”.` }
  }
  if (inserted) {
    return { summary: 'Text added', details: `Added “${excerpt(inserted)}”.` }
  }
  return { summary: 'Text removed', details: `Removed “${excerpt(removed)}”.` }
}

const pendingWrites = new Map<string, Promise<void>>()

const persistUpdate = (roomName: string, update: Uint8Array): Promise<void> => {
  const previousWrite = pendingWrites.get(roomName) || Promise.resolve()
  const nextWrite: Promise<void> = previousWrite.then(async () => {
    const state = await roomStates.findOneAndUpdate(
      { _id: roomName },
      { $inc: { sequence: 1 } },
      { upsert: true, returnDocument: 'after' }
    )
    if (!state) throw new Error(`Failed to allocate update sequence for room "${roomName}"`)
    await updates.insertOne({
      room: roomName,
      sequence: state.sequence,
      createdAt: new Date(),
      update: Buffer.from(update)
    })
  })
  pendingWrites.set(roomName, nextWrite)
  nextWrite.catch((error: unknown) => {
    console.error(`Failed to persist update for room "${roomName}"`, error)
    process.exitCode = 1
  })
  return nextWrite
}

const flushRoom = (roomName: string): Promise<void> => pendingWrites.get(roomName) || Promise.resolve()

const loadRoom = async (roomName: string, doc: Y.Doc): Promise<void> => {
  const cursor = updates.find({ room: roomName }).sort({ sequence: 1 })
  for await (const record of cursor) {
    const update = toUpdateBuffer(record.update)
    if (update.length === 0) {
      throw new Error(`Invalid MongoDB update record for room "${roomName}"`)
    }
    Y.applyUpdate(doc, update, 'mongodb-persistence')
  }
}

const app = express()
app.get('/', (_request, response) => response.type('text/plain').send('okay'))
app.get('/health', (_request, response) => response.json({ status: 'ok' }))
app.get('/api/rooms', async (_request, response) => {
  const [roomSummaries, states] = await Promise.all([
    updates.aggregate<AggregatedRoomSummary>([
      {
        $group: {
          _id: '$room',
          updateCount: { $sum: 1 },
          updateBytes: { $sum: { $binarySize: '$update' } },
          latestSequence: { $max: '$sequence' },
          lastUpdated: { $max: '$createdAt' }
        }
      },
      { $sort: { _id: 1 } }
    ]).toArray(),
    roomStates.find({}, { projection: { _id: 1, sequence: 1 } }).toArray()
  ])
  const rooms = new Map<string, RoomSummary>(roomSummaries.map(room => [room._id, {
    name: room._id,
    updateCount: room.updateCount,
    updateBytes: room.updateBytes,
    latestSequence: room.latestSequence,
    lastUpdated: room.lastUpdated?.toISOString() || null
  }]))
  for (const state of states) {
    const room = rooms.get(state._id)
    if (room) {
      room.latestSequence = Math.max(room.latestSequence, state.sequence)
    } else {
      rooms.set(state._id, {
        name: state._id,
        updateCount: 0,
        updateBytes: 0,
        latestSequence: state.sequence,
        lastUpdated: null
      })
    }
  }
  response.json([...rooms.values()])
})
app.get('/api/rooms/:roomName', async (request, response) => {
  const { roomName } = request.params
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(roomName)) {
    return response.status(400).json({ error: 'Invalid room name' })
  }
  const records = await updates.find({ room: roomName }).sort({ sequence: 1 }).toArray()
  const doc = new Y.Doc()
  try {
    let previousTitle = ''
    let previousContent = ''
    const updateDetails: Array<{
      record: StoredUpdate
      update: Buffer
      summary: string
      details: string[]
    }> = []
    for (const record of records) {
      const update = toUpdateBuffer(record.update)
      if (update.length === 0) {
        throw new Error(`Invalid MongoDB update record for room "${roomName}"`)
      }
      Y.applyUpdate(doc, update, 'database-explorer')
      const currentTitle = readSharedText(doc.get('document-title'))
      const currentContent = readSharedText(doc.get('document-content'))
      const changes: TextChange[] = []
      if (currentTitle !== previousTitle) {
        changes.push({
          summary: previousTitle ? 'Document name changed' : 'Document name set',
          details: `Name: “${currentTitle || 'Untitled document'}”.`
        })
      }
      const contentChange = describeTextChange(previousContent, currentContent)
      if (contentChange) changes.push(contentChange)
      updateDetails.push({
        record,
        update,
        summary: changes[0]?.summary || 'Document data updated',
        details: changes.map(change => change.details)
      })
      previousTitle = currentTitle
      previousContent = currentContent
    }
    const roomUpdates: RoomUpdate[] = updateDetails.map(({ record, update, summary, details }) => ({
      sequence: record.sequence,
      summary,
      details,
      bytes: update.length,
      bsonType: record.update instanceof Binary ? 'Binary' : 'Buffer',
      subtype: record.update instanceof Binary ? record.update.sub_type : 0,
      createdAt: record.createdAt?.toISOString() || null,
      hex: update.subarray(0, 64).toString('hex'),
      base64: update.subarray(0, 64).toString('base64'),
      truncated: update.length > 64
    }))
    const roomDetails: RoomDetails = {
      room: roomName,
      title: readSharedText(doc.get('document-title')),
      content: readSharedText(doc.get('document-content')),
      updates: roomUpdates
    }
    response.json(roomDetails)
  } finally {
    doc.destroy()
  }
})
app.get('/api/rooms/:roomName/updates/:sequence', async (request, response) => {
  const { roomName } = request.params
  const sequence = Number(request.params.sequence)
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(roomName) || !Number.isSafeInteger(sequence) || sequence < 1) {
    return response.status(400).json({ error: 'Invalid room name or update sequence' })
  }
  const record = await updates.findOne({ room: roomName, sequence })
  if (!record) return response.status(404).json({ error: 'Update not found' })
  const update = toUpdateBuffer(record.update)
  const payload: BinaryPayload = {
    room: roomName,
    sequence,
    bytes: update.length,
    hex: update.toString('hex'),
    base64: update.toString('base64')
  }
  response.json(payload)
})

const server = createServer(app)
const websocketServer = createYjsWebSocketServer({ loadRoom, persistUpdate, flushRoom })
server.on('upgrade', (request, socket, head) => {
  websocketServer.handleUpgrade(request, socket, head, connection => {
    websocketServer.emit('connection', connection, request)
  })
})

const host = process.env.HOST || 'localhost'
const port = Number.parseInt(process.env.PORT || '1234', 10)
server.listen(port, host, () => {
  console.log(`running at '${host}' on port ${port}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    try {
      await Promise.all([...pendingWrites.values()])
      await client.close()
      process.exit(0)
    } catch (error) {
      console.error('Failed to flush MongoDB updates during shutdown', error)
      process.exit(1)
    }
  })
}
