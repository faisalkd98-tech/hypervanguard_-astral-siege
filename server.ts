import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { authDatabase } from './server/authDatabase.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = Number(process.env.PORT || (process.env.NODE_ENV === 'production' ? 7860 : 3000));
const MAX_PLAYERS = 8;
const WORLD_WIDTH = 2600;
const WORLD_HEIGHT = 1500;
const TARGET_KILLS = 10;
const MATCH_SECONDS = 180;
const SNAPSHOT_MS = 50;

type MatchStatus = 'in_progress' | 'ended';

interface PilotState {
  id: string;
  name: string;
  shipId: string;
  isBot: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  health: number;
  maxHealth: number;
  shield: number;
  maxShield: number;
  isDashing: boolean;
  kills: number;
  deaths: number;
  score: number;
  isAlive: boolean;
  respawnTimer: number;
  invulnerableTimer: number;
  fireCooldown: number;
}

interface PlayerClient extends PilotState {
  ws: WebSocket;
  pilotId?: string;
  region: string;
  roomId: string | null;
  lastPing: number;
}

interface Room {
  id: string;
  players: Map<string, PlayerClient>;
  bots: Map<string, PilotState>;
  targetKills: number;
  status: MatchStatus;
  startedAt: number;
  lastSnapshotAt: number;
}

interface ClaimedPilot {
  pilotId: string;
  originalName: string;
  claimedAt: number;
}

const connectedClients = new Map<WebSocket, PlayerClient>();
const matchmakingQueue: PlayerClient[] = [];
const activeRooms = new Map<string, Room>();

const registeredUsernames = new Map<string, ClaimedPilot>();
const DATA_DIR = path.join(__dirname, 'data');
const CALLSIGNS_FILE = path.join(DATA_DIR, 'claimed_callsigns.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadClaimedUsernames() {
  try {
    ensureDataDir();
    if (!fs.existsSync(CALLSIGNS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(CALLSIGNS_FILE, 'utf-8'));
    for (const [key, val] of Object.entries(data)) {
      registeredUsernames.set(key.toLowerCase(), val as ClaimedPilot);
    }
    console.log(`[Multiplayer] Loaded ${registeredUsernames.size} claimed call signs.`);
  } catch (err) {
    console.warn('[Multiplayer] Could not load claimed call signs:', err);
  }
}

function saveClaimedUsernames() {
  try {
    ensureDataDir();
    const obj: Record<string, ClaimedPilot> = {};
    for (const [key, val] of registeredUsernames.entries()) obj[key] = val;
    fs.writeFileSync(CALLSIGNS_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[Multiplayer] Could not persist claimed call signs:', err);
  }
}

loadClaimedUsernames();

const BOT_NAMES = [
  'Viper-9', 'AstralGhost', 'CyberTitan', 'NovaStriker',
  'Vortex-7', 'IronClad', 'ShadowAce', 'Valkyrie-X',
  'HyperPulse', 'SolEclipse', 'StarReaper', 'ApexPredator'
];

const BOT_SHIPS = ['vanguard', 'striker', 'titan'];
const SHIP_STATS: Record<string, { health: number; shield: number; speed: number }> = {
  vanguard: { health: 100, shield: 80, speed: 380 },
  striker: { health: 75, shield: 60, speed: 460 },
  titan: { health: 160, shield: 120, speed: 310 },
};

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function randomSpawn(index = 0) {
  const angle = (index / MAX_PLAYERS) * Math.PI * 2;
  return {
    x: WORLD_WIDTH / 2 + Math.cos(angle) * 480,
    y: WORLD_HEIGHT / 2 + Math.sin(angle) * 330,
  };
}

function safeName(name: unknown, fallback: string) {
  const trimmed = String(name || '').trim().slice(0, 16);
  return trimmed || fallback;
}

function isUsernameTaken(name: string, pilotId?: string, excludeClientId?: string) {
  const trimmed = name.trim();
  const dbCheck = authDatabase.checkUsernameAvailability(trimmed, pilotId);
  if (!dbCheck.available) return { taken: true, reason: dbCheck.reason };

  const lower = trimmed.toLowerCase();
  const claimed = registeredUsernames.get(lower);
  if (claimed && (!pilotId || claimed.pilotId !== pilotId)) {
    return { taken: true, reason: `Call sign "${claimed.originalName}" is already claimed.` };
  }

  for (const client of connectedClients.values()) {
    if (client.id !== excludeClientId && client.name.toLowerCase() === lower) {
      if (!pilotId || client.pilotId !== pilotId) {
        return { taken: true, reason: `Call sign "${trimmed}" is currently in use.` };
      }
    }
  }
  return { taken: false };
}

function pilotSnapshot(p: PilotState) {
  return {
    id: p.id,
    name: p.name,
    shipId: p.shipId,
    isBot: p.isBot,
    x: p.x,
    y: p.y,
    vx: p.vx,
    vy: p.vy,
    angle: p.angle,
    health: p.health,
    maxHealth: p.maxHealth,
    shield: p.shield,
    maxShield: p.maxShield,
    isDashing: p.isDashing,
    kills: p.kills,
    deaths: p.deaths,
    score: p.score,
    isAlive: p.isAlive,
    respawnTimer: Math.max(0, p.respawnTimer),
    invulnerableTimer: Math.max(0, p.invulnerableTimer),
  };
}

function getAllPilots(room: Room) {
  return [
    ...Array.from(room.players.values()).map(pilotSnapshot),
    ...Array.from(room.bots.values()).map(pilotSnapshot),
  ];
}

function send(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcastRoom(room: Room, payload: unknown, exceptId?: string) {
  const encoded = JSON.stringify(payload);
  for (const p of room.players.values()) {
    if (p.id !== exceptId && p.ws.readyState === WebSocket.OPEN) p.ws.send(encoded);
  }
}

function broadcastSnapshot(room: Room) {
  const elapsed = Math.max(0, (Date.now() - room.startedAt) / 1000);
  const timeRemaining = Math.max(0, MATCH_SECONDS - elapsed);
  broadcastRoom(room, {
    type: 'room_snapshot',
    roomId: room.id,
    timeRemaining,
    pilots: getAllPilots(room),
  });
}

function removeFromQueue(client: PlayerClient) {
  const idx = matchmakingQueue.findIndex(p => p.id === client.id);
  if (idx >= 0) matchmakingQueue.splice(idx, 1);
}

function broadcastQueueStatus() {
  const payload = {
    type: 'queue_status',
    count: matchmakingQueue.length,
    maxCount: MAX_PLAYERS,
    players: matchmakingQueue.map(p => ({
      id: p.id,
      name: p.name,
      shipId: p.shipId,
    })),
  };
  const encoded = JSON.stringify(payload);
  for (const p of matchmakingQueue) {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(encoded);
  }
}

function createBot(index: number): PilotState {
  const shipId = BOT_SHIPS[index % BOT_SHIPS.length];
  const cfg = SHIP_STATS[shipId];
  const spawn = randomSpawn(index + 1);
  return {
    id: `bot_${index + 1}`,
    name: BOT_NAMES[index] || `DronePilot-${index + 1}`,
    shipId,
    isBot: true,
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    angle: Math.atan2(WORLD_HEIGHT / 2 - spawn.y, WORLD_WIDTH / 2 - spawn.x),
    health: cfg.health,
    maxHealth: cfg.health,
    shield: cfg.shield,
    maxShield: cfg.shield,
    isDashing: false,
    kills: 0,
    deaths: 0,
    score: 0,
    isAlive: true,
    respawnTimer: 0,
    invulnerableTimer: 0.8,
    fireCooldown: 0.7 + Math.random() * 0.4,
  };
}

function createRoom(roomPlayers: PlayerClient[], neededBots: number) {
  const roomId = `room_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
  const bots = new Map<string, PilotState>();

  roomPlayers.forEach((p, index) => {
    p.roomId = roomId;
    p.kills = 0;
    p.deaths = 0;
    p.score = 0;
    p.isAlive = true;
    p.respawnTimer = 0;
    p.invulnerableTimer = 0.8;
    const spawn = randomSpawn(index);
    p.x = spawn.x;
    p.y = spawn.y;
    p.vx = 0;
    p.vy = 0;
  });

  for (let i = 0; i < neededBots; i++) {
    const bot = createBot(i);
    bots.set(bot.id, bot);
  }

  const room: Room = {
    id: roomId,
    players: new Map(roomPlayers.map(p => [p.id, p])),
    bots,
    targetKills: TARGET_KILLS,
    status: 'in_progress',
    startedAt: Date.now(),
    lastSnapshotAt: 0,
  };

  activeRooms.set(roomId, room);

  const pilots = getAllPilots(room);
  for (const p of room.players.values()) {
    send(p.ws, {
      type: 'match_start',
      roomId,
      targetKills: TARGET_KILLS,
      worldWidth: WORLD_WIDTH,
      worldHeight: WORLD_HEIGHT,
      pilots,
    });
  }
  broadcastSnapshot(room);
}

function findPilot(room: Room, id: string): PilotState | null {
  return room.players.get(id) || room.bots.get(id) || null;
}

function respawnPilot(pilot: PilotState, index = 0) {
  const spawn = randomSpawn(index + Math.floor(Math.random() * 3));
  pilot.x = clamp(spawn.x, 40, WORLD_WIDTH - 40);
  pilot.y = clamp(spawn.y, 40, WORLD_HEIGHT - 40);
  pilot.vx = 0;
  pilot.vy = 0;
  pilot.health = pilot.maxHealth;
  pilot.shield = pilot.maxShield;
  pilot.isAlive = true;
  pilot.respawnTimer = 0;
  pilot.invulnerableTimer = 2.5;
}

function finishRoom(room: Room, winnerId?: string) {
  if (room.status === 'ended') return;
  room.status = 'ended';

  const leaderboard = getAllPilots(room).sort((a, b) => {
    if (b.kills !== a.kills) return b.kills - a.kills;
    if (a.deaths !== b.deaths) return a.deaths - b.deaths;
    return b.score - a.score;
  });

  const winner = winnerId
    ? leaderboard.find(p => p.id === winnerId) || leaderboard[0]
    : leaderboard[0];

  broadcastRoom(room, {
    type: 'match_end',
    winnerId: winner?.id || null,
    leaderboard,
    timeRemaining: Math.max(0, MATCH_SECONDS - (Date.now() - room.startedAt) / 1000),
  });

  for (const p of room.players.values()) p.roomId = null;
  activeRooms.delete(room.id);
}

function applyAuthoritativeDamage(room: Room, shooterId: string, targetId: string, rawDamage: number, weapon = 'Plasma Torpedo') {
  if (room.status !== 'in_progress') return;
  if (shooterId === targetId) return;

  const shooter = findPilot(room, shooterId);
  const target = findPilot(room, targetId);
  if (!shooter || !target || !shooter.isAlive || !target.isAlive) return;
  if (target.invulnerableTimer > 0) return;

  // Basic server-side range validation prevents a client from damaging a
  // player anywhere in the arena while still allowing normal projectile travel.
  if (Math.hypot(shooter.x - target.x, shooter.y - target.y) > 1250) return;

  const damage = clamp(Math.round(Number(rawDamage) || 0), 1, 100);
  if (!damage) return;

  let remaining = damage;
  const absorbed = Math.min(target.shield, remaining);
  target.shield -= absorbed;
  remaining -= absorbed;
  if (remaining > 0) target.health -= remaining;

  const killed = target.health <= 0;
  if (killed) {
    target.health = 0;
    target.shield = 0;
    target.isAlive = false;
    target.deaths += 1;
    target.respawnTimer = 3;

    shooter.kills += 1;
    shooter.score += 100;

    broadcastRoom(room, {
      type: 'authoritative_damage',
      targetPilotId: target.id,
      shooterId,
      damage,
      shieldDamage: absorbed,
      healthDamage: remaining,
      health: target.health,
      shield: target.shield,
      isAlive: false,
      respawnTimer: target.respawnTimer,
    });

    broadcastRoom(room, {
      type: 'pilot_killed',
      killerId: shooter.id,
      killerName: shooter.name,
      victimId: target.id,
      victimName: target.name,
      weapon,
      killerKills: shooter.kills,
      killerScore: shooter.score,
      victimDeaths: target.deaths,
    });

    if (shooter.kills >= room.targetKills) {
      finishRoom(room, shooter.id);
      return;
    }
  } else {
    broadcastRoom(room, {
      type: 'authoritative_damage',
      targetPilotId: target.id,
      shooterId,
      damage,
      shieldDamage: absorbed,
      healthDamage: remaining,
      health: target.health,
      shield: target.shield,
      isAlive: true,
      respawnTimer: 0,
    });
  }
}

function simulateBots(room: Room, dt: number) {
  const pilots = [
    ...Array.from(room.players.values()),
    ...Array.from(room.bots.values()),
  ];

  for (const bot of room.bots.values()) {
    if (!bot.isAlive) {
      continue;
    }

    if (bot.invulnerableTimer > 0) bot.invulnerableTimer -= dt;
    if (bot.fireCooldown > 0) bot.fireCooldown -= dt;

    let target: PilotState | null = null;
    let closest = Infinity;
    for (const candidate of pilots) {
      if (candidate.id === bot.id || !candidate.isAlive) continue;
      const d = Math.hypot(candidate.x - bot.x, candidate.y - bot.y);
      if (d < closest) {
        closest = d;
        target = candidate;
      }
    }
    if (!target) continue;

    const targetAngle = Math.atan2(target.y - bot.y, target.x - bot.x);
    let diff = targetAngle - bot.angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const maxTurn = 3.2 * dt;
    bot.angle += clamp(diff, -maxTurn, maxTurn);

    const cfg = SHIP_STATS[bot.shipId] || SHIP_STATS.vanguard;
    const thrust = closest > 360 ? 1 : 0.55;
    bot.vx += Math.cos(bot.angle) * cfg.speed * 3.2 * thrust * dt;
    bot.vy += Math.sin(bot.angle) * cfg.speed * 3.2 * thrust * dt;

    const speed = Math.hypot(bot.vx, bot.vy);
    const maxSpeed = cfg.speed * 0.9;
    if (speed > maxSpeed) {
      bot.vx = (bot.vx / speed) * maxSpeed;
      bot.vy = (bot.vy / speed) * maxSpeed;
    }

    bot.vx *= Math.pow(0.92, dt * 60);
    bot.vy *= Math.pow(0.92, dt * 60);
    bot.x = clamp(bot.x + bot.vx * dt, 32, WORLD_WIDTH - 32);
    bot.y = clamp(bot.y + bot.vy * dt, 32, WORLD_HEIGHT - 32);

    if (closest < 850 && Math.abs(diff) < 0.18 && bot.fireCooldown <= 0) {
      bot.fireCooldown = 0.42 + Math.random() * 0.2;
      bot.invulnerableTimer = 0;
      broadcastRoom(room, {
        type: 'remote_pilot_shoot',
        pilotId: bot.id,
        x: bot.x + Math.cos(bot.angle) * 28,
        y: bot.y + Math.sin(bot.angle) * 28,
        vx: Math.cos(bot.angle) * 720,
        vy: Math.sin(bot.angle) * 720,
        damage: 18,
        color: '#f43f5e',
      });

      // Server-side hitscan validation for bots. The projectile is still rendered
      // client-side, while the damage itself is authoritative here.
      const targetDistance = Math.hypot(target.x - bot.x, target.y - bot.y);
      if (targetDistance < 820) {
        let aimDiff = Math.atan2(target.y - bot.y, target.x - bot.x) - bot.angle;
        while (aimDiff > Math.PI) aimDiff -= Math.PI * 2;
        while (aimDiff < -Math.PI) aimDiff += Math.PI * 2;
        if (Math.abs(aimDiff) < 0.18) {
          applyAuthoritativeDamage(room, bot.id, target.id, 18, 'AI Plasma Cannon');
        }
      }
    }
  }
}

function roomTick() {
  const now = Date.now();

  for (const room of Array.from(activeRooms.values())) {
    if (room.status !== 'in_progress') continue;

    const elapsed = (now - room.startedAt) / 1000;
    if (elapsed >= MATCH_SECONDS) {
      finishRoom(room);
      continue;
    }

    // Respawn timers are server-authoritative for both humans and bots.
    for (const pilot of [...room.players.values(), ...room.bots.values()]) {
      if (!pilot.isAlive) {
        pilot.respawnTimer -= 0.05;
        if (pilot.respawnTimer <= 0) {
          respawnPilot(pilot, Math.floor(Math.random() * MAX_PLAYERS));
        }
      }
    }

    simulateBots(room, 0.05);

    if (now - room.lastSnapshotAt >= SNAPSHOT_MS) {
      room.lastSnapshotAt = now;
      broadcastSnapshot(room);
    }
  }
}

setInterval(roomTick, 50);

wss.on('connection', (ws: WebSocket) => {
  const clientId = `pilot_${Math.random().toString(36).slice(2, 10)}`;
  const spawn = randomSpawn(0);

  const client: PlayerClient = {
    ws,
    id: clientId,
    name: `Pilot_${clientId.slice(-4).toUpperCase()}`,
    shipId: 'vanguard',
    isBot: false,
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    angle: -Math.PI / 2,
    health: 100,
    maxHealth: 100,
    shield: 80,
    maxShield: 80,
    isDashing: false,
    kills: 0,
    deaths: 0,
    score: 0,
    isAlive: true,
    respawnTimer: 0,
    invulnerableTimer: 0,
    fireCooldown: 0,
    region: 'auto',
    roomId: null,
    lastPing: Date.now(),
  };

  connectedClients.set(ws, client);
  (ws as any).isAlive = true;

  send(ws, {
    type: 'connected',
    clientId,
    onlinePlayers: connectedClients.size,
    serverTime: Date.now(),
  });

  ws.on('pong', () => {
    (ws as any).isAlive = true;
    client.lastPing = Date.now();
  });

  ws.on('message', (raw: string) => {
    try {
      const data = JSON.parse(raw.toString());
      if (!data || typeof data !== 'object') return;

      if (data.type === 'ping') {
        send(ws, { type: 'pong', sendTime: data.sendTime ?? data.timestamp ?? performance.now() });
        return;
      }

      if (data.type === 'check_username') {
        const username = String(data.username || '').trim();
        const pilotId = String(data.pilotId || client.pilotId || client.id).trim();
        const check = isUsernameTaken(username, pilotId, client.id);
        send(ws, { type: 'username_check_result', username, available: !check.taken, reason: check.reason });
        return;
      }

      if (data.type === 'claim_username') {
        const username = safeName(data.username, client.name);
        const pilotId = String(data.pilotId || client.pilotId || client.id).trim();
        const check = isUsernameTaken(username, pilotId, client.id);
        if (check.taken) {
          send(ws, { type: 'username_claim_result', success: false, username, reason: check.reason });
          return;
        }

        client.name = username;
        client.pilotId = pilotId;
        registeredUsernames.set(username.toLowerCase(), {
          pilotId,
          originalName: username,
          claimedAt: Date.now(),
        });
        saveClaimedUsernames();
        send(ws, { type: 'username_claim_result', success: true, username });
        return;
      }

      if (data.type === 'join_queue') {
        const requestedName = safeName(data.pilotName, client.name);
        const pilotId = String(data.pilotId || client.pilotId || client.id).trim();
        const check = isUsernameTaken(requestedName, pilotId, client.id);

        if (check.taken) {
          send(ws, { type: 'queue_error', message: check.reason || 'Call sign is already taken.' });
          return;
        }

        removeFromQueue(client);
        client.name = requestedName;
        client.pilotId = pilotId;
        client.shipId = ['vanguard', 'striker', 'titan'].includes(data.shipId) ? data.shipId : 'vanguard';
        client.region = String(data.region || 'auto');
        const cfg = SHIP_STATS[client.shipId];
        client.maxHealth = cfg.health;
        client.health = cfg.health;
        client.maxShield = cfg.shield;
        client.shield = cfg.shield;

        registeredUsernames.set(requestedName.toLowerCase(), {
          pilotId,
          originalName: requestedName,
          claimedAt: Date.now(),
        });
        saveClaimedUsernames();

        matchmakingQueue.push(client);
        broadcastQueueStatus();

        if (matchmakingQueue.length >= MAX_PLAYERS) {
          const roomPlayers = matchmakingQueue.splice(0, MAX_PLAYERS);
          createRoom(roomPlayers, 0);
          broadcastQueueStatus();
        }
        return;
      }

      if (data.type === 'leave_queue') {
        removeFromQueue(client);
        broadcastQueueStatus();
        return;
      }

      if (data.type === 'launch_with_bots') {
        if (client.roomId) return;
        let roomPlayers: PlayerClient[] = [];
        const idx = matchmakingQueue.findIndex(p => p.id === client.id);

        if (idx >= 0) {
          // Keep all currently queued humans together, capped at eight.
          roomPlayers = matchmakingQueue.splice(0, Math.min(MAX_PLAYERS, matchmakingQueue.length));
        } else {
          roomPlayers = [client];
        }

        if (!roomPlayers.some(p => p.id === client.id)) roomPlayers.push(client);
        roomPlayers = roomPlayers.slice(0, MAX_PLAYERS);

        const neededBots = Math.max(0, MAX_PLAYERS - roomPlayers.length);
        createRoom(roomPlayers, neededBots);
        broadcastQueueStatus();
        return;
      }

      if (data.type === 'leave_match') {
        if (!client.roomId) return;
        const room = activeRooms.get(client.roomId);
        if (!room) {
          client.roomId = null;
          return;
        }

        room.players.delete(client.id);
        client.roomId = null;
        broadcastRoom(room, {
          type: 'pilot_left',
          pilotId: client.id,
          pilotName: client.name,
        });

        if (room.players.size === 0) {
          activeRooms.delete(room.id);
        } else {
          broadcastSnapshot(room);
        }
        return;
      }

      if (!client.roomId) return;
      const room = activeRooms.get(client.roomId);
      if (!room || room.status !== 'in_progress') return;

      if (data.type === 'pilot_update') {
        // Position is client-predicted/owned; combat stats remain server-owned.
        client.x = clamp(Number(data.x) || client.x, 32, WORLD_WIDTH - 32);
        client.y = clamp(Number(data.y) || client.y, 32, WORLD_HEIGHT - 32);
        client.vx = clamp(Number(data.vx) || 0, -900, 900);
        client.vy = clamp(Number(data.vy) || 0, -900, 900);
        client.angle = Number.isFinite(Number(data.angle)) ? Number(data.angle) : client.angle;
        client.isDashing = Boolean(data.isDashing);
        return;
      }

      if (data.type === 'pilot_shoot') {
        if (!client.isAlive) return;
        const damage = clamp(Number(data.damage) || 0, 1, 100);
        broadcastRoom(room, {
          type: 'remote_pilot_shoot',
          pilotId: client.id,
          x: Number(data.x) || client.x,
          y: Number(data.y) || client.y,
          vx: clamp(Number(data.vx) || 0, -1800, 1800),
          vy: clamp(Number(data.vy) || 0, -1800, 1800),
          damage,
          color: String(data.color || '#38bdf8'),
        }, client.id);
        return;
      }

      if (data.type === 'deal_damage') {
        const targetId = String(data.targetPilotId || '');
        applyAuthoritativeDamage(room, client.id, targetId, Number(data.damage), String(data.weapon || 'Plasma Torpedo'));
        return;
      }
    } catch {
      // Ignore malformed packets from clients.
    }
  });

  ws.on('close', () => {
    removeFromQueue(client);

    if (client.roomId) {
      const room = activeRooms.get(client.roomId);
      if (room) {
        room.players.delete(client.id);
        broadcastRoom(room, {
          type: 'pilot_left',
          pilotId: client.id,
          pilotName: client.name,
        });
        if (room.players.size === 0) {
          activeRooms.delete(room.id);
        } else {
          broadcastSnapshot(room);
        }
      }
    }

    connectedClients.delete(ws);
    broadcastQueueStatus();
  });

  ws.on('error', () => {
    // close handler performs cleanup
  });
});

// Terminate dead WebSocket connections.
setInterval(() => {
  for (const ws of wss.clients) {
    if ((ws as any).isAlive === false) {
      try { ws.terminate(); } catch {}
      continue;
    }
    (ws as any).isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);

// HTTP / health / auth API
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '32kb' }));

app.get('/', (_req, res, next) => {
  // In local development Vite serves the SPA. Production Hugging Face
  // deployments intentionally expose the backend health response instead.
  if (process.env.NODE_ENV !== 'production') return next();
  res.status(200).json({
    service: 'HyperVanguard Multiplayer Backend',
    status: 'ok',
    websocket: true,
    port: PORT,
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    websocket: true,
    onlinePlayers: connectedClients.size,
    queuedPlayers: matchmakingQueue.length,
    activeMatches: activeRooms.size,
    registeredCallSigns: authDatabase.getTotalUsers() || registeredUsernames.size,
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

app.get('/api/auth/check-username', (req, res) => {
  const username = String(req.query.username || '');
  const pilotId = String(req.query.pilotId || '');
  const check = authDatabase.checkUsernameAvailability(username, pilotId);
  res.json({ username, available: check.available, reason: check.reason });
});

app.post('/api/auth/register', (req, res) => {
  const { username, pilotId, pin } = req.body || {};
  const result = authDatabase.registerUser({ username, pilotId, pin });
  if (!result.success) {
    return res.status(409).json({
      success: false,
      code: 'DUPLICATE_USERNAME_REJECTED',
      message: result.error || 'Username is already taken.',
    });
  }

  registeredUsernames.set(result.user!.usernameLower, {
    pilotId: result.user!.pilotId,
    originalName: result.user!.username,
    claimedAt: result.user!.createdAt,
  });
  saveClaimedUsernames();

  res.status(201).json({ success: true, message: 'Pilot registration successful.', user: result.user });
});

app.post('/api/auth/login', (req, res) => {
  const { username, pilotId, pin } = req.body || {};
  const result = authDatabase.authenticateUser({ username, pilotId, pin });
  if (!result.success) {
    return res.status(401).json({
      success: false,
      code: 'AUTH_FAILED',
      message: result.error || 'Authentication failed.',
    });
  }
  res.json({ success: true, message: 'Pilot authenticated successfully.', user: result.user });
});

app.get('/api/check-username', (req, res) => {
  const username = String(req.query.username || '');
  const pilotId = String(req.query.pilotId || '');
  const check = authDatabase.checkUsernameAvailability(username, pilotId);
  res.json({ username, available: check.available, reason: check.reason });
});

app.post('/api/claim-username', (req, res) => {
  const { username, pilotId, pin } = req.body || {};
  const result = authDatabase.registerUser({ username, pilotId, pin });
  if (!result.success) return res.json({ success: false, reason: result.error, username });

  registeredUsernames.set(result.user!.usernameLower, {
    pilotId: result.user!.pilotId,
    originalName: result.user!.username,
    claimedAt: result.user!.createdAt,
  });
  saveClaimedUsernames();
  res.json({ success: true, username: result.user!.username });
});

async function startServer() {
  // Keep the original one-command local developer experience: `npm run dev`
  // serves the Vite SPA and the WebSocket server from the same HTTP server.
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Multiplayer] Server listening on 0.0.0.0:${PORT}`);
    console.log(`[Multiplayer] WebSocket endpoint: ws(s)://<host>/`);
  });
}

startServer();
