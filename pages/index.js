'use client'
import { useState } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'

export default function Home() {
    const router = useRouter()
    const [playerName, setPlayerName] = useState('')
    const [roomId, setRoomId] = useState('')
    const [mode, setMode] = useState('1v1')
    const [error, setError] = useState('')

    function generateRoomId() {
        return Math.random().toString(36).substring(2, 7).toUpperCase()
    }

    function handleCreate() {
        const name = playerName.trim()
        if (!name) { setError('Masukkan nama pemain!'); return }
        const id = generateRoomId()
        router.push(`/game/${id}?name=${encodeURIComponent(name)}&mode=${mode}`)
    }

    function handleJoin() {
        const name = playerName.trim()
        const id = roomId.trim().toUpperCase()
        if (!name) { setError('Masukkan nama pemain!'); return }
        if (!id) { setError('Masukkan kode room!'); return }
        router.push(`/game/${id}?name=${encodeURIComponent(name)}`)
    }

    return (
        <>
            <Head>
                <title>🏹 Archery Battle</title>
            </Head>
            <div className="lobby-bg">
                <div className="lobby-card">
                    <div className="logo">🏹</div>
                    <h1 className="title">Archery Battle</h1>
                    <p className="subtitle">Game Panahan Multiplayer — 1v1 atau 2v2 via WiFi</p>

                    <div className="form-group">
                        <label>Nama Pemain</label>
                        <input
                            className="input"
                            placeholder="Nama kamu..."
                            value={playerName}
                            onChange={e => { setPlayerName(e.target.value); setError('') }}
                            maxLength={16}
                            onKeyDown={e => e.key === 'Enter' && handleCreate()}
                        />
                    </div>

                    <div className="form-group">
                        <label>Mode</label>
                        <div className="mode-picker">
                            <button
                                className={`mode-btn ${mode === '1v1' ? 'active' : ''}`}
                                onClick={() => setMode('1v1')}
                            >
                                <span className="mode-icon">⚔️</span>
                                <span className="mode-label">1 vs 1</span>
                                <span className="mode-desc">2 pemain</span>
                            </button>
                            <button
                                className={`mode-btn ${mode === '2v2' ? 'active' : ''}`}
                                onClick={() => setMode('2v2')}
                            >
                                <span className="mode-icon">🛡️</span>
                                <span className="mode-label">2 vs 2</span>
                                <span className="mode-desc">4 pemain</span>
                            </button>
                        </div>
                    </div>

                    <div className="btn-row">
                        <button className="btn btn-primary" onClick={handleCreate}>
                            🏠 Buat Room {mode.toUpperCase()}
                        </button>
                    </div>

                    <div className="divider">
                        <span>— atau bergabung ke room yang ada —</span>
                    </div>

                    <div className="form-group">
                        <label>Kode Room</label>
                        <input
                            className="input"
                            placeholder="Contoh: AB3KX"
                            value={roomId}
                            onChange={e => { setRoomId(e.target.value.toUpperCase()); setError('') }}
                            maxLength={8}
                            onKeyDown={e => e.key === 'Enter' && handleJoin()}
                        />
                    </div>

                    <div className="btn-row">
                        <button className="btn btn-secondary" onClick={handleJoin}>
                            🔗 Gabung Room
                        </button>
                    </div>

                    {error && <p className="error">{error}</p>}

                    <div className="controls-info">
                        <h3>🎮 Kontrol</h3>
                        <div className="controls-grid">
                            <div><kbd>W A S D</kbd> Gerak</div>
                            <div><kbd>Mouse</kbd> Arahkan Panah</div>
                            <div><kbd>Klik Kiri</kbd> Tembak Panah</div>
                            <div>2v2: <kbd>No Friendly Fire</kbd></div>
                        </div>
                    </div>
                </div>
            </div>
        </>
    )
}
