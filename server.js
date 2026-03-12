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

// ─── POWER-UP CONSTANTS ──────────────────────────────────────────────────────
const ITEM_TYPES = ['bomb', 'triple', 'rapid', 'pierce', 'shield', 'ice', 'medkit', 'homing']
const ITEM_RADIUS = 22
const ITEM_SPAWN_TICKS = 8 * 60   // every 8 seconds
const ITEM_MAX = 2
const ITEM_EXPIRE_MS = 12000       // item disappears if not picked up within 12 s
const ITEM_DURATION = { triple: 14000, rapid: 10000, pierce: 14000, homing: 12000, ice: 14000 }
const BOMB_RADIUS = 120
const BOMB_DAMAGE = 60
const ICE_SLOW_MS = 4000
const ICE_SLOW_FACTOR = 0.35

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
        maxPlayers: mode === '2v2' ? 4 : mode === 'practice' ? 1 : 2,
        players: {},
        arrows: [],
        items: [],
        itemIdCounter: 0,
        itemSpawnTick: 0,
        ticker: 0,
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
        effects: {},     // { triple, rapid, pierce, homing } each = { until: timestamp }
        hasBomb: false,
        hasShield: false,
        slowUntil: 0,
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

// ─── ITEM HELPERS ─────────────────────────────────────────────────────────────
function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]]
    }
    return arr
}

function nextItemType(room) {
    // Refill bag when empty — guarantees 1 of each type per 8 spawns
    if (!room.itemBag || room.itemBag.length === 0) {
        room.itemBag = shuffleArray([...ITEM_TYPES])
    }
    return room.itemBag.pop()
}

function spawnItem(room) {
    if (room.items.length >= ITEM_MAX) return
    for (let attempt = 0; attempt < 40; attempt++) {
        const x = 80 + Math.random() * (GAME_W - 160)
        const y = 80 + Math.random() * (GAME_H - 160)
        let blocked = false
        for (const o of room.obstacles) {
            if (circleRect(x, y, ITEM_RADIUS + 15, o.x, o.y, o.w, o.h)) { blocked = true; break }
        }
        if (!blocked) {
            const type = nextItemType(room)
            room.items.push({ id: room.itemIdCounter++, type, x, y, spawnedAt: Date.now() })
            return
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

        // Tick counter (for item spawning)
        room.ticker = (room.ticker || 0) + 1

        // Update player positions
        for (const p of players) {
            if (!p.alive) continue
            let dx = 0, dy = 0
            if (p.keys.w) dy -= 1
            if (p.keys.s) dy += 1
            if (p.keys.a) dx -= 1
            if (p.keys.d) dx += 1
            if (dx !== 0 && dy !== 0) { dx *= 0.707; dy *= 0.707 }
            // Ice slow effect
            const spd = now < (p.slowUntil || 0) ? PLAYER_SPEED * ICE_SLOW_FACTOR : PLAYER_SPEED
            p.x = Math.max(PLAYER_RADIUS, Math.min(GAME_W - PLAYER_RADIUS, p.x + dx * spd))
            p.y = Math.max(PLAYER_RADIUS, Math.min(GAME_H - PLAYER_RADIUS, p.y + dy * spd))
            p.angle = p.mouseAngle
            resolvePlayerObstacle(p, room.obstacles)
        }

        // Item spawn check
        if (room.ticker % ITEM_SPAWN_TICKS === 0) spawnItem(room)

        // Item expiry: remove items nobody picked up in time, then try to spawn replacement
        const prevLen = room.items.length
        room.items = room.items.filter(item => {
            if (now - item.spawnedAt > ITEM_EXPIRE_MS) {
                io.to(room.id).emit('item_expired', { itemId: item.id })
                return false
            }
            return true
        })
        if (room.items.length < prevLen) spawnItem(room)

        // Item pickup: player walks over item (auto-pickup)
        for (const p of players) {
            if (!p.alive) continue
            room.items = room.items.filter(item => {
                const dx = p.x - item.x, dy = p.y - item.y
                if (dx * dx + dy * dy > (PLAYER_RADIUS + ITEM_RADIUS) ** 2) return true
                // Apply power-up
                switch (item.type) {
                    case 'bomb': p.hasBomb = true; break
                    case 'triple': p.effects.triple = { until: now + ITEM_DURATION.triple }; break
                    case 'rapid': p.effects.rapid = { until: now + ITEM_DURATION.rapid }; break
                    case 'pierce': p.effects.pierce = { until: now + ITEM_DURATION.pierce }; break
                    case 'homing': p.effects.homing = { until: now + ITEM_DURATION.homing }; break
                    case 'shield': p.hasShield = true; break
                    case 'medkit': p.hp = Math.min(MAX_HP, p.hp + 40); break
                    case 'ice': p.effects.ice = { until: now + ITEM_DURATION.ice }; break
                }
                io.to(room.id).emit('item_picked', { playerId: p.id, type: item.type })
                return false
            })
        }

        // Update arrows
        const surviving = []
        for (const arrow of room.arrows) {
            // Homing: steer toward nearest enemy
            if (arrow.homing) {
                const allTargets = [
                    ...players.filter(p => p.id !== arrow.ownerId && p.alive),
                    ...(room.bots || []).filter(b => b.alive && b.id !== arrow.ownerId)
                ]
                let nearDist = Infinity, nearX = 0, nearY = 0
                for (const t of allTargets) {
                    const ddx = t.x - arrow.x, ddy = t.y - arrow.y
                    const d = ddx * ddx + ddy * ddy
                    if (d < nearDist) { nearDist = d; nearX = t.x; nearY = t.y }
                }
                if (nearDist < Infinity) {
                    const ddx = nearX - arrow.x, ddy = nearY - arrow.y
                    const len = Math.sqrt(ddx * ddx + ddy * ddy) || 1
                    arrow.vx += (ddx / len * ARROW_SPEED - arrow.vx) * 0.12
                    arrow.vy += (ddy / len * ARROW_SPEED - arrow.vy) * 0.12
                }
            }

            arrow.x += arrow.vx
            arrow.y += arrow.vy

            // Out of bounds
            if (arrow.x < 0 || arrow.x > GAME_W || arrow.y < 0 || arrow.y > GAME_H) continue

            // Hit obstacle (pierce arrows pass through)
            let hitObstacle = false
            for (const o of room.obstacles) {
                if (
                    arrow.x >= o.x && arrow.x <= o.x + o.w &&
                    arrow.y >= o.y && arrow.y <= o.y + o.h
                ) { hitObstacle = true; break }
            }
            if (hitObstacle && !arrow.pierce) continue

            // Hit player or bot
            let hitSomething = false
            const shooter = room.players[arrow.ownerId]

            // Check hit on real players (only in non-practice)
            if (room.mode !== 'practice') {
                for (const p of players) {
                    if (p.id === arrow.ownerId || !p.alive) continue
                    // No friendly fire in 2v2
                    if (room.mode === '2v2' && shooter && p.team === shooter.team) continue
                    const dx = arrow.x - p.x
                    const dy = arrow.y - p.y
                    if (dx * dx + dy * dy < (PLAYER_RADIUS + 4) ** 2) {
                        if (arrow.hitIds && arrow.hitIds.includes(p.id)) continue
                        // Shield absorbs hit
                        if (p.hasShield) {
                            p.hasShield = false
                            io.to(room.id).emit('shield_blocked', { playerId: p.id })
                            hitSomething = !arrow.pierce
                            if (!arrow.hitIds) arrow.hitIds = []
                            arrow.hitIds.push(p.id)
                            break
                        }
                        p.hp = Math.max(0, p.hp - ARROW_DAMAGE)
                        // Ice arrow slows target
                        if (arrow.ice) p.slowUntil = now + ICE_SLOW_MS
                        if (arrow.hitIds) arrow.hitIds.push(p.id)
                        hitSomething = !arrow.pierce
                        if (p.hp <= 0) {
                            p.alive = false
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
                        if (!arrow.pierce) break
                    }
                }
            }

            // In practice mode: arrows from player hit bots, bot arrows hit player
            if (room.mode === 'practice' && room.bots) {
                const isPlayerArrow = !!room.players[arrow.ownerId]
                if (isPlayerArrow) {
                    for (const bot of room.bots) {
                        if (!bot.alive) continue
                        const dx = arrow.x - bot.x
                        const dy = arrow.y - bot.y
                        if (dx * dx + dy * dy < (PLAYER_RADIUS + 4) ** 2) {
                            bot.hp = Math.max(0, bot.hp - ARROW_DAMAGE)
                            hitSomething = true
                            if (bot.hp <= 0) bot.alive = false
                            // Win if all bots dead
                            if (room.bots.every(b => !b.alive)) {
                                room.winner = { team: 'Red', name: players[0]?.name || 'Pemain', color: '#ef4444' }
                                room.gameStarted = false
                                io.to(room.id).emit('game_over', room.winner)
                            }
                            break
                        }
                    }
                } else {
                    // Bot arrow hits player
                    for (const p of players) {
                        if (!p.alive) continue
                        const dx = arrow.x - p.x
                        const dy = arrow.y - p.y
                        if (dx * dx + dy * dy < (PLAYER_RADIUS + 4) ** 2) {
                            // Shield absorbs the hit
                            if (p.hasShield) {
                                p.hasShield = false
                                io.to(room.id).emit('shield_blocked', { playerId: p.id })
                                hitSomething = true
                                break
                            }
                            p.hp = Math.max(0, p.hp - ARROW_DAMAGE)
                            hitSomething = true
                            if (p.hp <= 0) {
                                p.alive = false
                                room.winner = { team: 'Bot', name: 'Target', color: '#ef4444' }
                                room.gameStarted = false
                                io.to(room.id).emit('game_over', room.winner)
                            }
                            break
                        }
                    }
                }
            }

            if (!hitSomething) surviving.push(arrow)
        }
        room.arrows = surviving


        // Bot AI (practice mode)
        if (room.mode === 'practice' && room.bots && room.gameStarted) {
            const mainPlayer = players[0]
            for (const bot of room.bots) {
                if (!bot.alive) continue
                bot.moveTick = (bot.moveTick || 0) + 1

                // Obstacle-aware patrol: check collision BEFORE moving
                const STEP = 1.5
                const nextY = bot.y + bot.moveDir * STEP
                let blockedY = nextY < PLAYER_RADIUS || nextY > GAME_H - PLAYER_RADIUS
                if (!blockedY) {
                    for (const o of room.obstacles) {
                        if (circleRect(bot.x, nextY, PLAYER_RADIUS, o.x, o.y, o.w, o.h)) {
                            blockedY = true; break
                        }
                    }
                }

                if (blockedY) {
                    // Reverse patrol direction
                    bot.moveDir *= -1
                    // Sidestep in X to get around the obstacle
                    const sideX = bot.id === 'bot1' ? -STEP * 2 : STEP * 2
                    const nextX = bot.x + sideX
                    let blockedX = nextX < PLAYER_RADIUS || nextX > GAME_W - PLAYER_RADIUS
                    if (!blockedX) {
                        for (const o of room.obstacles) {
                            if (circleRect(nextX, bot.y, PLAYER_RADIUS, o.x, o.y, o.w, o.h)) {
                                blockedX = true; break
                            }
                        }
                    }
                    if (!blockedX) bot.x = nextX
                } else {
                    bot.y = nextY
                }

                // Hard clamp (safety)
                bot.x = Math.max(PLAYER_RADIUS, Math.min(GAME_W - PLAYER_RADIUS, bot.x))
                bot.y = Math.max(PLAYER_RADIUS, Math.min(GAME_H - PLAYER_RADIUS, bot.y))

                // Aim at player and shoot every ~1.5s
                if (mainPlayer && mainPlayer.alive) {
                    const dx = mainPlayer.x - bot.x
                    const dy = mainPlayer.y - bot.y
                    bot.angle = Math.atan2(dy, dx)
                    if (bot.moveTick % 90 === 0) {
                        const BOW_DIST = PLAYER_RADIUS + 14
                        room.arrows.push({
                            id: room.arrowIdCounter++,
                            x: bot.x + Math.cos(bot.angle) * BOW_DIST,
                            y: bot.y + Math.sin(bot.angle) * BOW_DIST,
                            vx: Math.cos(bot.angle) * (ARROW_SPEED * 0.85),
                            vy: Math.sin(bot.angle) * (ARROW_SPEED * 0.85),
                            ownerId: bot.id,
                        })
                    }
                }
            }
        }

        // Broadcast state
        const botSnapshot = (room.bots || []).map(b => ({
            id: b.id, name: b.name, x: b.x, y: b.y,
            angle: b.angle, hp: b.hp, alive: b.alive,
            color: b.color, colorName: b.colorName, team: b.team,
        }))
        io.to(room.id).emit('game_state', {
            players: [...players.map(p => ({
                id: p.id, name: p.name, x: p.x, y: p.y,
                angle: p.angle, hp: p.hp, alive: p.alive, color: p.color,
                colorName: p.colorName, team: p.team,
                effects: p.effects, hasBomb: p.hasBomb, hasShield: p.hasShield,
                isSlowed: now < (p.slowUntil || 0),
            })), ...botSnapshot],
            arrows: room.arrows.map(a => ({
                id: a.id, x: a.x, y: a.y, vx: a.vx, vy: a.vy,
                homing: a.homing, pierce: a.pierce, ice: a.ice,
            })),
            items: room.items,
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

                // Practice mode: add 2 bot targets
                if (room.mode === 'practice') {
                    room.bots = [
                        { id: 'bot1', name: 'Target A', x: 750, y: 150, angle: Math.PI, hp: MAX_HP, alive: true, color: '#ef4444', colorName: 'Merah', team: 'Bot', lastShot: 0, moveDir: 1, moveTick: 0 },
                        { id: 'bot2', name: 'Target B', x: 750, y: 450, angle: Math.PI, hp: MAX_HP, alive: true, color: '#8b5cf6', colorName: 'Ungu', team: 'Bot', lastShot: 0, moveDir: -1, moveTick: 0 },
                    ]
                }

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
            const hasRapid = player.effects.rapid && player.effects.rapid.until > now
            const hasTriple = player.effects.triple && player.effects.triple.until > now
            const hasPierce = player.effects.pierce && player.effects.pierce.until > now
            const hasHoming = player.effects.homing && player.effects.homing.until > now
            const hasIce = player.effects.ice && player.effects.ice.until > now

            const reloadMs = hasRapid ? RELOAD_MS / 5 : RELOAD_MS
            if (now - player.lastShot < reloadMs) return
            player.lastShot = now

            const BOW_DIST = PLAYER_RADIUS + 14
            const angles = hasTriple
                ? [player.angle - 0.22, player.angle, player.angle + 0.22]
                : [player.angle]

            for (const ang of angles) {
                room.arrows.push({
                    id: room.arrowIdCounter++,
                    x: player.x + Math.cos(ang) * BOW_DIST,
                    y: player.y + Math.sin(ang) * BOW_DIST,
                    vx: Math.cos(ang) * ARROW_SPEED,
                    vy: Math.sin(ang) * ARROW_SPEED,
                    ownerId: socket.id,
                    pierce: !!hasPierce,
                    homing: !!hasHoming,
                    ice: !!hasIce,
                    hitIds: [],
                })
            }
        })

        // ── INPUT: USE BOMB ────────────────────────────────────────────────────────
        socket.on('use_bomb', () => {
            const room = rooms[socket.data.roomId]
            if (!room || !room.gameStarted) return
            const player = room.players[socket.id]
            if (!player || !player.alive || !player.hasBomb) return
            player.hasBomb = false

            const allTargets = [
                ...Object.values(room.players).filter(p => p.id !== socket.id && p.alive),
                ...(room.bots || []).filter(b => b.alive)
            ]
            for (const t of allTargets) {
                if (room.mode === '2v2' && t.team === player.team) continue
                const ddx = t.x - player.x, ddy = t.y - player.y
                if (ddx * ddx + ddy * ddy < BOMB_RADIUS * BOMB_RADIUS) {
                    t.hp = Math.max(0, t.hp - BOMB_DAMAGE)
                    if (t.hp <= 0) t.alive = false
                }
            }
            io.to(room.id).emit('bomb_explosion', { x: player.x, y: player.y, radius: BOMB_RADIUS })
        })

        // ── REMATCH ────────────────────────────────────────────────────────────────
        socket.on('request_rematch', () => {
            const room = rooms[socket.data.roomId]
            if (!room) return
            if (room.mode !== 'practice' && Object.keys(room.players).length < room.maxPlayers) return

            // Reset
            room.winner = null
            room.arrows = []
            room.arrowIdCounter = 0
            room.items = []
            room.itemIdCounter = 0
            room.itemSpawnTick = 0
            room.itemBag = []
            room.ticker = 0
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
                p.effects = {}
                p.hasBomb = false
                p.hasShield = false
                p.slowUntil = 0
            })
            // Reset bots in practice mode
            if (room.mode === 'practice') {
                room.bots = [
                    { id: 'bot1', name: 'Target A', x: 750, y: 150, angle: Math.PI, hp: MAX_HP, alive: true, color: '#ef4444', colorName: 'Merah', team: 'Bot', lastShot: 0, moveDir: 1, moveTick: 0 },
                    { id: 'bot2', name: 'Target B', x: 750, y: 450, angle: Math.PI, hp: MAX_HP, alive: true, color: '#8b5cf6', colorName: 'Ungu', team: 'Bot', lastShot: 0, moveDir: -1, moveTick: 0 },
                ]
            }
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
