'use strict';

/**
 * Pong neón – cliente
 *
 * El cliente NO simula nada: envía la intención de movimiento (-1, 0, 1) y
 * dibuja los "snapshots" que manda el servidor (60 por segundo), interpolándolos
 * ~50 ms en el pasado para que el movimiento se vea fluido aunque la red tiemble.
 */
(() => {
  // ───────────────────────── Utilidades ─────────────────────────
  const $ = (id) => document.getElementById(id);
  const lerp = (a, b, t) => a + (b - a) * t;
  const TAU = Math.PI * 2;

  const COLORS = {
    bg: '#06021a',
    line: '#3a2a70',
    p1: '#ff3d8b',
    p2: '#27e6ff',
    ball: '#fff36b',
    p1Rgb: [255, 61, 139],
    p2Rgb: [39, 230, 255],
    ballRgb: [255, 243, 107],
  };
  const rgba = ([r, g, b], a) => `rgba(${r}, ${g}, ${b}, ${a})`;

  // ───────────────────────── Audio (bips retro con WebAudio) ─────────────────────────
  const AudioFX = (() => {
    let ac = null;
    let muted = false;
    try { muted = localStorage.getItem('pong-muted') === '1'; } catch { /* almacenamiento no disponible */ }

    function ensure() {
      if (!ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) ac = new AC();
      }
      if (ac && ac.state === 'suspended') ac.resume();
      return ac;
    }

    function beep(freq, dur, type = 'square', vol = 0.05, slideTo = null, delay = 0) {
      if (muted) return;
      const a = ensure();
      if (!a) return;
      const t = a.currentTime + delay;
      const osc = a.createOscillator();
      const gain = a.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain).connect(a.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    }

    return {
      unlock: ensure,
      paddle: () => beep(440, 0.08),
      wall: () => beep(260, 0.06),
      score: () => beep(700, 0.35, 'sawtooth', 0.06, 110),
      tick: () => beep(520, 0.09),
      go: () => beep(880, 0.22),
      win: () => [523, 659, 784, 1046].forEach((f, i) => beep(f, 0.14, 'square', 0.05, null, i * 0.12)),
      lose: () => [392, 330, 262, 196].forEach((f, i) => beep(f, 0.18, 'sawtooth', 0.05, null, i * 0.14)),
      isMuted: () => muted,
      setMuted(value) {
        muted = value;
        try { localStorage.setItem('pong-muted', value ? '1' : '0'); } catch { /* ignorar */ }
      },
    };
  })();

  // ───────────────────────── Referencias al DOM ─────────────────────────
  const el = {
    lobby: $('lobby'),
    game: $('game'),
    btnCreate: $('btn-create'),
    btnJoin: $('btn-join'),
    joinForm: $('join-form'),
    codeInput: $('code-input'),
    lobbyMsg: $('lobby-msg'),
    conn: $('conn'),
    connText: $('conn-text'),
    scoreP1: $('score-p1'),
    scoreP2: $('score-p2'),
    numP1: $('num-p1'),
    numP2: $('num-p2'),
    roomCode: $('room-code'),
    status: $('status'),
    wrap: $('court-wrap'),
    court: $('court'),
    overlay: $('overlay'),
    ovTitle: $('ov-title'),
    ovCode: $('ov-code'),
    ovText: $('ov-text'),
    ovActions: $('ov-actions'),
    btnUp: $('btn-up'),
    btnDown: $('btn-down'),
    btnMute: $('btn-mute'),
    btnLeave: $('btn-leave'),
  };
  const ctx = el.court.getContext('2d');

  // ───────────────────────── Estado del cliente ─────────────────────────
  const socket = io();

  const session = {
    code: null,
    role: null, // 1 (izquierda) | 2 (derecha)
    cfg: null, // dimensiones de la cancha enviadas por el servidor
    room: null, // último 'room:update'
    leftNotice: false, // el rival se desconectó y seguimos esperando
  };

  const INTERP_DELAY = 50; // ms
  let snapshots = [];
  let lastCount = -1;

  const fx = {
    flash: [0, 0],
    shake: 0,
    edge: { side: 0, a: 0, rgb: COLORS.p1Rgb },
    particles: [],
    trail: [],
  };

  // ───────────────────────── Conexión ─────────────────────────
  function setConn(state, text) {
    el.conn.dataset.state = state;
    el.connText.textContent = text;
    const online = state === 'online';
    el.btnCreate.disabled = !online;
    el.btnJoin.disabled = !online;
  }

  socket.on('connect', () => setConn('online', 'Conectado al servidor'));

  socket.on('connect_error', () => setConn('offline', 'No se puede conectar con el servidor'));

  socket.on('disconnect', () => {
    setConn('offline', 'Conexión perdida. Reconectando…');
    if (session.code) {
      leaveToLobby('Se perdió la conexión con el servidor. Crea una sala o únete de nuevo.');
    }
  });

  socket.io.on('reconnect_attempt', () => setConn('connecting', 'Reconectando…'));

  // ───────────────────────── Pantallas ─────────────────────────
  function showScreen(name) {
    el.lobby.hidden = name !== 'lobby';
    el.game.hidden = name !== 'game';
    if (name === 'game') resizeCanvas();
  }

  function setLobbyMsg(text) {
    el.lobbyMsg.textContent = text || '';
  }

  function resetSession() {
    session.code = null;
    session.role = null;
    session.cfg = null;
    session.room = null;
    session.leftNotice = false;
    snapshots = [];
    lastCount = -1;
    fx.particles.length = 0;
    fx.trail.length = 0;
    keys.up = keys.down = false;
    lastSent = 0;
    el.overlay.hidden = true;
    el.numP1.textContent = '0';
    el.numP2.textContent = '0';
  }

  function leaveToLobby(message = '') {
    resetSession();
    showScreen('lobby');
    setLobbyMsg(message);
  }

  function leaveRoom() {
    socket.emit('room:leave');
    leaveToLobby();
  }

  // ───────────────────────── Overlay ─────────────────────────
  function showOverlay({ tone, title, text = '', code = '', buttons = [] }) {
    el.overlay.dataset.tone = tone;
    el.ovTitle.textContent = title;
    el.ovText.textContent = text;
    el.ovText.hidden = !text;
    el.ovCode.textContent = code;
    el.ovCode.hidden = !code;

    el.ovActions.replaceChildren(
      ...buttons.map((b) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `btn ${b.cls}`;
        btn.textContent = b.label;
        btn.disabled = Boolean(b.disabled);
        btn.addEventListener('click', () => b.onClick(btn));
        return btn;
      })
    );
    el.overlay.hidden = false;
  }

  function hideOverlay() {
    el.overlay.hidden = true;
  }

  function fallbackCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }

  async function copyInvite(btn) {
    const url = `${location.origin}${location.pathname}?sala=${session.code}`;
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      ok = fallbackCopy(url);
    }
    const original = btn.textContent;
    btn.textContent = ok ? '¡Enlace copiado!' : 'No se pudo copiar';
    setTimeout(() => { btn.textContent = original; }, 1600);
  }

  function setStatus(text) {
    el.status.textContent = text;
  }

  /** Traduce la fase de la sala a mensajes de estado y overlays. */
  function applyPhase(room) {
    const rival = session.role === 1 ? 2 : 1;

    switch (room.phase) {
      case 'waiting': {
        const left = session.leftNotice;
        setStatus(left ? `Jugador ${rival} desconectado` : `Esperando al Jugador ${rival}…`);
        showOverlay({
          tone: 'wait',
          title: left ? `Jugador ${rival} desconectado` : `Esperando al Jugador ${rival}…`,
          code: room.code,
          text: left
            ? 'La sala sigue abierta. Comparte el código para que alguien ocupe su lugar.'
            : 'Comparte este código con tu rival.',
          buttons: [
            { label: 'Copiar enlace', cls: 'btn-cyan', onClick: copyInvite },
            { label: 'Salir', cls: 'btn-ghost', onClick: leaveRoom },
          ],
        });
        break;
      }

      case 'countdown':
        setStatus('Prepárate…');
        hideOverlay();
        break;

      case 'playing':
        setStatus('En juego');
        hideOverlay();
        break;

      case 'finished': {
        const won = room.winner === session.role;
        const iVoted = room.rematch[session.role - 1];
        const rivalVoted = room.rematch[rival - 1];
        setStatus(won ? '¡Ganaste la partida!' : 'Perdiste la partida');

        let text = `Marcador final: ${room.scores[0]} a ${room.scores[1]}.`;
        if (iVoted) text += ' Esperando a que tu rival acepte la revancha.';
        else if (rivalVoted) text += ' Tu rival quiere la revancha.';

        showOverlay({
          tone: won ? 'win' : 'lose',
          title: won ? 'Victoria' : 'Derrota',
          text,
          buttons: [
            {
              label: iVoted ? 'Esperando…' : 'Jugar de nuevo',
              cls: 'btn-pink',
              disabled: iVoted,
              onClick: () => socket.emit('game:rematch'),
            },
            { label: 'Salir al lobby', cls: 'btn-ghost', onClick: leaveRoom },
          ],
        });
        break;
      }
    }
  }

  // ───────────────────────── Eventos de sala / partida ─────────────────────────
  socket.on('room:error', ({ message }) => setLobbyMsg(message));

  socket.on('room:joined', ({ code, role, config }) => {
    resetSession();
    session.code = code;
    session.role = role;
    session.cfg = config;

    el.roomCode.textContent = code;
    el.scoreP1.dataset.you = String(role === 1);
    el.scoreP2.dataset.you = String(role === 2);

    setLobbyMsg('');
    showScreen('game');
  });

  socket.on('room:update', (room) => {
    if (!session.code) return;
    const prev = session.room;
    session.room = room;

    el.numP1.textContent = room.scores[0];
    el.numP2.textContent = room.scores[1];

    if (room.left) session.leftNotice = true;
    if (room.phase !== 'waiting') session.leftNotice = false;

    if (room.phase === 'waiting') {
      snapshots = [];
      fx.trail.length = 0;
    }
    if (room.phase === 'countdown' && prev?.phase !== 'countdown') {
      snapshots = [];
      fx.trail.length = 0;
      lastCount = -1;
    }
    if (room.phase === 'finished' && prev?.phase !== 'finished') {
      if (room.winner === session.role) AudioFX.win();
      else AudioFX.lose();
    }

    applyPhase(room);
  });

  socket.on('game:state', (s) => {
    s.t = performance.now();
    snapshots.push(s);
    if (snapshots.length > 40) snapshots.shift();

    // Pitidos de la cuenta atrás
    if (s.c !== lastCount) {
      if (s.c > 0) AudioFX.tick();
      else if (lastCount > 0) AudioFX.go();
      lastCount = s.c;
    }
  });

  socket.on('game:fx', (e) => {
    const cfg = session.cfg;
    if (!cfg) return;

    if (e.type === 'paddle') {
      fx.flash[e.side] = 1;
      burst(e.x, e.y, e.side === 0 ? COLORS.p1Rgb : COLORS.p2Rgb, 10, 240);
      AudioFX.paddle();
    } else if (e.type === 'wall') {
      burst(e.x, e.y, COLORS.ballRgb, 5, 140);
      AudioFX.wall();
    } else if (e.type === 'score') {
      fx.shake = 1;
      fx.edge = { side: e.side === 0 ? 1 : 0, a: 1, rgb: e.side === 0 ? COLORS.p1Rgb : COLORS.p2Rgb };
      burst(e.x, e.y, COLORS.ballRgb, 28, 360);
      AudioFX.score();
    }
  });

  // ───────────────────────── Entrada (teclado y táctil) ─────────────────────────
  const keys = { up: false, down: false };
  let lastSent = 0;

  function sendInput() {
    const dir = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    if (dir === lastSent) return;
    lastSent = dir;
    socket.emit('input', dir);
  }

  const KEY_MAP = { w: 'up', arrowup: 'up', s: 'down', arrowdown: 'down' };

  window.addEventListener('keydown', (e) => {
    const k = KEY_MAP[e.key.toLowerCase()];
    if (!k || !session.code || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault(); // evita que las flechas hagan scroll
    keys[k] = true;
    sendInput();
  });

  window.addEventListener('keyup', (e) => {
    const k = KEY_MAP[e.key.toLowerCase()];
    if (!k || !session.code) return;
    keys[k] = false;
    sendInput();
  });

  window.addEventListener('blur', () => {
    keys.up = keys.down = false;
    sendInput();
  });

  function bindHold(btn, key) {
    const press = (e) => {
      e.preventDefault();
      keys[key] = true;
      btn.classList.add('is-down');
      sendInput();
    };
    const release = () => {
      keys[key] = false;
      btn.classList.remove('is-down');
      sendInput();
    };
    btn.addEventListener('pointerdown', press);
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => btn.addEventListener(t, release));
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  bindHold(el.btnUp, 'up');
  bindHold(el.btnDown, 'down');

  // ───────────────────────── Lobby: formularios ─────────────────────────
  el.btnCreate.addEventListener('click', () => {
    AudioFX.unlock();
    setLobbyMsg('');
    socket.emit('room:create');
  });

  el.codeInput.addEventListener('input', () => {
    el.codeInput.value = el.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    setLobbyMsg('');
  });

  el.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    AudioFX.unlock();
    const code = el.codeInput.value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) {
      setLobbyMsg('El código debe tener 4 letras o números.');
      return;
    }
    socket.emit('room:join', { code });
  });

  el.btnLeave.addEventListener('click', leaveRoom);

  function refreshMuteButton() {
    const muted = AudioFX.isMuted();
    el.btnMute.textContent = muted ? 'Sonido: no' : 'Sonido: sí';
    el.btnMute.setAttribute('aria-pressed', String(muted));
  }
  el.btnMute.addEventListener('click', () => {
    AudioFX.setMuted(!AudioFX.isMuted());
    AudioFX.unlock();
    refreshMuteButton();
  });
  refreshMuteButton();

  // Código de sala en la URL (?sala=ABCD) → lo deja escrito en el campo
  const urlCode = new URLSearchParams(location.search).get('sala');
  if (urlCode) el.codeInput.value = urlCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);

  // ───────────────────────── Efectos visuales ─────────────────────────
  function burst(x, y, rgb, count, speed) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * TAU;
      const v = speed * (0.35 + Math.random() * 0.65);
      const life = 0.3 + Math.random() * 0.35;
      fx.particles.push({ x, y, vx: Math.cos(angle) * v, vy: Math.sin(angle) * v, life, max: life, rgb });
    }
  }

  function updateFx(dt, st) {
    fx.flash[0] = Math.max(0, fx.flash[0] - dt * 4);
    fx.flash[1] = Math.max(0, fx.flash[1] - dt * 4);
    fx.shake = Math.max(0, fx.shake - dt * 3);
    fx.edge.a = Math.max(0, fx.edge.a - dt * 1.6);

    for (const p of fx.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    fx.particles = fx.particles.filter((p) => p.life > 0);

    // Estela de la pelota
    const [bx, by] = st.b;
    const last = fx.trail[fx.trail.length - 1];
    if (last && Math.hypot(bx - last.x, by - last.y) > 120) fx.trail.length = 0; // saque: no unir puntos lejanos
    if (!last || last.x !== bx || last.y !== by) fx.trail.push({ x: bx, y: by });
    else if (fx.trail.length) fx.trail.shift(); // pelota quieta: la estela se disipa
    while (fx.trail.length > 12) fx.trail.shift();
  }

  // ───────────────────────── Interpolación ─────────────────────────
  function getRenderState(now) {
    const cfg = session.cfg;
    const n = snapshots.length;
    if (n === 0) {
      const mid = (cfg.height - cfg.paddleH) / 2;
      return { b: [cfg.width / 2, cfg.height / 2], p: [mid, mid], c: 0 };
    }
    if (n === 1) return snapshots[0];

    const target = now - INTERP_DELAY;
    if (target >= snapshots[n - 1].t) return snapshots[n - 1];

    for (let i = n - 1; i > 0; i--) {
      const a = snapshots[i - 1];
      const b = snapshots[i];
      if (a.t <= target && target <= b.t) {
        if (Math.abs(b.b[0] - a.b[0]) > 120) return b; // salto = reinicio de saque, no interpolar
        const k = (target - a.t) / (b.t - a.t || 1);
        return {
          b: [lerp(a.b[0], b.b[0], k), lerp(a.b[1], b.b[1], k)],
          p: [lerp(a.p[0], b.p[0], k), lerp(a.p[1], b.p[1], k)],
          c: b.c,
        };
      }
    }
    return snapshots[0];
  }

  // ───────────────────────── Render ─────────────────────────
  function resizeCanvas() {
    const cfg = session.cfg;
    const w = el.wrap.clientWidth;
    if (!cfg || !w) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.round(w * dpr);
    const ch = Math.round((cw * cfg.height) / cfg.width);
    if (el.court.width !== cw || el.court.height !== ch) {
      el.court.width = cw;
      el.court.height = ch;
    }
  }

  new ResizeObserver(resizeCanvas).observe(el.wrap);

  function drawText(text, x, y, size, color, align = 'center') {
    ctx.font = `${size}px "Press Start 2P", monospace`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  function draw(st) {
    const cfg = session.cfg;
    const { width: W, height: H, paddleW, paddleH, paddleX, ballR } = cfg;
    const s = el.court.width / W;

    // Fondo y mitades tintadas (sin sacudida, para que no aparezcan huecos en los bordes)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, el.court.width, el.court.height);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.fillStyle = rgba(COLORS.p1Rgb, 0.05);
    ctx.fillRect(0, 0, W / 2, H);
    ctx.fillStyle = rgba(COLORS.p2Rgb, 0.05);
    ctx.fillRect(W / 2, 0, W / 2, H);

    // Resplandor del borde donde se anotó el punto
    if (fx.edge.a > 0) {
      const x0 = fx.edge.side === 0 ? 0 : W;
      const x1 = fx.edge.side === 0 ? 110 : W - 110;
      const g = ctx.createLinearGradient(x0, 0, x1, 0);
      g.addColorStop(0, rgba(fx.edge.rgb, 0.55 * fx.edge.a));
      g.addColorStop(1, rgba(fx.edge.rgb, 0));
      ctx.fillStyle = g;
      ctx.fillRect(Math.min(x0, x1), 0, 110, H);
    }

    // Sacudida al anotar
    const shake = fx.shake * 8;
    ctx.setTransform(s, 0, 0, s, (Math.random() - 0.5) * shake * s, (Math.random() - 0.5) * shake * s);

    // Línea central
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 4;
    ctx.setLineDash([12, 14]);
    ctx.beginPath();
    ctx.moveTo(W / 2, 8);
    ctx.lineTo(W / 2, H - 8);
    ctx.stroke();
    ctx.setLineDash([]);

    // Raquetas
    for (let i = 0; i < 2; i++) {
      const color = i === 0 ? COLORS.p1 : COLORS.p2;
      ctx.shadowColor = color;
      ctx.shadowBlur = (14 + fx.flash[i] * 26) * s;
      ctx.fillStyle = color;
      ctx.fillRect(paddleX[i], st.p[i], paddleW, paddleH);
      if (fx.flash[i] > 0) {
        ctx.globalAlpha = fx.flash[i] * 0.85;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(paddleX[i], st.p[i], paddleW, paddleH);
        ctx.globalAlpha = 1;
      }
    }

    // Estela
    ctx.shadowBlur = 0;
    for (let i = 0; i < fx.trail.length; i++) {
      const k = (i + 1) / fx.trail.length;
      ctx.fillStyle = rgba(COLORS.ballRgb, 0.26 * k);
      ctx.beginPath();
      ctx.arc(fx.trail[i].x, fx.trail[i].y, ballR * (0.35 + 0.65 * k), 0, TAU);
      ctx.fill();
    }

    // Pelota
    ctx.shadowColor = COLORS.ball;
    ctx.shadowBlur = 22 * s;
    ctx.fillStyle = '#fffbd6';
    ctx.beginPath();
    ctx.arc(st.b[0], st.b[1], ballR, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Partículas
    for (const p of fx.particles) {
      ctx.fillStyle = rgba(p.rgb, Math.max(0, p.life / p.max));
      ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    }

    // Marcador "tú" junto a tu raqueta mientras esperas o cuentas atrás
    const phase = session.room?.phase;
    if (phase === 'waiting' || phase === 'countdown') {
      const me = session.role - 1;
      const cy = st.p[me] + paddleH / 2;
      const color = me === 0 ? COLORS.p1 : COLORS.p2;
      ctx.shadowColor = color;
      ctx.shadowBlur = 10 * s;
      if (me === 0) drawText('Tú', paddleX[0] + paddleW + 14, cy, 12, color, 'left');
      else drawText('Tú', paddleX[1] - 14, cy, 12, color, 'right');
      ctx.shadowBlur = 0;
    }

    // Cuenta atrás
    if (st.c > 0) {
      ctx.shadowColor = COLORS.ball;
      ctx.shadowBlur = 26 * s;
      drawText(String(st.c), W / 2, H / 2, 84, COLORS.ball);
      ctx.shadowBlur = 0;
    }
  }

  let lastFrame = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    if (el.game.hidden || !session.cfg) return;
    const dt = Math.min((now - lastFrame) / 1000, 0.05);
    lastFrame = now;
    const st = getRenderState(now);
    updateFx(dt, st);
    draw(st);
  }
  requestAnimationFrame(frame);

  // Desbloquea el audio con el primer gesto del usuario
  window.addEventListener('pointerdown', AudioFX.unlock, { once: true });
})();
