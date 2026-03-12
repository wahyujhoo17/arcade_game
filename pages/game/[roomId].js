'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import io from 'socket.io-client'

let socket = null

// Mirror urutan map dari server (untuk hint "map berikutnya")
const MAPS_NAMES = ['Benteng', 'Empat Pilar', 'Salib', 'Zigzag', 'Terowongan', 'Tembok Simetri']
const TEAM_COLORS = { Red: '#ef4444', Blue: '#3b82f6', Orange: '#f97316', Purple: '#8b5cf6' }

// ─── CHARACTER SPRITES ────────────────────────────────────────────────────────
// Offset sudut sprite (radian). Ubah ke mis. 0.15 atau -0.15 jika busur tidak sejajar.
const SPRITE_ANGLE_OFFSET = 0

// ─── POWER-UP RENDER ──────────────────────────────────────────────────────────
const ITEM_ICONS = { bomb: '💣', triple: '🏹', rapid: '⚡', pierce: '👻', shield: '🛡️', ice: '❄️', medkit: '💊', homing: '🔮' }
const ITEM_GLOW = { bomb: '#ef4444', triple: '#f97316', rapid: '#eab308', pierce: '#8b5cf6', shield: '#3b82f6', ice: '#67e8f9', medkit: '#22c55e', homing: '#a78bfa' }

const ITEM_EXPIRE_MS_CLIENT = 12000  // must match server ITEM_EXPIRE_MS

function drawItems(ctx, items) {
    if (!items || !items.length) return
    const now = Date.now()
    for (const item of items) {
        const age = item.spawnedAt ? now - item.spawnedAt : 0
        const remaining = ITEM_EXPIRE_MS_CLIENT - age
        const expireFrac = Math.max(0, remaining / ITEM_EXPIRE_MS_CLIENT) // 1→0 as it expires

        // Flash when < 4 seconds left
        const isExpiring = remaining < 4000
        const flashAlpha = isExpiring ? 0.45 + 0.55 * Math.abs(Math.sin(now / 180)) : 1

        const bounce = Math.sin(now / 400 + (item.id || 0) * 1.3) * 5
        const glow = ITEM_GLOW[item.type] || '#ffffff'
        const icon = ITEM_ICONS[item.type] || '?'
        const iy = item.y + bounce

        ctx.save()
        ctx.globalAlpha = flashAlpha

        // Glow backdrop
        ctx.save()
        ctx.shadowColor = glow
        ctx.shadowBlur = 22
        ctx.fillStyle = 'rgba(6,10,30,0.78)'
        ctx.beginPath()
        ctx.arc(item.x, iy, 20, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()

        // Pulsing ring
        ctx.save()
        ctx.strokeStyle = glow
        ctx.lineWidth = 2.5
        ctx.globalAlpha = flashAlpha * (0.72 + 0.28 * Math.sin(now / 250 + (item.id || 0)))
        ctx.beginPath()
        ctx.arc(item.x, iy, 20, 0, Math.PI * 2)
        ctx.stroke()
        ctx.restore()

        // Countdown arc showing remaining time (depletes clockwise)
        ctx.save()
        ctx.strokeStyle = isExpiring ? '#f87171' : '#ffffff'
        ctx.lineWidth = 3
        ctx.globalAlpha = flashAlpha * 0.85
        ctx.beginPath()
        ctx.arc(item.x, iy, 26, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * expireFrac)
        ctx.stroke()
        ctx.restore()

        // Emoji icon
        ctx.save()
        ctx.font = '19px serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(icon, item.x, iy)
        ctx.restore()

        ctx.restore()
    }
}

function drawMyEffects(ctx, myPlayer, gameW, gameH) {
    if (!myPlayer) return
    const now = Date.now()
    const eff = myPlayer.effects || {}
    const icons = []
    if (myPlayer.hasBomb) icons.push({ icon: '💣', label: 'BOMB [E]', color: '#ef4444', time: null })
    if (myPlayer.hasShield) icons.push({ icon: '🛡️', label: 'PERISAI', color: '#3b82f6', time: null })
    if (eff.triple && eff.triple.until > now)
        icons.push({ icon: '🏹', label: 'TRIPLE', color: '#f97316', time: ((eff.triple.until - now) / 1000).toFixed(1) })
    if (eff.rapid && eff.rapid.until > now)
        icons.push({ icon: '⚡', label: 'RAPID', color: '#eab308', time: ((eff.rapid.until - now) / 1000).toFixed(1) })
    if (eff.pierce && eff.pierce.until > now)
        icons.push({ icon: '👻', label: 'TEMBUS', color: '#8b5cf6', time: ((eff.pierce.until - now) / 1000).toFixed(1) })
    if (eff.homing && eff.homing.until > now)
        icons.push({ icon: '🔮', label: 'HOMING', color: '#a78bfa', time: ((eff.homing.until - now) / 1000).toFixed(1) })
    if (eff.ice && eff.ice.until > now)
        icons.push({ icon: '❄️', label: 'PANAH ES', color: '#67e8f9', time: ((eff.ice.until - now) / 1000).toFixed(1) })
    if (myPlayer.isSlowed) icons.push({ icon: '🐢', label: 'SLOW', color: '#67e8f9', time: null })
    if (!icons.length) return

    const PW = 68, PH = 52, GAP = 6
    const totalW = icons.length * PW + (icons.length - 1) * GAP
    let sx = gameW / 2 - totalW / 2
    const sy = gameH - 68

    for (const it of icons) {
        ctx.save()
        ctx.fillStyle = 'rgba(5,10,24,0.85)'
        ctx.strokeStyle = it.color + '90'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.roundRect(sx, sy, PW, PH, 10)
        ctx.fill()
        ctx.stroke()
        ctx.font = '19px serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'alphabetic'
        ctx.fillText(it.icon, sx + PW / 2, sy + 22)
        ctx.font = 'bold 7.5px Inter, sans-serif'
        ctx.fillStyle = it.color
        ctx.fillText(it.label, sx + PW / 2, sy + 34)
        if (it.time) {
            ctx.font = 'bold 10px Inter, sans-serif'
            ctx.fillStyle = '#f1f5f9'
            ctx.fillText(it.time + 's', sx + PW / 2, sy + 48)
        }
        ctx.restore()
        sx += PW + GAP
    }
}

function drawExplosions(ctx, explosions) {
    const now = Date.now()
    for (const ex of explosions) {
        const elapsed = now - ex.startTime
        const dur = 500
        if (elapsed > dur) continue
        const t = elapsed / dur
        ctx.save()
        ctx.globalAlpha = (1 - t) * 0.55
        ctx.strokeStyle = '#f97316'
        ctx.lineWidth = 3
        ctx.beginPath()
        ctx.arc(ex.x, ex.y, ex.radius * t, 0, Math.PI * 2)
        ctx.stroke()
        ctx.globalAlpha = (1 - t) * 0.22
        ctx.fillStyle = '#facc15'
        ctx.beginPath()
        ctx.arc(ex.x, ex.y, ex.radius * t, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
    }
}
function drawShieldBlocks(ctx, shieldBlocks, players) {
    const now = Date.now()
    const dur = 600
    for (const sb of shieldBlocks) {
        const elapsed = now - sb.startTime
        if (elapsed > dur) continue
        const t = elapsed / dur
        const p = players.find(pl => pl.id === sb.playerId)
        if (!p) continue
        ctx.save()
        // Expanding blue ring burst
        const radius = 28 + 32 * t
        ctx.globalAlpha = (1 - t) * 0.9
        ctx.strokeStyle = '#60a5fa'
        ctx.lineWidth = 4 - 3 * t
        ctx.beginPath()
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2)
        ctx.stroke()
        // Inner flash fill
        ctx.globalAlpha = (1 - t) * 0.25
        ctx.fillStyle = '#93c5fd'
        ctx.beginPath()
        ctx.arc(p.x, p.y, 28, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
    }
}
const _charImgs = {}
if (typeof window !== 'undefined') {
    ;['c1', 'c2', 'c3', 'c4'].forEach(k => {
        _charImgs[k] = new Image()
        _charImgs[k].src = `/img/${k}.png`
    })
}
// Stable per-player sprite assignment (reset each game session)
const _playerCharMap = {}
const _charKeys = ['c1', 'c2', 'c3', 'c4']
let _charCounter = 0
function getPlayerCharImg(playerId) {
    if (!_playerCharMap[playerId]) {
        _playerCharMap[playerId] = _charKeys[_charCounter % 4]
        _charCounter++
    }
    return _charImgs[_playerCharMap[playerId]]
}

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

    const R = 22
    const SIZE = 72   // rendered sprite size in px
    const tc = p.color

    // ── 1. Ground shadow ──
    ctx.save()
    ctx.translate(p.x, p.y + 6)
    ctx.scale(1.3, 0.35)
    ctx.beginPath()
    ctx.arc(0, 0, R + 4, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.fill()
    ctx.restore()

    // ── 2. "Me" animated selection ring ──
    if (isMe) {
        const t = Date.now() / 500
        const pr = R + 9 + Math.sin(t) * 3.5
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

    // ── 2b. Shield aura ring ──
    if (p.hasShield) {
        const t = Date.now() / 700
        const pulse = Math.sin(t) * 3
        ctx.save()
        ctx.translate(p.x, p.y)
        // Outer glow fill
        ctx.globalAlpha = 0.18 + 0.08 * Math.sin(t)
        ctx.fillStyle = '#3b82f6'
        ctx.beginPath()
        ctx.arc(0, 0, R + 12 + pulse, 0, Math.PI * 2)
        ctx.fill()
        // Ring stroke
        ctx.globalAlpha = 0.75 + 0.2 * Math.sin(t)
        ctx.strokeStyle = '#93c5fd'
        ctx.lineWidth = 2.5
        ctx.shadowColor = '#60a5fa'
        ctx.shadowBlur = 8
        ctx.beginPath()
        ctx.arc(0, 0, R + 11 + pulse, 0, Math.PI * 2)
        ctx.stroke()
        ctx.globalAlpha = 1
        ctx.restore()
    }

    // ── 3. Sprite image — rotate penuh tanpa terbalik ──
    const img = getPlayerCharImg(p.id)
    const half = SIZE / 2
    if (img && img.complete && img.naturalWidth > 0) {
        ctx.save()
        ctx.translate(p.x, p.y)
        if (Math.cos(p.angle) >= 0) {
            // Hadap kanan: rotate normal dengan offset kalibrasi
            ctx.rotate(p.angle + SPRITE_ANGLE_OFFSET)
        } else {
            // Hadap kiri: flip X lalu rotate dengan kalibrasi
            ctx.scale(-1, 1)
            ctx.rotate(Math.PI - p.angle - SPRITE_ANGLE_OFFSET)
        }
        ctx.drawImage(img, -half, -half, SIZE, SIZE)
        ctx.restore()
    } else {
        // Fallback: filled circle while image loads
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.beginPath()
        ctx.arc(0, 0, R, 0, Math.PI * 2)
        ctx.fillStyle = tc
        ctx.fill()
        ctx.strokeStyle = isMe ? '#facc15' : darkenColor(tc, 20)
        ctx.lineWidth = isMe ? 2.5 : 1.8
        ctx.stroke()
        ctx.restore()
    }

    // ── 4. Name badge ──
    ctx.save()
    const label = p.name + (isMe ? ' ★' : '')
    ctx.font = 'bold 11px Inter, sans-serif'
    const tw = ctx.measureText(label).width
    const pad = 7
    const bw = tw + pad * 2
    const bh2 = 17
    const bxL = p.x - bw / 2
    const byL = p.y - half - 10

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

function drawPillBackdrop(ctx, x, y, w, h, accentHex) {
    ctx.save()
    ctx.fillStyle = 'rgba(5,10,24,0.72)'
    ctx.strokeStyle = accentHex + '55'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, 10)
    ctx.fill()
    ctx.stroke()
    ctx.restore()
}

function drawCompactBar(ctx, player, x, y, barW, isMe) {
    const hp = Math.max(0, player.hp)
    const pct = hp / 100
    const BAR_H = 7
    const barColor = pct > 0.5 ? '#22c55e' : pct > 0.25 ? '#eab308' : '#ef4444'

    // Name
    ctx.save()
    ctx.font = `${isMe ? 'bold' : '600'} 11px Inter, sans-serif`
    ctx.fillStyle = isMe ? '#facc15' : '#d1d5db'
    ctx.textAlign = 'left'
    ctx.fillText(player.name, x, y + 11)
    // HP number
    ctx.fillStyle = '#6b7280'
    ctx.font = '10px Inter, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(`${hp}`, x + barW, y + 11)
    ctx.restore()

    // Track
    ctx.fillStyle = 'rgba(255,255,255,0.1)'
    ctx.beginPath()
    ctx.roundRect(x, y + 15, barW, BAR_H, 3)
    ctx.fill()

    // Fill
    if (pct > 0) {
        ctx.fillStyle = barColor
        ctx.beginPath()
        ctx.roundRect(x, y + 15, barW * pct, BAR_H, 3)
        ctx.fill()
    }
}

function drawHUD(ctx, players, myId, gameW, gameH, mode) {
    const isPractice = mode === 'practice'
    const PAD = 10
    const PW = 185    // pill width
    const ROW = 34     // height per player row

    const leftPlayers = isPractice
        ? players.filter(p => p.team !== 'Bot')
        : players.filter(p => p.team === 'Red' || p.team === 'Orange')
    const rightPlayers = isPractice
        ? players.filter(p => p.team === 'Bot')
        : players.filter(p => p.team === 'Blue' || p.team === 'Purple')

    const leftH = Math.max(leftPlayers.length, 1) * ROW + 10
    const rightH = Math.max(rightPlayers.length, 1) * ROW + 10

    // Left pill
    drawPillBackdrop(ctx, PAD, PAD, PW, leftH, '#ef4444')
    leftPlayers.forEach((p, i) =>
        drawCompactBar(ctx, p, PAD + 10, PAD + 8 + i * ROW, PW - 20, p.id === myId)
    )

    // Right pill
    drawPillBackdrop(ctx, gameW - PAD - PW, PAD, PW, rightH, '#3b82f6')
    rightPlayers.forEach((p, i) =>
        drawCompactBar(ctx, p, gameW - PAD - PW + 10, PAD + 8 + i * ROW, PW - 20, p.id === myId)
    )

    // Center VS badge (not in practice)
    if (!isPractice) {
        ctx.save()
        ctx.fillStyle = 'rgba(5,10,24,0.75)'
        ctx.beginPath()
        ctx.roundRect(gameW / 2 - 20, PAD, 40, 28, 8)
        ctx.fill()
        ctx.font = 'bold 12px Inter, sans-serif'
        ctx.fillStyle = '#facc15'
        ctx.textAlign = 'center'
        ctx.fillText('VS', gameW / 2, PAD + 19)
        ctx.restore()
    }
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
    const explosionsRef = useRef([])
    const shieldBlocksRef = useRef([])

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
            drawItems(ctx, state.items || [])
            for (const arrow of state.arrows) drawArrow(ctx, arrow)
            for (const player of state.players) {
                drawPlayer(ctx, player, player.id === myId)
            }
            // Clean expired explosions
            const now = Date.now()
            explosionsRef.current = explosionsRef.current.filter(e => now - e.startTime < 500)
            drawExplosions(ctx, explosionsRef.current)
            // Clean expired shield blocks and draw flash
            shieldBlocksRef.current = shieldBlocksRef.current.filter(sb => now - sb.startTime < 600)
            drawShieldBlocks(ctx, shieldBlocksRef.current, state.players)
            const myPlayer = state.players.find(p => p.id === myId)
            drawMyEffects(ctx, myPlayer, w, h)
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
            // Reset sprite assignment so each game gives fresh unique chars
            Object.keys(_playerCharMap).forEach(k => delete _playerCharMap[k])
            _charCounter = 0
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

        socket.on('bomb_explosion', ({ x, y, radius }) => {
            explosionsRef.current.push({ x, y, radius, startTime: Date.now() })
        })

        socket.on('shield_blocked', ({ playerId }) => {
            shieldBlocksRef.current.push({ playerId, startTime: Date.now() })
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
            // Bomb: E key
            if (e.key.toLowerCase() === 'e') {
                socket?.emit('use_bomb')
                return
            }
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
                            <span className="map-banner-name">{mapInfo.name}</span>
                        </div>
                    )}

                    {/* Persistent map badge (bottom-right) */}
                    {phase === 'playing' && mapInfo && (
                        <div className="map-badge">
                            {mapInfo.name} ({mapInfo.index + 1}/{mapInfo.total})
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
                                <h2>Menunggu Lawan</h2>
                                <p>Bagikan kode room ke temanmu:</p>
                                <div className="room-code-big">{roomCode}</div>
                                <button className="btn btn-secondary" onClick={handleCopyRoom}>
                                    {copied ? 'Tersalin!' : 'Salin Kode'}
                                </button>
                                <div className="players-waiting">
                                    {roomPlayers.map(p => (
                                        <div key={p.id} className="player-tag" style={{ color: TEAM_COLORS[p.colorName] || '#fff' }}>
                                            {p.name} ({p.colorName})
                                        </div>
                                    ))}
                                </div>
                                <button className="btn btn-outline" onClick={handleLeave}>Kembali ke Lobby</button>
                            </div>
                        </div>
                    )}

                    {phase === 'gameover' && (
                        <div className="overlay">
                            <div className="overlay-card gameover-card">
                                <div className="trophy">
                                    {winner?.team === 'Bot' ? '☠' : '★'}
                                </div>
                                <h2>
                                    {winner?.team === 'Bot'
                                        ? 'Kamu Kalah'
                                        : modeRef.current === 'practice'
                                            ? 'Latihan Selesai!'
                                            : winner?.color === 'Red' ? 'Tim Merah Menang'
                                                : winner?.color === 'Blue' ? 'Tim Biru Menang'
                                                    : 'Menang!'}
                                </h2>
                                <p className="winner-sub">{winner?.name}</p>
                                {mapInfo && modeRef.current !== 'practice' && (
                                    <p className="next-map-hint">
                                        Map berikutnya: <strong>{mapInfo.total > 0 ? MAPS_NAMES[(mapInfo.index + 1) % mapInfo.total] : '?'}</strong>
                                    </p>
                                )}
                                <div className="btn-row">
                                    <button className="btn btn-primary" onClick={handleRematch}>
                                        {modeRef.current === 'practice' ? 'Ulangi Latihan' : 'Main Lagi'}
                                    </button>
                                    <button className="btn btn-outline" onClick={handleLeave}>Kembali ke Lobby</button>
                                </div>
                            </div>
                        </div>
                    )}

                    {phase === 'error' && (
                        <div className="overlay">
                            <div className="overlay-card">
                                <h2>Error</h2>
                                <p>{statusMsg}</p>
                                <button className="btn btn-outline" onClick={handleLeave}>Kembali</button>
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
                        <button className="bomb-btn" onTouchStart={e => { e.preventDefault(); socket?.emit('use_bomb') }}>💣</button>
                    </div>
                )}
            </div>
        </>
    )
}
