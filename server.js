'use strict';

/**
 * Pong Neón – servidor autoritativo
 *
 * - Express sirve el cliente estático desde /public.
 * - Socket.io gestiona salas de 2 jugadores.
 * - Toda la simulación (raquetas, pelota, colisiones, puntos) vive AQUÍ, a 60 Hz.
 *   El cliente solo envía su intención de movimiento (-1, 0, 1) y dibuja lo que recibe.
 */

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;

// ───────────────────────── Configuración del juego (unidades lógicas 800 x 500) ─────────────────────────
const W = 800;
const H = 500;
const PADDLE_W = 12;
const PADDLE_H = 90;
const PADDLE_MARGIN = 24; // distancia de la raqueta al borde
const PADDLE_SPEED = 460; // px/s
const PADDLE_X = [PADDLE_MARGIN, W - PADDLE_MARGIN - PADDLE_W];
const BALL_R = 8;
const BALL_START_SPEED = 360; // px/s
const BALL_MAX_SPEED = 980; // px/s
const PADDLE_HIT_ACCEL = 1.06; // +6 % de velocidad en cada golpe de raqueta
const WALL_HIT_ACCEL = 1.01; // +1 % en cada rebote contra pared
const MAX_BOUNCE_ANGLE = Math.PI / 3; // 60° en los extremos de la raqueta
const WIN_SCORE = 7;

const TICK_RATE = 60;
const STEP = 1 / TICK_RATE;
const COUNTDOWN_SECONDS = 3;
const SERVE_DELAY = 0.9; // pausa tras cada punto

const MAX_ROOMS = 2000;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin 0/O, 1/I/L para evitar confusiones
const CODE_REGEX = /^[A-Z0-9]{4}$/;

// Datos estáticos que el cliente necesita para dibujar la cancha
const CLIENT_CONFIG = {
  width: W,
  height: H,
  paddleW: PADDLE_W,
  paddleH: PADDLE_H,
  paddleX: PADDLE_X,
  ballR: BALL_R,
  winScore: WIN_SCORE,
};

// ───────────────────────── Servidor HTTP + Socket.io ─────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

// ───────────────────────── Utilidades ─────────────────────────
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const r1 = (v) => Math.round(v * 10) / 10;

/** code -> room */
const rooms = new Map();

function generateCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

function createRoom(code) {
  const room = {
    code,
    players: [null, null], // socket.id de J1 (izquierda) y J2 (derecha)
    phase: 'waiting', // waiting | countdown | playing | finished
    scores: [0, 0],
    winner: null, // 1 | 2 | null
    rematch: [false, false],
    paddles: [(H - PADDLE_H) / 2, (H - PADDLE_H) / 2], // y superior de cada raqueta
    inputs: [0, 0], // -1 arriba, 0 quieto, 1 abajo
    ball: null,
    serveDir: 1,
    timer: 0, // segundos restantes de cuenta atrás / pausa de saque
  };
  centerBall(room);
  return room;
}

function centerBall(room) {
  room.ball = { x: W / 2, y: H / 2, vx: 0, vy: 0, speed: BALL_START_SPEED };
}

function launchBall(room) {
  const b = room.ball;
  const angle = (Math.random() * 2 - 1) * (Math.PI / 6); // ±30°
  b.speed = BALL_START_SPEED;
  b.vx = Math.cos(angle) * b.speed * room.serveDir;
  b.vy = Math.sin(angle) * b.speed;
}

function resetPositions(room) {
  room.paddles = [(H - PADDLE_H) / 2, (H - PADDLE_H) / 2];
  centerBall(room);
}

/** Inicia (o reinicia) una partida completa con cuenta atrás. */
function startMatch(room) {
  room.scores = [0, 0];
  room.winner = null;
  room.rematch = [false, false];
  room.serveDir = Math.random() < 0.5 ? -1 : 1;
  room.timer = COUNTDOWN_SECONDS;
  room.phase = 'countdown';
  resetPositions(room);
}

function backToWaiting(room) {
  room.phase = 'waiting';
  room.scores = [0, 0];
  room.winner = null;
  room.rematch = [false, false];
  room.timer = 0;
  resetPositions(room);
}

const isActive = (room) => room.phase === 'countdown' || room.phase === 'playing';

// ───────────────────────── Emisión ─────────────────────────
function publicRoom(room) {
  return {
    code: room.code,
    phase: room.phase,
    players: [Boolean(room.players[0]), Boolean(room.players[1])],
    scores: room.scores,
    winner: room.winner,
    rematch: room.rematch,
  };
}

function broadcastRoom(room, extra = {}) {
  io.to(room.code).emit('room:update', { ...publicRoom(room), ...extra });
}

function emitFx(room, type, x, y, side = null) {
  io.to(room.code).emit('game:fx', { type, x: r1(x), y: r1(y), side });
}

function sendState(room) {
  const b = room.ball;
  // volatile: si un cliente va justo de red, se descarta el paquete en vez de acumularlo
  io.to(room.code).volatile.emit('game:state', {
    b: [r1(b.x), r1(b.y)],
    p: [r1(room.paddles[0]), r1(room.paddles[1])],
    c: room.phase === 'countdown' ? Math.ceil(room.timer) : 0,
  });
}

// ───────────────────────── Física ─────────────────────────
function speedUp(ball, factor) {
  const next = Math.min(ball.speed * factor, BALL_MAX_SPEED);
  const k = next / ball.speed;
  ball.vx *= k;
  ball.vy *= k;
  ball.speed = next;
}

/** Colisión pelota–raqueta. Devuelve true si hubo golpe. */
function collidePaddle(room, i) {
  const b = room.ball;
  const movingToward = i === 0 ? b.vx < 0 : b.vx > 0;
  if (!movingToward) return false;

  const px = PADDLE_X[i];
  const py = room.paddles[i];
  const overlapX = b.x + BALL_R >= px && b.x - BALL_R <= px + PADDLE_W;
  const overlapY = b.y + BALL_R >= py && b.y - BALL_R <= py + PADDLE_H;
  if (!overlapX || !overlapY) return false;

  // Punto de impacto: -1 (borde superior) … 0 (centro) … 1 (borde inferior)
  const rel = clamp((b.y - (py + PADDLE_H / 2)) / (PADDLE_H / 2), -1, 1);
  const angle = rel * MAX_BOUNCE_ANGLE;
  const speed = Math.min(b.speed * PADDLE_HIT_ACCEL, BALL_MAX_SPEED);
  const dir = i === 0 ? 1 : -1;

  b.speed = speed;
  b.vx = dir * speed * Math.cos(angle);
  b.vy = speed * Math.sin(angle);
  b.x = i === 0 ? px + PADDLE_W + BALL_R : px - BALL_R; // saca la pelota de la raqueta
  return true;
}

function scorePoint(room, scorer) {
  const b = room.ball;
  room.scores[scorer] += 1;
  emitFx(room, 'score', clamp(b.x, 0, W), b.y, scorer);
  centerBall(room);

  if (room.scores[scorer] >= WIN_SCORE) {
    room.phase = 'finished';
    room.winner = scorer + 1;
    room.rematch = [false, false];
  } else {
    // El saque va hacia quien acaba de encajar el punto
    room.serveDir = scorer === 0 ? 1 : -1;
    room.timer = SERVE_DELAY;
  }
  broadcastRoom(room);
}

function stepRoom(room, dt) {
  // Las raquetas se mueven siempre (también durante la cuenta atrás)
  for (let i = 0; i < 2; i++) {
    room.paddles[i] = clamp(room.paddles[i] + room.inputs[i] * PADDLE_SPEED * dt, 0, H - PADDLE_H);
  }

  // Cuenta atrás inicial o pausa de saque
  if (room.timer > 0) {
    room.timer -= dt;
    if (room.timer > 0) return;
    room.timer = 0;
    if (room.phase === 'countdown') {
      room.phase = 'playing';
      broadcastRoom(room);
    }
    launchBall(room);
    return;
  }

  const b = room.ball;
  b.x += b.vx * dt;
  b.y += b.vy * dt;

  // Paredes superior / inferior
  if (b.y - BALL_R <= 0) {
    b.y = BALL_R;
    b.vy = Math.abs(b.vy);
    speedUp(b, WALL_HIT_ACCEL);
    emitFx(room, 'wall', b.x, b.y);
  } else if (b.y + BALL_R >= H) {
    b.y = H - BALL_R;
    b.vy = -Math.abs(b.vy);
    speedUp(b, WALL_HIT_ACCEL);
    emitFx(room, 'wall', b.x, b.y);
  }

  // Raquetas
  for (let i = 0; i < 2; i++) {
    if (collidePaddle(room, i)) {
      emitFx(room, 'paddle', b.x, b.y, i);
      break;
    }
  }

  // Puntos (la pelota sale por un lateral)
  if (b.x + BALL_R < 0) scorePoint(room, 1);
  else if (b.x - BALL_R > W) scorePoint(room, 0);
}

// ───────────────────────── Loop del juego a 60 Hz ─────────────────────────
// Se consulta el reloj cada 4 ms y se ejecutan pasos FIJOS de 1/60 s (acumulador),
// así la simulación es estable aunque setInterval no sea exacto.
let lastTime = process.hrtime.bigint();
let accumulator = 0;

setInterval(() => {
  const now = process.hrtime.bigint();
  accumulator += Number(now - lastTime) / 1e9;
  lastTime = now;
  if (accumulator > 0.25) accumulator = 0.25; // evita "espirales de la muerte" tras una pausa larga

  if (accumulator < STEP) return;

  const active = [];
  for (const room of rooms.values()) if (isActive(room)) active.push(room);

  while (accumulator >= STEP) {
    accumulator -= STEP;
    for (const room of active) if (isActive(room)) stepRoom(room, STEP);
  }
  for (const room of active) sendState(room);
}, 4);

// ───────────────────────── Gestión de salas ─────────────────────────
function joinRoom(socket, room, slot) {
  room.players[slot] = socket.id;
  socket.data.roomCode = room.code;
  socket.data.slot = slot;
  socket.join(room.code);

  socket.emit('room:joined', { code: room.code, role: slot + 1, config: CLIENT_CONFIG });

  if (room.players[0] && room.players[1]) startMatch(room);
  else backToWaiting(room);

  broadcastRoom(room);
}

function leaveCurrentRoom(socket) {
  const { roomCode, slot } = socket.data;
  if (!roomCode) return;

  socket.leave(roomCode);
  socket.data.roomCode = null;
  socket.data.slot = null;

  const room = rooms.get(roomCode);
  if (!room) return;

  room.players[slot] = null;
  room.inputs[slot] = 0;

  if (!room.players[0] && !room.players[1]) {
    rooms.delete(roomCode);
    return;
  }

  // Queda un jugador: la sala sigue abierta esperando a otro (ocupará el hueco libre)
  backToWaiting(room);
  broadcastRoom(room, { left: slot + 1 });
}

io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.slot = null;

  socket.on('room:create', () => {
    leaveCurrentRoom(socket);
    if (rooms.size >= MAX_ROOMS) {
      socket.emit('room:error', { message: 'El servidor está lleno. Inténtalo de nuevo en unos minutos.' });
      return;
    }
    const room = createRoom(generateCode());
    rooms.set(room.code, room);
    joinRoom(socket, room, 0);
  });

  socket.on('room:join', (payload) => {
    const code = typeof payload?.code === 'string' ? payload.code.trim().toUpperCase() : '';
    if (!CODE_REGEX.test(code)) {
      socket.emit('room:error', { message: 'El código debe tener 4 letras o números.' });
      return;
    }
    leaveCurrentRoom(socket);

    const room = rooms.get(code);
    if (!room) {
      socket.emit('room:error', { message: `No existe ninguna sala con el código ${code}.` });
      return;
    }
    const slot = room.players[0] ? (room.players[1] ? -1 : 1) : 0;
    if (slot === -1) {
      socket.emit('room:error', { message: `La sala ${code} ya está llena.` });
      return;
    }
    joinRoom(socket, room, slot);
  });

  socket.on('room:leave', () => leaveCurrentRoom(socket));

  socket.on('input', (dir) => {
    if (dir !== -1 && dir !== 0 && dir !== 1) return;
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    room.inputs[socket.data.slot] = dir;
  });

  socket.on('game:rematch', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'finished') return;
    room.rematch[socket.data.slot] = true;
    if (room.rematch[0] && room.rematch[1]) startMatch(room);
    broadcastRoom(room);
  });

  socket.on('disconnect', () => leaveCurrentRoom(socket));
});

server.listen(PORT, () => {
  console.log(`Pong Neón escuchando en http://localhost:${PORT}`);
});
