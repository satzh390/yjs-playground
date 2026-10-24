import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import * as Y from '@y/y'
import { WebsocketProvider } from '@y/websocket'
import DatabaseExplorer from './DatabaseExplorer.jsx'
import { applyInputChange, readText } from './editor-helpers.js'
import './style.css'

const colors = ['#5967d9', '#de765e', '#34947a', '#b768a4', '#bd8c32', '#4b83b8']
const normalizeRoomName = roomName => roomName.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'quickstart'

const Editor = () => {
  const requestedRoom = new URLSearchParams(location.search).get('room') || 'quickstart'
  const roomName = normalizeRoomName(requestedRoom)
  const docRef = useRef(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [roomInput, setRoomInput] = useState(roomName)
  const [connection, setConnection] = useState({ status: 'connecting', detail: 'Connecting to shared document…' })
  const [collaborators, setCollaborators] = useState([])
  const [shareLabel, setShareLabel] = useState('Share')
  const [shareError, setShareError] = useState('')

  useEffect(() => {
    const doc = new Y.Doc()
    docRef.current = doc
    const sharedTitle = doc.get('document-title')
    const sharedContent = doc.get('document-content')
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const provider = new WebsocketProvider(`${protocol}//${location.hostname}:1234`, roomName, doc, {
      disableBc: true
    })
    const updateTitle = () => setTitle(readText(sharedTitle))
    const updateContent = () => setContent(readText(sharedContent))
    const updateCollaborators = () => {
      const users = [...provider.awareness.getStates().values()]
        .map(state => state.user)
        .filter(user => user && typeof user.name === 'string')
      setCollaborators(users)
    }
    const localName = sessionStorage.getItem('yjs-editor-name') || `Editor ${Math.floor(Math.random() * 900 + 100)}`
    sessionStorage.setItem('yjs-editor-name', localName)
    provider.awareness.setLocalStateField('user', {
      name: localName,
      color: colors[Math.floor(Math.random() * colors.length)]
    })

    sharedTitle.observe(updateTitle)
    sharedContent.observe(updateContent)
    provider.awareness.on('change', updateCollaborators)
    provider.on('status', ({ status }) => {
      setConnection({
        status,
        detail: status === 'connected' ? 'Connected to the shared document' : 'Reconnecting to the shared document…'
      })
    })
    provider.on('sync', isSynced => {
      if (isSynced) {
        setConnection({ status: 'connected', detail: 'Connected · stored in MongoDB' })
      }
    })
    provider.on('connection-error', event => {
      setConnection({
        status: 'disconnected',
        detail: `WebSocket connection failed: ${event.message || event.type}`
      })
    })

    updateTitle()
    updateContent()
    updateCollaborators()

    return () => {
      sharedTitle.unobserve(updateTitle)
      sharedContent.unobserve(updateContent)
      provider.awareness.off('change', updateCollaborators)
      provider.destroy()
      doc.destroy()
      docRef.current = null
    }
  }, [roomName])

  useEffect(() => {
    document.title = `${title || 'Untitled document'} · Yjs`
  }, [title])

  const wordCount = content.trim().split(/\s+/).filter(Boolean).length

  const joinRoom = event => {
    event.preventDefault()
    const nextRoomName = normalizeRoomName(roomInput.trim())
    const parameters = new URLSearchParams(location.search)
    parameters.set('room', nextRoomName)
    location.search = parameters.toString()
  }

  const shareDocument = async () => {
    try {
      await navigator.clipboard.writeText(location.href)
      setShareLabel('Link copied')
      setShareError('')
      setTimeout(() => setShareLabel('Share'), 1600)
    } catch (error) {
      setShareError(`Could not copy the link: ${error.message}`)
    }
  }

  return (
    <main className="shell">
      <header className="hero">
        <a className="brand" href="/" aria-label="Yjs home"><span className="brand-mark">Y</span> yjs docs</a>
        <a className="database-link" href="/database">Database explorer</a>
        <div className="document-heading">
          <label className="document-label" htmlFor="document-title">Document name</label>
          <input
            id="document-title"
            className="document-title"
            aria-label="Document name"
            maxLength={120}
            placeholder="Untitled document"
            value={title}
            onChange={event => {
              setTitle(event.target.value)
              if (docRef.current) applyInputChange(docRef.current.get('document-title'), event.target.value)
            }}
          />
          <div className="room-meta">
            <span className="connection-status" data-status={connection.status}>{connection.status === 'connected' ? 'Connected' : connection.status === 'connecting' ? 'Connecting…' : 'Disconnected'}</span>
            <span className="meta-divider">in room</span>
            <span className="room-name">{roomName}</span>
          </div>
        </div>
        <div className="header-actions">
          <div className="collaborators" aria-label="People in this document">
            {collaborators.map(user => (
              <span
                key={user.name}
                className="avatar"
                title={user.name}
                aria-label={user.name}
                style={{ backgroundColor: colors.includes(user.color) ? user.color : colors[0] }}
              >
                {[...user.name][0]?.toUpperCase() || '?'}
              </span>
            ))}
          </div>
          <form className="room-form" onSubmit={joinRoom}>
            <label className="sr-only" htmlFor="room-input">Room name</label>
            <input
              id="room-input"
              name="room"
              maxLength={80}
              aria-label="Room name"
              autoComplete="off"
              value={roomInput}
              onChange={event => setRoomInput(event.target.value)}
            />
            <button type="submit" className="room-button">Join room</button>
          </form>
          <button className="share-button" type="button" onClick={shareDocument}>{shareLabel}</button>
        </div>
      </header>

      <section className="workspace">
        <nav className="toolbar" aria-label="Document information">
          <span className="toolbar-label">Collaborative document</span>
          <span className="toolbar-hint" role="status">{shareError || connection.detail}</span>
        </nav>
        <div className="paper">
          <textarea
            id="editor"
            aria-label="Document text"
            spellCheck="true"
            placeholder="Start writing…"
            value={content}
            onChange={event => {
              setContent(event.target.value)
              if (docRef.current) applyInputChange(docRef.current.get('document-content'), event.target.value)
            }}
          />
          <div className="paper-footer">
            <span>{wordCount} {wordCount === 1 ? 'word' : 'words'}</span>
            <span>Changes sync automatically</span>
          </div>
        </div>
      </section>
      <p className="footnote">A plain-text editor backed by a shared Yjs document. Open this URL in another tab to collaborate.</p>
    </main>
  )
}

const Page = location.pathname === '/database' ? DatabaseExplorer : Editor

createRoot(document.getElementById('root')).render(<Page />)
