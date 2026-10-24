import * as awarenessProtocol from '@y/protocols/awareness'
import * as syncProtocol from '@y/protocols/sync'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as Y from '@y/y'
import { WebSocket, WebSocketServer, type RawData } from 'ws'

interface Persistence {
  loadRoom: (roomName: string, doc: Y.Doc) => Promise<void>
  persistUpdate: (roomName: string, update: Uint8Array) => Promise<void>
  flushRoom: (roomName: string) => Promise<void>
}

interface SharedRoom {
  name: string
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  connections: Map<WebSocket, Set<number>>
  initialized: Promise<void>
}

const messageSync = 0
const messageAwareness = 1
const pingInterval = 30000

const toUint8Array = (data: RawData): Uint8Array => {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  return new Uint8Array(data)
}

export const createYjsWebSocketServer = (persistence: Persistence): WebSocketServer => {
  const websocketServer = new WebSocketServer({ noServer: true })
  const rooms = new Map<string, SharedRoom>()

  const send = (connection: WebSocket, message: Uint8Array): void => {
    if (connection.readyState === WebSocket.OPEN) connection.send(message)
  }

  const getRoom = (name: string): SharedRoom => {
    const existing = rooms.get(name)
    if (existing) return existing

    const doc = new Y.Doc()
    const awareness = new awarenessProtocol.Awareness(doc)
    awareness.setLocalState(null)
    const room: SharedRoom = {
      name,
      doc,
      awareness,
      connections: new Map(),
      initialized: Promise.resolve()
    }

    awareness.on('update', ({ added, updated, removed }, origin) => {
      if (origin instanceof WebSocket) {
        const controlledIds = room.connections.get(origin)
        if (controlledIds) {
          added.forEach(clientId => controlledIds.add(clientId))
          removed.forEach(clientId => controlledIds.delete(clientId))
        }
      }
      const changedClients = added.concat(updated, removed)
      if (changedClients.length === 0) return
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageAwareness)
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients)
      )
      const message = encoding.toUint8Array(encoder)
      room.connections.forEach((_ids, connection) => send(connection, message))
    })

    room.initialized = persistence.loadRoom(name, doc).then(() => {
      const updateObservableDoc = doc as unknown as {
        on: (event: 'update', listener: (update: Uint8Array) => void) => void
      }
      updateObservableDoc.on('update', (update: Uint8Array) => {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, messageSync)
        syncProtocol.writeUpdate(encoder, update)
        const message = encoding.toUint8Array(encoder)
        room.connections.forEach((_ids, connection) => send(connection, message))
        void persistence.persistUpdate(name, update).catch((error: unknown) => {
          console.error(`Failed to persist update for room "${name}"`, error)
        })
      })
    }).catch(error => {
      if (rooms.get(name) === room) rooms.delete(name)
      awareness.destroy()
      doc.destroy()
      throw error
    })
    rooms.set(name, room)
    return room
  }

  websocketServer.on('connection', (connection, request) => {
    let roomName: string
    try {
      roomName = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname.slice(1))
    } catch (error) {
      console.error('Invalid WebSocket room path', error)
      connection.close(1008, 'Invalid room name')
      return
    }
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(roomName)) {
      connection.close(1008, 'Invalid room name')
      return
    }

    const room = getRoom(roomName)
    const initialized = room.initialized.then(() => {
      if (connection.readyState !== WebSocket.OPEN) return
      room.connections.set(connection, new Set())

      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageSync)
      syncProtocol.writeSyncStep1(encoder, room.doc)
      send(connection, encoding.toUint8Array(encoder))

      const clientIds = Array.from(room.awareness.getStates().keys())
      if (clientIds.length > 0) {
        const awarenessEncoder = encoding.createEncoder()
        encoding.writeVarUint(awarenessEncoder, messageAwareness)
        encoding.writeVarUint8Array(
          awarenessEncoder,
          awarenessProtocol.encodeAwarenessUpdate(room.awareness, clientIds)
        )
        send(connection, encoding.toUint8Array(awarenessEncoder))
      }
    }).catch((error: unknown) => {
      console.error(`Failed to initialize room "${roomName}"`, error)
      connection.close(1011, 'Failed to initialize room')
    })
    let messageQueue = initialized

    connection.on('message', data => {
      messageQueue = messageQueue.then(() => {
        if (connection.readyState !== WebSocket.OPEN || !room.connections.has(connection)) return
        const decoder = decoding.createDecoder(toUint8Array(data))
        const messageType = decoding.readVarUint(decoder)
        if (messageType === messageSync) {
          const encoder = encoding.createEncoder()
          encoding.writeVarUint(encoder, messageSync)
          syncProtocol.readSyncMessage(decoder, encoder, room.doc, connection)
          if (encoding.length(encoder) > 1) send(connection, encoding.toUint8Array(encoder))
        } else if (messageType === messageAwareness) {
          awarenessProtocol.applyAwarenessUpdate(
            room.awareness,
            decoding.readVarUint8Array(decoder),
            connection
          )
        }
      }).catch((error: unknown) => {
        console.error(`Failed to process WebSocket message for room "${roomName}"`, error)
        connection.close(1011, 'Failed to process message')
      })
    })

    connection.on('close', () => {
      const controlledIds = room.connections.get(connection)
      if (controlledIds) {
        room.connections.delete(connection)
        awarenessProtocol.removeAwarenessStates(room.awareness, Array.from(controlledIds), null)
        void persistence.flushRoom(roomName).then(() => {
          if (room.connections.size === 0 && rooms.get(roomName) === room) {
            rooms.delete(roomName)
            room.awareness.destroy()
            room.doc.destroy()
          }
        }).catch((error: unknown) => {
          console.error(`Failed to flush room "${roomName}"`, error)
        })
      }
    })
    connection.on('error', error => {
      console.error(`WebSocket error for room "${roomName}"`, error)
    })

    let pongReceived = true
    const heartbeat = setInterval(() => {
      if (!pongReceived) {
        connection.close()
        clearInterval(heartbeat)
      } else if (connection.readyState === WebSocket.OPEN) {
        pongReceived = false
        connection.ping()
      }
    }, pingInterval)
    connection.on('pong', () => {
      pongReceived = true
    })
    connection.on('close', () => clearInterval(heartbeat))
  })

  return websocketServer
}
