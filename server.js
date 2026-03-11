const { createServer } = require('http')
const { parse } = require('url')
const next = require('next')
const { Server } = require('socket.io')
const os = require('os')

function getLocalIP() {
    const nets = os.networkInterfaces()
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address
            }
        }
    }
    return 'localhost'
}

const dev = process.env.NODE_ENV !== 'production'
const hostname = '0.0.0.0'
const port = parseInt(process.env.PORT || '3000', 10)

const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()

// ─── GAME CONSTANTS ───────────────────────────────────────────────────────────
const GAME_W = 1000
const GAME_H = 600
const PLAYER_RADIUS = 22
const ARROW_SPEED = 11
const PLAYER_SPEED = 4
const ARROW_DAMAGE = 20
const MAX_HP = 100
const RELOAD_MS = 600  // ms between shots
const TICK_RATE = 60   // server ticks per second

// ─── MAPS (rotasi otomatis tiap ronde) ──────────────────────────────────────
const MAPS = [
    {
        name: 'Benteng',
        obstacles: [
            { x: 180, y: 220, w: 60, h: 160 },
            { x: 760, y: 220, w: 60, h: 160 },
            { x: 430, y: 80, w: 140, h: 50 },
            { x: 430, y: 470, w: 140, h: 50 },
            { x: 460, y: 255, w: 80, h: 90 },
        ],
    },
    {
        name: 'Empat Pilar',
        obstacles: [
            { x: 240, y: 160, w: 60, h: 60 },
            { x: 700, y: 160, w: 60, h: 60 },
            { x: 240, y: 380, w: 60, h: 60 },
            { x: 700, y: 380, w: 60, h: 60 },
            { x: 455, y: 260, w: 90, h: 80 },
        ],
    },
    {
        name: 'Salib',
        obstacles: [
            { x: 310, y: 270, w: 380, h: 60 },
            { x: 470, y: 120, w: 60, h: 360 },
        ],
    },
    {
        name: 'Zigzag',
        obstacles: [
            { x: 220, y: 80, w: 60, h: 230 },
            { x: 460, y: 290, w: 60, h: 230 },
            { x: 700, y: 80, w: 60, h: 230 },
        ],
    },
    {
        name: 'Terowongan',
        obstacles: [
            { x: 200, y: 80, w: 600, h: 60 },
            { x: 200, y: 460, w: 600, h: 60 },
            { x: 455, y: 240, w: 90, h: 120 },
        ],
    },
    {
        name: 'Tembok Simetri',
        obstacles: [
            { x: 160, y: 130, w: 70, h: 340 },
            { x: 770, y: 130, w: 70, h: 340 },
            { x: 380, y: 50, w: 60, h: 180 },
            { x: 560, y: 370, w: 60, h: 180 },
        ],
    },
]

// Player configs per spawnIndex (color, colorName, team)
const PLAYER_CONFIGS = [
    { color: '#ef4444', colorName: 'Red', team: 'Red' },  // slot 0
    { color: '#3b82f6', colorName: 'Blue', team: 'Blue' },  // slot 1
    { color: '#f97316', colorName: 'Orange', team: 'Red' },  // slot 2 (2v2 only)
    { color: '#8b5cf6', colorName: 'Purple', team: 'Blue' },  // slot 3 (2v2 only)
]

// Spawn positions: [left-top, right-top, left-bot, right-bot]
const SPAWN_POSITIONS = [
    { x: 100, y: GAME_H * 0.33, angle: 0 },
    { x: GAME_W - 100, y: GAME_H * 0.33, angle: Math.PI },
    { x: 100, y: GAME_H * 0.67, angle: 0 },
    { x: GAME_W - 100, y: GAME_H * 0.67, angle: Math.PI },
]

// ─── STATE ────────────────────────────────────────────────────────────────────
const rooms = {}

function createRoom(roomId, mode = '1v1') {
    return {
        id: roomId,
        mode,
        maxPlayers: mode === '2v2' ? 4 : 2,
        players: {},   // socketId -> playerState
        arrows: [],
        gameStarted: false,
        winner: null,
        loopInterval: null,
        arrowIdCounter: 0,
        mapIndex: 0,
        obstacles: MAPS[0].obstacles,
    }
}

function createPlayer(socketId, name, spawnIndex) {
    const cfg = PLAYER_CONFIGS[spawnIndex] || PLAYER_CONFIGS[0]
    const spawn = SPAWN_POSITIONS[spawnIndex] || SPAWN_POSITIONS[0]
    return {
        id: socketId,
        name,
        x: spawn.x,
        y: spawn.y,
        angle: spawn.angle,
        hp: MAX_HP,
        alive: true,
        color: cfg.color,
        colorName: cfg.colorName,
        team: cfg.team,
        keys: { w: false, a: false, s: false, d: false },
        mouseAngle: spawn.angle,
        lastShot: 0,
        spawnIndex,
    }
}

// ─── COLLISION HELPERS ────────────────────────────────────────────────────────
function circleRect(cx, cy, cr, rx, ry, rw, rh) {
    const nearX = Math.max(rx, Math.min(cx, rx + rw))
    const nearY = Math.max(ry, Math.min(cy, ry + rh))
    const dx = cx - nearX
    const dy = cy - nearY
    return dx * dx + dy * dy < cr * cr
}

function rectOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by
}

function resolvePlayerObstacle(player, obstacles) {
    for (const o of obstacles) {
        if (circleRect(player.x, player.y, PLAYER_RADIUS, o.x, o.y, o.w, o.h)) {
            // push player out of obstacle
            const cx = o.x + o.w / 2
            const cy = o.y + o.h / 2
            const dx = player.x - cx
            const dy = player.y - cy
            const len = Math.sqrt(dx * dx + dy * dy) || 1
            // find nearest edge distance
            const overlapX = (o.w / 2 + PLAYER_RADIUS) - Math.abs(dx)
            const overlapY = (o.h / 2 + PLAYER_RADIUS) - Math.abs(dy)
            if (overlapX < overlapY) {
                player.x += dx > 0 ? overlapX : -overlapX
            } else {
                player.y += dy > 0 ? overlapY : -overlapY
            }
        }
    }
}

// ─── GAME LOOP ────────────────────────────────────────────────────────────────
function startGameLoop(room, io) {
    if (room.loopInterval) clearInterval(room.loopInterval)

    room.loopInterval = setInterval(() => {
        if (!room.gameStarted || room.winner) return

        const now = Date.now()
        const players = Object.values(room.players)

        // Update player positions
        for (const p of players) {
            if (!p.alive) continue
            let dx = 0, dy = 0
            if (p.keys.w) dy -= 1
            if (p.keys.s) dy += 1
            if (p.keys.a) dx -= 1
            if (p.keys.d) dx += 1
            if (dx !== 0 && dy !== 0) {
                dx *= 0.707
                dy *= 0.707
            }
            p.x = Math.max(PLAYER_RADIUS, Math.min(GAME_W - PLAYER_RADIUS, p.x + dx * PLAYER_SPEED))
            p.y = Math.max(PLAYER_RADIUS, Math.min(GAME_H - PLAYER_RADIUS, p.y + dy * PLAYER_SPEED))
            p.angle = p.mouseAngle
            resolvePlayerObstacle(p, room.obstacles)
        }

        // Update arrows
        const surviving = []
        for (const arrow of room.arrows) {
            arrow.x += arrow.vx
            arrow.y += arrow.vy

            // Out of bounds
            if (arrow.x < 0 || arrow.x > GAME_W || arrow.y < 0 || arrow.y > GAME_H) continue

            // Hit obstacle
            let hitObstacle = false
            for (const o of room.obstacles) {
                // Arrow tip
                if (
                    arrow.x >= o.x && arrow.x <= o.x + o.w &&
                    arrow.y >= o.y && arrow.y <= o.y + o.h
                ) {
                    hitObstacle = true
                    break
                }
            }
            if (hitObstacle) continue

            // Hit player
            let hitPlayer = false
            const shooter = room.players[arrow.ownerId]
            for (const p of players) {
                if (p.id === arrow.ownerId || !p.alive) continue
                // No friendly fire in 2v2
                if (room.mode === '2v2' && shooter && p.team === shooter.team) continue
                const dx = arrow.x - p.x
                const dy = arrow.y - p.y
                if (dx * dx + dy * dy < (PLAYER_RADIUS + 4) ** 2) {
                    p.hp = Math.max(0, p.hp - ARROW_DAMAGE)
                    hitPlayer = true
                    if (p.hp <= 0) {
                        p.alive = false
                        // Team-based win check
                        const teamsAlive = {}
                        for (const pl of players) {
                            if (pl.alive) teamsAlive[pl.team] = (teamsAlive[pl.team] || 0) + 1
                        }
                        const aliveTeams = Object.keys(teamsAlive)
                        if (aliveTeams.length <= 1) {
                            if (aliveTeams.length === 1) {
                                const winTeam = aliveTeams[0]
                                const winNames = players.filter(pl => pl.team === winTeam).map(pl => pl.name)
                                room.winner = { team: winTeam, name: winNames.join(' & '), color: winTeam }
                            } else {
                                room.winner = { team: 'Draw', name: 'Seri!', color: 'Draw' }
                            }
                            room.gameStarted = false
                            io.to(room.id).emit('game_over', room.winner)
                        }
                    }
                    break
                }
            }
            if (!hitPlayer) surviving.push(arrow)
        }
        room.arrows = surviving

        // Broadcast state
        io.to(room.id).emit('game_state', {
            players: players.map(p => ({
                id: p.id, name: p.name, x: p.x, y: p.y,
                angle: p.angle, hp: p.hp, alive: p.alive, color: p.color,
                colorName: p.colorName, team: p.team,
            })),
            arrows: room.arrows.map(a => ({
                id: a.id, x: a.x, y: a.y, vx: a.vx, vy: a.vy,
            })),
        })
    }, 1000 / TICK_RATE)
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
app.prepare().then(() => {
    const httpServer = createServer((req, res) => {
        const parsedUrl = parse(req.url, true)
        handle(req, res, parsedUrl)
    })

    const io = new Server(httpServer, {
        cors: { origin: '*' },
    })

    io.on('connection', (socket) => {
        console.log('[+] connected:', socket.id)

        // ── JOIN ROOM ──────────────────────────────────────────────────────────────
        socket.on('join_room', ({ roomId, playerName, mode }) => {
            // mode hanya dipakai saat room pertama kali dibuat
            if (!rooms[roomId]) rooms[roomId] = createRoom(roomId, mode || '1v1')
            const room = rooms[roomId]

            const playerCount = Object.keys(room.players).length
            if (playerCount >= room.maxPlayers) {
                socket.emit('error_msg', `Room penuh! Maksimal ${room.maxPlayers} pemain.`)
                return
            }

            const spawnIndex = playerCount
            const player = createPlayer(socket.id, playerName || `Pemain ${spawnIndex + 1}`, spawnIndex)
            room.players[socket.id] = player
            socket.join(roomId)
            socket.data.roomId = roomId

            io.to(roomId).emit('room_update', {
                players: Object.values(room.players).map(p => ({
                    id: p.id, name: p.name, colorName: p.colorName, team: p.team, spawnIndex: p.spawnIndex,
                })),
                mode: room.mode,
                maxPlayers: room.maxPlayers,
                gameStarted: room.gameStarted,
            })

            // Start game when all required players join
            if (Object.keys(room.players).length === room.maxPlayers) {
                room.gameStarted = true
                room.winner = null
                io.to(roomId).emit('game_start', {
                    obstacles: room.obstacles,
                    mapName: MAPS[room.mapIndex].name,
                    mapIndex: room.mapIndex,
                    totalMaps: MAPS.length,
                    gameW: GAME_W,
                    gameH: GAME_H,
                    mode: room.mode,
                    myId: socket.id,
                })
                startGameLoop(room, io)
            } else {
                const need = room.maxPlayers - Object.keys(room.players).length
                socket.emit('waiting', `Menunggu ${need} pemain lagi bergabung...`)
            }
        })

        // ── INPUT: MOVE KEYS ───────────────────────────────────────────────────────
        socket.on('input_keys', ({ keys }) => {
            const room = rooms[socket.data.roomId]
            if (!room) return
            const player = room.players[socket.id]
            if (!player || !player.alive) return
            player.keys = keys
        })

        // ── INPUT: MOUSE ANGLE ─────────────────────────────────────────────────────
        socket.on('input_angle', ({ angle }) => {
            const room = rooms[socket.data.roomId]
            if (!room) return
            const player = room.players[socket.id]
            if (!player || !player.alive) return
            player.mouseAngle = angle
        })

        // ── INPUT: SHOOT ───────────────────────────────────────────────────────────
        socket.on('input_shoot', () => {
            const room = rooms[socket.data.roomId]
            if (!room || !room.gameStarted) return
            const player = room.players[socket.id]
            if (!player || !player.alive) return

            const now = Date.now()
            if (now - player.lastShot < RELOAD_MS) return
            player.lastShot = now

            const BOW_DIST = PLAYER_RADIUS + 8
            room.arrows.push({
                id: room.arrowIdCounter++,
                x: player.x + Math.cos(player.angle) * BOW_DIST,
                y: player.y + Math.sin(player.angle) * BOW_DIST,
                vx: Math.cos(player.angle) * ARROW_SPEED,
                vy: Math.sin(player.angle) * ARROW_SPEED,
                ownerId: socket.id,
            })
        })

        // ── REMATCH ────────────────────────────────────────────────────────────────
        socket.on('request_rematch', () => {
            const room = rooms[socket.data.roomId]
            if (!room) return
            if (Object.keys(room.players).length < room.maxPlayers) return

            // Reset
            room.winner = null
            room.arrows = []
            room.arrowIdCounter = 0
            const playerList = Object.values(room.players)
            playerList.forEach((p, i) => {
                const spawn = SPAWN_POSITIONS[p.spawnIndex] || SPAWN_POSITIONS[i % 2]
                p.x = spawn.x
                p.y = spawn.y
                p.hp = MAX_HP
                p.alive = true
                p.keys = { w: false, a: false, s: false, d: false }
                p.mouseAngle = spawn.angle
                p.angle = spawn.angle
                p.lastShot = 0
            })
            // Rotasi ke map berikutnya
            room.mapIndex = (room.mapIndex + 1) % MAPS.length
            room.obstacles = MAPS[room.mapIndex].obstacles
            room.gameStarted = true
            io.to(room.id).emit('rematch_start', {
                obstacles: room.obstacles,
                mapName: MAPS[room.mapIndex].name,
                mapIndex: room.mapIndex,
                totalMaps: MAPS.length,
                gameW: GAME_W,
                gameH: GAME_H,
                mode: room.mode,
            })
            startGameLoop(room, io)
        })

        // ── DISCONNECT ─────────────────────────────────────────────────────────────
        socket.on('disconnect', () => {
            const roomId = socket.data.roomId
            if (!roomId || !rooms[roomId]) return
            const room = rooms[roomId]

            delete room.players[socket.id]
            clearInterval(room.loopInterval)
            room.gameStarted = false
            room.arrows = []

            if (Object.keys(room.players).length === 0) {
                delete rooms[roomId]
                console.log(`[x] Room ${roomId} dihapus`)
            } else {
                io.to(roomId).emit('player_left', { message: 'Lawan meninggalkan game.' })
            }

            console.log('[-] disconnected:', socket.id)
        })
    })

    httpServer.listen(port, hostname, () => {
        const localIP = getLocalIP()
        console.log(`\n🎯 Archery Game Server berjalan!`)
        console.log(`   ► Lokal  : http://localhost:${port}`)
        console.log(`   ► WiFi   : http://${localIP}:${port}  ← bagikan ke teman`)
        console.log(`   (Pastikan perangkat lain terhubung ke WiFi yang sama)\n`)
    })
})
