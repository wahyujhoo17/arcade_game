'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import io from 'socket.io-client'

let socket = null

// Mirror urutan map dari server (untuk hint "map berikutnya")
const MAPS_NAMES = ['Benteng', 'Empat Pilar', 'Salib', 'Zigzag', 'Terowongan', 'Tembok Simetri']
const TEAM_COLORS = { Red: '#ef4444', Blue: '#3b82f6', Orange: '#f97316', Purple: '#8b5cf6' }

// ─── DRAW HELPERS ─────────────────────────────────────────────────────────────
function drawObstacles(ctx, obstacles) {
    for (const o of obstacles) {
        // Shadow
        ctx.save()
        ctx.shadowColor = 'rgba(0,0,0,0.4)'
        ctx.shadowBlur = 8
        ctx.shadowOffsetY = 4
        // Stone texture gradient
        const grad = ctx.createLinearGradient(o.x, o.y, o.x + o.w, o.y + o.h)
        grad.addColorStop(0, '#78716c')
        grad.addColorStop(1, '#44403c')
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.roundRect(o.x, o.y, o.w, o.h, 8)
        ctx.fill()
        ctx.strokeStyle = '#292524'
        ctx.lineWidth = 2
        ctx.stroke()
        ctx.restore()

        // Crack detail
        ctx.save()
        ctx.strokeStyle = 'rgba(0,0,0,0.25)'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.moveTo(o.x + o.w * 0.3, o.y + 6)
        ctx.lineTo(o.x + o.w * 0.4, o.y + o.h * 0.5)
        ctx.stroke()
        ctx.restore()
    }
}

function drawPlayer(ctx, p, isMe) {
    if (!p.alive) return

    const R = 20
    const tc = p.color

    // ── 1. Ground shadow ──
    ctx.save()
    ctx.translate(p.x, p.y + 5)
    ctx.scale(1.35, 0.4)
    ctx.beginPath()
    ctx.arc(0, 0, R + 2, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(0,0,0,0.30)'
    ctx.fill()
    ctx.restore()

    // ── 2. "Me" animated selection ring ──
    if (isMe) {
        const t = Date.now() / 500
        const pr = R + 8 + Math.sin(t) * 3.5
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.strokeStyle = tc
        ctx.lineWidth = 2.5
        ctx.globalAlpha = 0.45 + 0.35 * Math.sin(t)
        ctx.beginPath()
        ctx.arc(0, 0, pr, 0, Math.PI * 2)
        ctx.stroke()
        ctx.globalAlpha = 1
        ctx.restore()
    }

    ctx.save()
    ctx.translate(p.x, p.y)

    // ── 3. Body circle ──
    const bodyGrad = ctx.createRadialGradient(-R * 0.28, -R * 0.28, 1, 0, 0, R)
    bodyGrad.addColorStop(0, lightenColor(tc, 65))
    bodyGrad.addColorStop(0.55, tc)
    bodyGrad.addColorStop(1, darkenColor(tc, 45))
    ctx.beginPath()
    ctx.arc(0, 0, R, 0, Math.PI * 2)
    ctx.fillStyle = bodyGrad
    ctx.fill()

    // Belt line (simple horizontal stripe clipped to body)
    ctx.save()
    ctx.clip()
    ctx.fillStyle = darkenColor(tc, 30)
    ctx.fillRect(-R, -3.5, R * 2, 7)
    // Belt buckle
    ctx.fillStyle = '#facc15'
    ctx.fillRect(-3.5, -2.5, 7, 5)
    ctx.restore()

    // Body border
    ctx.strokeStyle = isMe ? '#facc15' : darkenColor(tc, 20)
    ctx.lineWidth = isMe ? 2.5 : 1.8
    ctx.beginPath()
    ctx.arc(0, 0, R, 0, Math.PI * 2)
    ctx.stroke()

    // ── 4. Head (small circle protruding toward the back) ──
    const BACK = p.angle + Math.PI
    const hd = 11  // distance from center to head center
    const hx = Math.cos(BACK) * hd
    const hy = Math.sin(BACK) * hd
    const HR = 8.5

    // Skin
    const hGrad = ctx.createRadialGradient(hx - 2.5, hy - 2.5, 1, hx, hy, HR)
    hGrad.addColorStop(0, '#fde3b6')
    hGrad.addColorStop(1, '#c8855a')
    ctx.beginPath()
    ctx.arc(hx, hy, HR, 0, Math.PI * 2)
    ctx.fillStyle = hGrad
    ctx.fill()
    ctx.strokeStyle = 'rgba(0,0,0,0.22)'
    ctx.lineWidth = 1
    ctx.stroke()

    // Hair cap (back half of head in team color – like a cap/helmet)
    ctx.save()
    ctx.beginPath()
    ctx.arc(hx, hy, HR, BACK - Math.PI * 0.6, BACK + Math.PI * 0.6)
    ctx.lineTo(hx, hy)
    ctx.closePath()
    ctx.fillStyle = darkenColor(tc, 20)
    ctx.fill()
    // Cap rim
    ctx.strokeStyle = lightenColor(tc, 40)
    ctx.lineWidth = 1.2
    ctx.stroke()
    ctx.restore()

    // Face dot (eye on front side)
    const eyeX = hx + Math.cos(p.angle) * 4.5
    const eyeY = hy + Math.sin(p.angle) * 4.5
    ctx.beginPath()
    ctx.arc(eyeX, eyeY, 1.8, 0, Math.PI * 2)
    ctx.fillStyle = '#1e1b1a'
    ctx.fill()

    // ── 5. Bow arm + Recurve bow (rotated to aim direction) ──
    ctx.save()
    ctx.rotate(p.angle)

    const armStart = R * 0.3
    const armEnd = R + 7

    // Forearm
    ctx.strokeStyle = '#bf8a52'
    ctx.lineWidth = 5
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(armStart, 0)
    ctx.lineTo(armEnd, 0)
    ctx.stroke()

    // --- Recurve bow ---
    const bx = armEnd + 2   // bow pivot x
    const bh = 16           // half-height of bow limbs

    // Bow wood (two quadratic limbs)
    ctx.strokeStyle = '#4a2507'
    ctx.lineWidth = 4.5
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(bx, -bh)
    ctx.quadraticCurveTo(bx + 14, -bh * 0.45, bx + 11, 0)
    ctx.quadraticCurveTo(bx + 14, bh * 0.45, bx, bh)
    ctx.stroke()

    // Wood highlight
    ctx.strokeStyle = '#a0683d'
    ctx.lineWidth = 1.5
    ctx.lineCap = 'butt'
    ctx.beginPath()
    ctx.moveTo(bx + 1, -bh + 2)
    ctx.quadraticCurveTo(bx + 9, -bh * 0.4, bx + 7, 0)
    ctx.stroke()

    // Bowstring
    ctx.strokeStyle = 'rgba(240,230,185,0.9)'
    ctx.lineWidth = 1.3
    ctx.beginPath()
    ctx.moveTo(bx, -bh)
    ctx.quadraticCurveTo(bx - 6, 0, bx, bh)
    ctx.stroke()

    // Nocked arrow — shaft
    ctx.strokeStyle = '#8b4c1a'
    ctx.lineWidth = 2.2
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(R, 0)
    ctx.lineTo(bx + 13, 0)
    ctx.stroke()

    // Arrowhead
    ctx.fillStyle = '#c8d4dc'
    ctx.strokeStyle = '#6b7a88'
    ctx.lineWidth = 0.8
    ctx.beginPath()
    ctx.moveTo(bx + 17, 0)
    ctx.lineTo(bx + 12, -3.5)
    ctx.lineTo(bx + 12, 3.5)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()

    // Fletching (two triangular feathers)
    ctx.fillStyle = isMe ? '#fbbf24' : '#e2e8f0'
    for (const sign of [1, -1]) {
        ctx.beginPath()
        ctx.moveTo(R + 1, 0)
        ctx.lineTo(R + 6, sign * 5.5)
        ctx.lineTo(R + 10, 0)
        ctx.closePath()
        ctx.fill()
    }

    ctx.restore()   // bow rotation
    ctx.restore()   // translate

    // ── 6. Name badge ──
    ctx.save()
    const label = p.name + (isMe ? ' ★' : '')
    ctx.font = 'bold 11px Inter, sans-serif'
    const tw = ctx.measureText(label).width
    const pad = 7
    const bw = tw + pad * 2
    const bh2 = 17
    const bxL = p.x - bw / 2
    const byL = p.y - R - 24

    ctx.fillStyle = isMe ? 'rgba(250,204,21,0.93)' : 'rgba(8,12,26,0.83)'
    ctx.beginPath()
    ctx.roundRect(bxL, byL, bw, bh2, 5)
    ctx.fill()
    ctx.strokeStyle = isMe ? '#fbbf24' : tc
    ctx.lineWidth = 1.5
    ctx.stroke()

    ctx.fillStyle = isMe ? '#0a0f1e' : '#f1f5f9'
    ctx.textAlign = 'center'
    ctx.fillText(label, p.x, byL + bh2 - 3)
    ctx.restore()
}

function drawArrow(ctx, arrow) {
    const angle = Math.atan2(arrow.vy, arrow.vx)
    ctx.save()
    ctx.translate(arrow.x, arrow.y)
    ctx.rotate(angle)

    // Motion blur trail
    ctx.save()
    const trailGrad = ctx.createLinearGradient(-22, 0, -4, 0)
    trailGrad.addColorStop(0, 'rgba(200,145,90,0)')
    trailGrad.addColorStop(1, 'rgba(200,145,90,0.35)')
    ctx.strokeStyle = trailGrad
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(-22, 0)
    ctx.lineTo(-4, 0)
    ctx.stroke()
    ctx.restore()

    // Shaft (wood grain look)
    const shaftGrad = ctx.createLinearGradient(0, -1.5, 0, 1.5)
    shaftGrad.addColorStop(0, '#c4874a')
    shaftGrad.addColorStop(0.5, '#a0522d')
    shaftGrad.addColorStop(1, '#7a3b1a')
    ctx.strokeStyle = shaftGrad
    ctx.lineWidth = 3
    ctx.lineCap = 'butt'
    ctx.beginPath()
    ctx.moveTo(-14, 0)
    ctx.lineTo(9, 0)
    ctx.stroke()

    // Arrowhead (metal tip)
    const tipGrad = ctx.createLinearGradient(9, -4, 14, 0)
    tipGrad.addColorStop(0, '#94a3b8')
    tipGrad.addColorStop(0.4, '#e2e8f0')
    tipGrad.addColorStop(1, '#64748b')
    ctx.fillStyle = tipGrad
    ctx.strokeStyle = '#475569'
    ctx.lineWidth = 0.8
    ctx.beginPath()
    ctx.moveTo(15, 0)
    ctx.lineTo(9, -4)
    ctx.lineTo(10.5, 0)
    ctx.lineTo(9, 4)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()

    // Feather fletching (2 sides)
    for (const sign of [1, -1]) {
        ctx.fillStyle = sign > 0 ? 'rgba(239,68,68,0.85)' : 'rgba(255,255,255,0.75)'
        ctx.beginPath()
        ctx.moveTo(-14, 0)
        ctx.quadraticCurveTo(-10, sign * 6, -5, sign * 0.5)
        ctx.lineTo(-5, 0)
        ctx.closePath()
        ctx.fill()
    }

    ctx.restore()
}

function drawHUD(ctx, players, myId, gameW, gameH, mode) {
    const is2v2 = mode === '2v2'
    const HUD_H = is2v2 ? 86 : 56

    // Top bar background
    ctx.fillStyle = 'rgba(0,0,0,0.62)'
    ctx.fillRect(0, 0, gameW, HUD_H)

    if (is2v2) {
        const redTeam = players.filter(p => p.team === 'Red')
        const blueTeam = players.filter(p => p.team === 'Blue')
        redTeam.forEach((p, i) => drawHealthBar(ctx, p, 10, 6 + i * 40, false, p.id === myId))
        blueTeam.forEach((p, i) => drawHealthBar(ctx, p, gameW - 210, 6 + i * 40, true, p.id === myId))
        // Team labels
        ctx.save()
        ctx.font = 'bold 10px Inter, sans-serif'
        ctx.fillStyle = 'rgba(239,68,68,0.8)'
        ctx.textAlign = 'left'
        ctx.fillText('TIM MERAH', 10, HUD_H - 4)
        ctx.fillStyle = 'rgba(59,130,246,0.8)'
        ctx.textAlign = 'right'
        ctx.fillText('TIM BIRU', gameW - 10, HUD_H - 4)
        ctx.restore()
    } else {
        const r = players.find(p => p.team === 'Red')
        const b = players.find(p => p.team === 'Blue')
        if (r) drawHealthBar(ctx, r, 20, 10, false, r.id === myId)
        if (b) drawHealthBar(ctx, b, gameW - 220, 10, true, b.id === myId)
    }

    // Center VS icon
    ctx.save()
    ctx.font = 'bold 20px Inter, sans-serif'
    ctx.fillStyle = '#facc15'
    ctx.textAlign = 'center'
    ctx.shadowColor = 'rgba(0,0,0,0.6)'
    ctx.shadowBlur = 6
    ctx.fillText('⚔', gameW / 2, HUD_H / 2 + 8)
    ctx.restore()
}

function drawHealthBar(ctx, player, x, y, rtl, isMe) {
    const BAR_W = 200
    const BAR_H = 26
    const hp = Math.max(0, player.hp)
    const pct = hp / 100

    // Name
    ctx.save()
    ctx.font = `bold 11px Inter, sans-serif`
    ctx.fillStyle = isMe ? '#facc15' : '#e2e8f0'
    ctx.textAlign = rtl ? 'right' : 'left'
    ctx.fillText(`${player.name} (${player.colorName})`, rtl ? x + BAR_W : x, y + 10)
    ctx.restore()

    // Bar background
    ctx.fillStyle = 'rgba(255,255,255,0.15)'
    ctx.beginPath()
    ctx.roundRect(x, y + 14, BAR_W, BAR_H, 5)
    ctx.fill()

    // HP fill
    const barColor = pct > 0.5 ? '#22c55e' : pct > 0.25 ? '#eab308' : '#ef4444'
    ctx.fillStyle = barColor
    ctx.beginPath()
    const fillW = BAR_W * pct
    if (rtl) {
        ctx.roundRect(x + (BAR_W - fillW), y + 14, fillW, BAR_H, 5)
    } else {
        ctx.roundRect(x, y + 14, fillW, BAR_H, 5)
    }
    ctx.fill()

    // HP text
    ctx.save()
    ctx.font = 'bold 13px Inter, sans-serif'
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.shadowColor = 'rgba(0,0,0,0.7)'
    ctx.shadowBlur = 3
    ctx.fillText(`${hp} HP`, x + BAR_W / 2, y + 14 + BAR_H / 2 + 5)
    ctx.restore()
}

function drawGround(ctx, gameW, gameH) {
    // Base grass gradient
    const bg = ctx.createLinearGradient(0, 0, gameW, gameH)
    bg.addColorStop(0, '#166534')
    bg.addColorStop(0.5, '#15803d')
    bg.addColorStop(1, '#14532d')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, gameW, gameH)

    // Subtle tile pattern (slightly lighter grass squares)
    const TILE = 80
    for (let tx = 0; tx < gameW; tx += TILE) {
        for (let ty = 0; ty < gameH; ty += TILE) {
            const even = ((tx / TILE) + (ty / TILE)) % 2 === 0
            ctx.fillStyle = even ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.04)'
            ctx.fillRect(tx, ty, TILE, TILE)
        }
    }

    // Dirt / mud spots (deterministic, seeded by position)
    const dirtSpots = [
        { x: 160, y: 120 }, { x: 840, y: 110 }, { x: 500, y: 300 },
        { x: 200, y: 440 }, { x: 780, y: 480 }, { x: 350, y: 200 },
        { x: 650, y: 390 }, { x: 100, y: 300 }, { x: 900, y: 300 },
    ]
    for (const d of dirtSpots) {
        const dg = ctx.createRadialGradient(d.x, d.y, 2, d.x, d.y, 28)
        dg.addColorStop(0, 'rgba(120,85,40,0.25)')
        dg.addColorStop(1, 'rgba(120,85,40,0)')
        ctx.fillStyle = dg
        ctx.beginPath()
        ctx.ellipse(d.x, d.y, 28, 18, 0.3, 0, Math.PI * 2)
        ctx.fill()
    }

    // Grass tufts (small V-shapes — deterministic positions)
    const tufts = [
        [90, 80], [240, 150], [460, 70], [710, 130], [880, 90],
        [55, 340], [310, 500], [500, 550], [720, 510], [950, 360],
        [170, 270], [430, 350], [800, 220], [620, 480], [340, 420],
    ]
    ctx.strokeStyle = 'rgba(21,128,61,0.55)'
    ctx.lineWidth = 1.5
    ctx.lineCap = 'round'
    for (const [tx, ty] of tufts) {
        ctx.save()
        ctx.translate(tx, ty)
        for (const ox of [-4, 0, 4]) {
            ctx.beginPath()
            ctx.moveTo(ox, 4)
            ctx.lineTo(ox - 2, -5)
            ctx.stroke()
            ctx.beginPath()
            ctx.moveTo(ox, 4)
            ctx.lineTo(ox + 2, -5)
            ctx.stroke()
        }
        ctx.restore()
    }

    // Vignette (dark edges for arena feel)
    const vig = ctx.createRadialGradient(gameW / 2, gameH / 2, gameH * 0.3, gameW / 2, gameH / 2, gameH * 0.85)
    vig.addColorStop(0, 'rgba(0,0,0,0)')
    vig.addColorStop(1, 'rgba(0,0,0,0.35)')
    ctx.fillStyle = vig
    ctx.fillRect(0, 0, gameW, gameH)
}

function lightenColor(hex, amount) {
    const num = parseInt(hex.replace('#', ''), 16)
    const r = Math.min(255, (num >> 16) + amount)
    const g = Math.min(255, ((num >> 8) & 0xff) + amount)
    const b = Math.min(255, (num & 0xff) + amount)
    return `rgb(${r},${g},${b})`
}

function darkenColor(hex, amount) {
    const num = parseInt(hex.replace('#', ''), 16)
    const r = Math.max(0, (num >> 16) - amount)
    const g = Math.max(0, ((num >> 8) & 0xff) - amount)
    const b = Math.max(0, (num & 0xff) - amount)
    return `rgb(${r},${g},${b})`
}

// ─── COMPONENT ────────────────────────────────────────────────────────────────
export default function GamePage() {
    const router = useRouter()
    const { roomId, name } = router.query

    const canvasRef = useRef(null)
    const gameStateRef = useRef(null)
    const myIdRef = useRef(null)
    const obstaclesRef = useRef([])
    const keysRef = useRef({ w: false, a: false, s: false, d: false })
    const gameDimRef = useRef({ w: 1000, h: 600 })
    const mouseAngleRef = useRef(0)
    const animFrameRef = useRef(null)
    const modeRef = useRef('1v1')

    const [phase, setPhase] = useState('connecting') // connecting | waiting | playing | gameover
    const [statusMsg, setStatusMsg] = useState('Menghubungkan...')
    const [winner, setWinner] = useState(null)
    const [roomCode, setRoomCode] = useState('')
    const [roomPlayers, setRoomPlayers] = useState([])
    const [copied, setCopied] = useState(false)
    const [mapInfo, setMapInfo] = useState(null)   // { name, index, total }
    const [showMapBanner, setShowMapBanner] = useState(false)
    const mapBannerTimerRef = useRef(null)

    // ─── RENDER LOOP ───────────────────────────────────────────────────────────
    const renderLoop = useCallback(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        const state = gameStateRef.current
        const { w, h } = gameDimRef.current
        const myId = myIdRef.current

        drawGround(ctx, w, h)
        drawObstacles(ctx, obstaclesRef.current)

        if (state) {
            for (const arrow of state.arrows) drawArrow(ctx, arrow)
            for (const player of state.players) {
                drawPlayer(ctx, player, player.id === myId)
            }
            drawHUD(ctx, state.players, myId, w, h, modeRef.current)
        }

        animFrameRef.current = requestAnimationFrame(renderLoop)
    }, [])

    // ─── SOCKET SETUP ──────────────────────────────────────────────────────────
    useEffect(() => {
        if (!roomId || !name) return

        setRoomCode(roomId)

        // Connect to server (same host, port 3000)
        socket = io(window.location.origin, { path: '/socket.io' })

        socket.on('connect', () => {
            myIdRef.current = socket.id
            const modeParam = new URLSearchParams(window.location.search).get('mode') || '1v1'
            socket.emit('join_room', { roomId, playerName: name, mode: modeParam })
        })

        socket.on('error_msg', (msg) => {
            setStatusMsg(msg)
            setPhase('error')
        })

        socket.on('waiting', (msg) => {
            setStatusMsg(msg)
            setPhase('waiting')
        })

        socket.on('room_update', ({ players }) => {
            setRoomPlayers(players)
        })

        socket.on('game_start', ({ obstacles, gameW, gameH, mapName, mapIndex, totalMaps, mode }) => {
            obstaclesRef.current = obstacles
            gameDimRef.current = { w: gameW, h: gameH }
            modeRef.current = mode || '1v1'
            myIdRef.current = socket.id
            setMapInfo({ name: mapName, index: mapIndex, total: totalMaps })
            setShowMapBanner(true)
            clearTimeout(mapBannerTimerRef.current)
            mapBannerTimerRef.current = setTimeout(() => setShowMapBanner(false), 2500)
            setPhase('playing')
            setWinner(null)
            gameStateRef.current = null
            // Start render loop
            cancelAnimationFrame(animFrameRef.current)
            animFrameRef.current = requestAnimationFrame(renderLoop)
        })

        socket.on('rematch_start', ({ obstacles, gameW, gameH, mapName, mapIndex, totalMaps, mode }) => {
            obstaclesRef.current = obstacles
            gameDimRef.current = { w: gameW, h: gameH }
            modeRef.current = mode || '1v1'
            gameStateRef.current = null
            setMapInfo({ name: mapName, index: mapIndex, total: totalMaps })
            setShowMapBanner(true)
            clearTimeout(mapBannerTimerRef.current)
            mapBannerTimerRef.current = setTimeout(() => setShowMapBanner(false), 2500)
            setPhase('playing')
            setWinner(null)
            cancelAnimationFrame(animFrameRef.current)
            animFrameRef.current = requestAnimationFrame(renderLoop)
        })

        socket.on('game_state', (state) => {
            gameStateRef.current = state
        })

        socket.on('game_over', (winnerData) => {
            setWinner(winnerData)
            setPhase('gameover')
        })

        socket.on('player_left', ({ message }) => {
            setStatusMsg(message)
            setPhase('waiting')
            gameStateRef.current = null
            cancelAnimationFrame(animFrameRef.current)
        })

        return () => {
            socket.disconnect()
            cancelAnimationFrame(animFrameRef.current)
        }
    }, [roomId, name, renderLoop])

    // ─── KEYBOARD INPUT ────────────────────────────────────────────────────────
    useEffect(() => {
        const MAP = { w: 'w', a: 'a', s: 's', d: 'd', arrowup: 'w', arrowleft: 'a', arrowdown: 's', arrowright: 'd' }

        function onKeyDown(e) {
            const k = MAP[e.key.toLowerCase()]
            if (!k) return
            e.preventDefault()
            if (keysRef.current[k]) return
            keysRef.current[k] = true
            socket?.emit('input_keys', { keys: keysRef.current })
        }

        function onKeyUp(e) {
            const k = MAP[e.key.toLowerCase()]
            if (!k) return
            keysRef.current[k] = false
            socket?.emit('input_keys', { keys: keysRef.current })
        }

        window.addEventListener('keydown', onKeyDown)
        window.addEventListener('keyup', onKeyUp)
        return () => {
            window.removeEventListener('keydown', onKeyDown)
            window.removeEventListener('keyup', onKeyUp)
        }
    }, [])

    // ─── MOUSE INPUT ───────────────────────────────────────────────────────────
    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return

        function onMouseMove(e) {
            if (phase !== 'playing') return
            const state = gameStateRef.current
            const myId = myIdRef.current
            if (!state) return
            const me = state.players.find(p => p.id === myId)
            if (!me) return

            const rect = canvas.getBoundingClientRect()
            const scaleX = gameDimRef.current.w / rect.width
            const scaleY = gameDimRef.current.h / rect.height
            const mx = (e.clientX - rect.left) * scaleX
            const my = (e.clientY - rect.top) * scaleY
            const angle = Math.atan2(my - me.y, mx - me.x)
            mouseAngleRef.current = angle
            socket?.emit('input_angle', { angle })
        }

        function onClick(e) {
            if (phase !== 'playing') return
            e.preventDefault()
            socket?.emit('input_shoot')
        }

        canvas.addEventListener('mousemove', onMouseMove)
        canvas.addEventListener('click', onClick)
        return () => {
            canvas.removeEventListener('mousemove', onMouseMove)
            canvas.removeEventListener('click', onClick)
        }
    }, [phase])

    // ─── TOUCH INPUT (mobile) ──────────────────────────────────────────────────
    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return

        let lastTouch = null

        function onTouchMove(e) {
            e.preventDefault()
            if (phase !== 'playing') return
            const state = gameStateRef.current
            const myId = myIdRef.current
            if (!state) return
            const me = state.players.find(p => p.id === myId)
            if (!me) return
            const touch = e.touches[0]
            const rect = canvas.getBoundingClientRect()
            const scaleX = gameDimRef.current.w / rect.width
            const scaleY = gameDimRef.current.h / rect.height
            const mx = (touch.clientX - rect.left) * scaleX
            const my = (touch.clientY - rect.top) * scaleY
            const angle = Math.atan2(my - me.y, mx - me.x)
            socket?.emit('input_angle', { angle })
            lastTouch = { x: touch.clientX, y: touch.clientY }
        }

        function onTouchEnd() {
            if (phase !== 'playing') return
            socket?.emit('input_shoot')
        }

        canvas.addEventListener('touchmove', onTouchMove, { passive: false })
        canvas.addEventListener('touchend', onTouchEnd)
        return () => {
            canvas.removeEventListener('touchmove', onTouchMove)
            canvas.removeEventListener('touchend', onTouchEnd)
        }
    }, [phase])

    function handleCopyRoom() {
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(roomCode).catch(() => fallbackCopy(roomCode))
        } else {
            fallbackCopy(roomCode)
        }
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    function fallbackCopy(text) {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        try { document.execCommand('copy') } catch (_) { }
        document.body.removeChild(ta)
    }

    function handleRematch() {
        socket?.emit('request_rematch')
    }

    function handleLeave() {
        socket?.disconnect()
        router.push('/')
    }

    const { w: gameW, h: gameH } = gameDimRef.current

    return (
        <>
            <Head>
                <title>🏹 Archery Battle — Room {roomCode}</title>
            </Head>
            <div className="game-wrapper">
                {/* Canvas always rendered (hidden behind overlay when not playing) */}
                <div className="canvas-container">
                    <canvas
                        ref={canvasRef}
                        width={gameW}
                        height={gameH}
                        style={{ display: 'block', width: '100%', height: '100%', cursor: 'crosshair' }}
                    />

                    {/* Room Code badge (top-right overlay) */}
                    {(phase === 'playing' || phase === 'gameover') && (
                        <div className="room-badge" onClick={handleCopyRoom}>
                            🔑 {roomCode} {copied ? '✔' : ''}
                        </div>
                    )}

                    {/* Map banner — muncul singkat saat ronde baru */}
                    {showMapBanner && mapInfo && (
                        <div className="map-banner">
                            <span className="map-banner-sub">Map {mapInfo.index + 1} / {mapInfo.total}</span>
                            <span className="map-banner-name">🗺️ {mapInfo.name}</span>
                        </div>
                    )}

                    {/* Persistent map badge (bottom-right) */}
                    {phase === 'playing' && mapInfo && (
                        <div className="map-badge">
                            🗺️ {mapInfo.name} ({mapInfo.index + 1}/{mapInfo.total})
                        </div>
                    )}

                    {/* Overlays */}
                    {phase === 'connecting' && (
                        <div className="overlay">
                            <div className="overlay-card">
                                <div className="spinner" />
                                <p>Menghubungkan ke server...</p>
                            </div>
                        </div>
                    )}

                    {phase === 'waiting' && (
                        <div className="overlay">
                            <div className="overlay-card">
                                <h2>⏳ Menunggu Lawan</h2>
                                <p>Bagikan kode room ke temanmu:</p>
                                <div className="room-code-big">{roomCode}</div>
                                <button className="btn btn-secondary" onClick={handleCopyRoom}>
                                    {copied ? '✔ Tersalin!' : '📋 Salin Kode'}
                                </button>
                                <div className="players-waiting">
                                    {roomPlayers.map(p => (
                                        <div key={p.id} className="player-tag" style={{ color: TEAM_COLORS[p.colorName] || '#fff' }}>
                                            ● {p.name} ({p.colorName})
                                        </div>
                                    ))}
                                </div>
                                <button className="btn btn-outline" onClick={handleLeave}>← Kembali</button>
                            </div>
                        </div>
                    )}

                    {phase === 'gameover' && (
                        <div className="overlay">
                            <div className="overlay-card gameover-card">
                                <div className="trophy">🏆</div>
                                <h2>
                                    {winner?.color === 'Red' ? '🔴 Tim Merah' :
                                        winner?.color === 'Blue' ? '🔵 Tim Biru' :
                                            '🏹'} Menang!
                                </h2>
                                <p className="winner-sub">{winner?.name}</p>
                                {mapInfo && (
                                    <p className="next-map-hint">
                                        Map berikutnya: <strong>{mapInfo.total > 0 ? MAPS_NAMES[(mapInfo.index + 1) % mapInfo.total] : '?'}</strong>
                                    </p>
                                )}
                                <div className="btn-row">
                                    <button className="btn btn-primary" onClick={handleRematch}>🔄 Main Lagi</button>
                                    <button className="btn btn-outline" onClick={handleLeave}>← Lobby</button>
                                </div>
                            </div>
                        </div>
                    )}

                    {phase === 'error' && (
                        <div className="overlay">
                            <div className="overlay-card">
                                <h2>❌ Error</h2>
                                <p>{statusMsg}</p>
                                <button className="btn btn-outline" onClick={handleLeave}>← Kembali</button>
                            </div>
                        </div>
                    )}
                </div>

                {/* Mobile D-pad overlay (untuk HP/tablet) */}
                {phase === 'playing' && (
                    <div className="dpad-overlay">
                        <div className="dpad">
                            <button className="dpad-btn top" onTouchStart={e => { e.preventDefault(); keysRef.current.w = true; socket?.emit('input_keys', { keys: keysRef.current }) }} onTouchEnd={() => { keysRef.current.w = false; socket?.emit('input_keys', { keys: keysRef.current }) }}>▲</button>
                            <button className="dpad-btn left" onTouchStart={e => { e.preventDefault(); keysRef.current.a = true; socket?.emit('input_keys', { keys: keysRef.current }) }} onTouchEnd={() => { keysRef.current.a = false; socket?.emit('input_keys', { keys: keysRef.current }) }}>◀</button>
                            <button className="dpad-btn right" onTouchStart={e => { e.preventDefault(); keysRef.current.d = true; socket?.emit('input_keys', { keys: keysRef.current }) }} onTouchEnd={() => { keysRef.current.d = false; socket?.emit('input_keys', { keys: keysRef.current }) }}>▶</button>
                            <button className="dpad-btn bottom" onTouchStart={e => { e.preventDefault(); keysRef.current.s = true; socket?.emit('input_keys', { keys: keysRef.current }) }} onTouchEnd={() => { keysRef.current.s = false; socket?.emit('input_keys', { keys: keysRef.current }) }}>▼</button>
                        </div>
                    </div>
                )}
            </div>
        </>
    )
}
