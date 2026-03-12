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
        if (!name) { setError('Masukkan nama pemain terlebih dahulu.'); return }
        const id = generateRoomId()
        router.push(`/game/${id}?name=${encodeURIComponent(name)}&mode=${mode}`)
    }

    function handleJoin() {
        const name = playerName.trim()
        const id = roomId.trim().toUpperCase()
        if (!name) { setError('Masukkan nama pemain terlebih dahulu.'); return }
        if (!id) { setError('Masukkan kode room.'); return }
        router.push(`/game/${id}?name=${encodeURIComponent(name)}`)
    }

    function handlePractice() {
        const name = playerName.trim() || 'Pemain'
        const id = 'SOLO-' + generateRoomId()
        router.push(`/game/${id}?name=${encodeURIComponent(name)}&mode=practice`)
    }

    const MODES = [
        { key: '1v1', label: '1 vs 1', desc: '2 pemain' },
        { key: '2v2', label: '2 vs 2', desc: '4 pemain' },
    ]

    return (
        <>
            <Head>
                <title>Archery Battle</title>
            </Head>
            <div className="lobby-bg">
                <div className="lobby-card">

                    <div className="lobby-header">
                        <div className="lobby-logo">🏹</div>
                        <h1 className="lobby-title">Archery Battle</h1>
                        <p className="lobby-sub">Game panahan multiplayer — 1v1 atau 2v2</p>
                    </div>

                    <div className="section">
                        <label className="field-label">Nama Pemain</label>
                        <input
                            className="field-input"
                            placeholder="Masukkan nama..."
                            value={playerName}
                            onChange={e => { setPlayerName(e.target.value); setError('') }}
                            maxLength={16}
                            onKeyDown={e => e.key === 'Enter' && handleCreate()}
                        />
                    </div>

                    <div className="section">
                        <label className="field-label">Mode Multiplayer</label>
                        <div className="mode-grid">
                            {MODES.map(m => (
                                <button
                                    key={m.key}
                                    className={`mode-card ${mode === m.key ? 'active' : ''}`}
                                    onClick={() => setMode(m.key)}
                                >
                                    <span className="mode-card-label">{m.label}</span>
                                    <span className="mode-card-desc">{m.desc}</span>
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="section">
                        <button className="action-btn primary" onClick={handleCreate}>
                            Buat Room {mode.toUpperCase()}
                        </button>
                    </div>

                    <div className="section-divider">atau bergabung ke room yang ada</div>

                    <div className="section">
                        <label className="field-label">Kode Room</label>
                        <div className="join-row">
                            <input
                                className="field-input"
                                placeholder="Contoh: AB3KX"
                                value={roomId}
                                onChange={e => { setRoomId(e.target.value.toUpperCase()); setError('') }}
                                maxLength={8}
                                onKeyDown={e => e.key === 'Enter' && handleJoin()}
                            />
                            <button className="action-btn secondary join-btn" onClick={handleJoin}>
                                Gabung
                            </button>
                        </div>
                    </div>

                    <div className="section-divider">atau main sendiri</div>

                    <div className="section">
                        <button className="action-btn ghost" onClick={handlePractice}>
                            Mode Latihan (Solo)
                        </button>
                    </div>

                    {error && <p className="field-error">{error}</p>}

                    <div className="controls-panel">
                        <p className="controls-title">Kontrol</p>
                        <div className="controls-list">
                            <div className="control-row"><kbd>W A S D</kbd><span>Gerak</span></div>
                            <div className="control-row"><kbd>Mouse</kbd><span>Arahkan panah</span></div>
                            <div className="control-row"><kbd>Klik Kiri</kbd><span>Tembak</span></div>
                            <div className="control-row"><kbd>2v2</kbd><span>Tidak ada friendly fire</span></div>
                        </div>
                    </div>

                </div>
            </div>
        </>
    )
}
