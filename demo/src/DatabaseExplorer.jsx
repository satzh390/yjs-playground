import { useEffect, useState } from 'react'

const BinaryPayload = ({ roomName, update }) => {
  const [payload, setPayload] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const loadPayload = async event => {
    if (!event.currentTarget.open || payload || loading) return
    setLoading(true)
    setError('')
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/updates/${update.sequence}`)
      if (!response.ok) throw new Error(`Could not load binary payload (${response.status})`)
      setPayload(await response.json())
    } catch (loadError) {
      setError(loadError.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <details className="binary-details" onToggle={loadPayload}>
      <summary>Inspect full payload</summary>
      {loading && <span className="payload-status">Loading bytes…</span>}
      {error && <span className="payload-error" role="alert">{error}</span>}
      {!payload && !loading && <span className="payload-status">First 64 bytes: {update.hex}{update.truncated ? '…' : ''}</span>}
      {payload && (
        <>
          <code>Hex ({payload.bytes} bytes): {payload.hex}</code>
          <code>Base64: {payload.base64}</code>
        </>
      )}
    </details>
  )
}

const formatBytes = value => {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

const formatDate = value => value ? `Saved ${new Date(value).toLocaleString()}` : 'Older update · date unavailable'

const DatabaseExplorer = () => {
  const [rooms, setRooms] = useState([])
  const [selectedRoom, setSelectedRoom] = useState('')
  const [documentDetails, setDocumentDetails] = useState(null)
  const [loadingRooms, setLoadingRooms] = useState(true)
  const [loadingDocument, setLoadingDocument] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    document.title = 'Yjs database explorer'
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const loadRooms = async () => {
      try {
        const response = await fetch('/api/rooms', { signal: controller.signal })
        if (!response.ok) throw new Error(`Could not load rooms (${response.status})`)
        const data = await response.json()
        setRooms(data)
        setSelectedRoom(currentRoom => currentRoom || data[0]?.name || '')
      } catch (loadError) {
        if (loadError.name !== 'AbortError') setError(loadError.message)
      } finally {
        if (!controller.signal.aborted) setLoadingRooms(false)
      }
    }
    loadRooms()
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!selectedRoom) {
      setDocumentDetails(null)
      return undefined
    }
    const controller = new AbortController()
    const loadDocument = async () => {
      setLoadingDocument(true)
      setDocumentDetails(null)
      setError('')
      try {
        const response = await fetch(`/api/rooms/${encodeURIComponent(selectedRoom)}`, { signal: controller.signal })
        if (!response.ok) throw new Error(`Could not load room data (${response.status})`)
        setDocumentDetails(await response.json())
      } catch (loadError) {
        if (loadError.name !== 'AbortError') setError(loadError.message)
      } finally {
        if (!controller.signal.aborted) setLoadingDocument(false)
      }
    }
    loadDocument()
    return () => controller.abort()
  }, [selectedRoom])

  const totalUpdates = rooms.reduce((total, room) => total + room.updateCount, 0)
  const totalBytes = rooms.reduce((total, room) => total + room.updateBytes, 0)

  return (
    <main className="explorer-shell">
      <header className="explorer-header">
        <a className="brand" href="/" aria-label="Yjs editor"><span className="brand-mark">Y</span> yjs docs</a>
        <nav className="explorer-nav" aria-label="Main navigation">
          <a href="/">Editor</a>
          <a className="active" href="/database">Database explorer</a>
        </nav>
        <span className="database-connection">MongoDB · yjs</span>
      </header>
      <section className="explorer-content">
        <div className="explorer-heading">
          <div>
            <p className="explorer-eyebrow">LOCAL DEVELOPMENT</p>
            <h1>Yjs database explorer</h1>
            <p className="explorer-description">Read persisted documents and inspect the binary updates that make them collaborative.</p>
          </div>
          <a className="back-to-editor" href="/">Open editor</a>
        </div>

        {error && <p className="explorer-error" role="alert">{error}</p>}

        <div className="database-stats">
          <article className="stat-card">
            <span>Documents (rooms)</span>
            <strong>{rooms.length}</strong>
          </article>
          <article className="stat-card">
            <span>Persisted updates</span>
            <strong>{totalUpdates}</strong>
          </article>
          <article className="stat-card">
            <span>Binary data</span>
            <strong>{formatBytes(totalBytes)}</strong>
          </article>
        </div>

        <div className="explorer-layout">
          <section className="room-panel">
            <div className="panel-heading">
              <h2>Rooms</h2>
              <span>{rooms.length}</span>
            </div>
            {loadingRooms
              ? <p className="empty-state">Loading rooms…</p>
              : rooms.length === 0
                ? <p className="empty-state">No persisted rooms yet. Create a document in the editor.</p>
                : (
                  <div className="room-list">
                    {rooms.map(room => (
                      <button
                        key={room.name}
                        className={`room-item ${selectedRoom === room.name ? 'selected' : ''}`}
                        type="button"
                        onClick={() => setSelectedRoom(room.name)}
                      >
                        <span className="room-item-name">{room.name}</span>
                        <span className="room-item-meta">{room.updateCount} updates · {formatBytes(room.updateBytes)}</span>
                      </button>
                    ))}
                  </div>
                )}
          </section>

          <section className="document-panel">
            {selectedRoom
              ? (
                <>
                  <div className="panel-heading document-panel-heading">
                    <div>
                      <span className="panel-kicker">DOCUMENT CONTENT</span>
                      <h2>{selectedRoom}</h2>
                    </div>
                    <span className="sequence-badge">Seq {rooms.find(room => room.name === selectedRoom)?.latestSequence || 0}</span>
                  </div>
                  {loadingDocument && <p className="empty-state">Replaying stored Yjs updates…</p>}
                  {documentDetails && (
                    <>
                      <div className="readable-document">
                        <div className="readable-title">
                          <span>Document name</span>
                          <strong>{documentDetails.title || 'Untitled document'}</strong>
                        </div>
                        <div className="readable-content">
                          <span>Shared text</span>
                          <pre>{documentDetails.content || 'This document is empty.'}</pre>
                        </div>
                      </div>
                      <div className="updates-heading">
                        <div>
                          <h3>Document change history</h3>
                          <p>Changes below are decoded from saved Yjs updates, in the order they were applied.</p>
                        </div>
                        <span>{documentDetails.updates.length} changes</span>
                      </div>
                      <div className="change-timeline">
                        {documentDetails.updates.map(update => (
                          <article className="change-card" key={update.sequence}>
                            <span className="timeline-marker" aria-hidden="true" />
                            <div className="change-card-content">
                              <div className="change-card-heading">
                                <div>
                                  <span className="change-sequence">Change {update.sequence}</span>
                                  <h4>{update.summary}</h4>
                                </div>
                                <span className="change-date">{formatDate(update.createdAt)}</span>
                              </div>
                              {update.details.map((detail, index) => (
                                <p className="change-description" key={`${update.sequence}-${index}`}>{detail}</p>
                              ))}
                              <details className="technical-details">
                                <summary>Technical details · {formatBytes(update.bytes)}</summary>
                                <div className="technical-metadata">
                                  <span>MongoDB type: {update.bsonType}</span>
                                  <span>Binary subtype: {update.subtype}</span>
                                  <span>Sequence: {update.sequence}</span>
                                </div>
                                <BinaryPayload roomName={selectedRoom} update={update} />
                              </details>
                            </div>
                          </article>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )
              : <p className="empty-state">Create or edit a document to see its stored Yjs updates here.</p>}
          </section>
        </div>
        <p className="explorer-note">This read-only view rebuilds visible text by replaying MongoDB updates through Yjs. It does not modify database records.</p>
      </section>
    </main>
  )
}

export default DatabaseExplorer
