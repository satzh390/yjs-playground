export interface RoomSummary {
  name: string
  updateCount: number
  updateBytes: number
  latestSequence: number
  lastUpdated: string | null
}

export interface RoomUpdate {
  sequence: number
  summary: string
  details: string[]
  bytes: number
  bsonType: string
  subtype: number
  createdAt: string | null
  hex: string
  base64: string
  truncated: boolean
}

export interface RoomDetails {
  room: string
  title: string
  content: string
  updates: RoomUpdate[]
}

export interface BinaryPayload {
  room: string
  sequence: number
  bytes: number
  hex: string
  base64: string
}
