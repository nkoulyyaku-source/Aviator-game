const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.json());
app.get('/health', (_, res) => res.json({ status: 'ok' }));

// ─── ROOM ENGINE ──────────────────────────────────────────────
// One GameRoom per country code (e.g. "CM", "CI", "FR")
const rooms = {}; // { countryCode: GameRoom }

function generateCrashPoint() {
  // House edge ~5%
  const r = Math.random();
  if (r < 0.01) return 1.0;
  return Math.max(1.01, Math.round((0.99 / (1 - Math.random() * 0.97)) * 100) / 100);
}

class GameRoom {
  constructor(countryCode, countryName, flag) {
    this.code = countryCode;
    this.name = countryName;
    this.flag = flag;
    this.state = 'waiting'; // waiting | flying | crashed
    this.crashAt = 1.0;
    this.currentMult = 1.0;
    this.countdown = 5;
    this.players = new Map(); // socketId -> { name, balance, bet, cashedOut }
    this.history = [];
    this.startTime = null;
    this.tickInterval = null;
    this.countdownInterval = null;
    this.startCountdown();
  }

  broadcast(event, data) {
    io.to(this.code).emit(event, data);
  }

  getRoomInfo() {
    return {
      country: this.code,
      countryName: this.name,
      flag: this.flag,
      state: this.state,
      currentMult: this.currentMult,
      countdown: this.countdown,
      crashAt: this.state === 'crashed' ? this.crashAt : null,
      history: this.history,
      playerCount: this.players.size,
    };
  }

  startCountdown() {
    this.state = 'waiting';
    this.currentMult = 1.0;
    this.countdown = 5;
    this.crashAt = generateCrashPoint();

    // Reset bets from previous round
    for (const [, p] of this.players) {
      p.bet = 0;
      p.cashedOut = false;
      p.betAmount = 0;
    }

    this.broadcast('room:state', this.getRoomInfo());

    this.countdownInterval = setInterval(() => {
      this.countdown--;
      this.broadcast('room:countdown', { countdown: this.countdown });
      if (this.countdown <= 0) {
        clearInterval(this.countdownInterval);
        this.startFlight();
      }
    }, 1000);
  }

  startFlight() {
    this.state = 'flying';
    this.startTime = Date.now();
    this.broadcast('room:flying', { crashAt: null }); // don't leak crashAt

    const SPEED = 0.045;

    this.tickInterval = setInterval(() => {
      const elapsed = (Date.now() - this.startTime) / 1000;
      this.currentMult = Math.round(Math.pow(Math.E, SPEED * elapsed) * 100) / 100;

      this.broadcast('room:tick', { mult: this.currentMult });

      if (this.currentMult >= this.crashAt) {
        clearInterval(this.tickInterval);
        this.doCrash();
      }
    }, 100); // 10 fps tick
  }

  doCrash() {
    this.state = 'crashed';
    this.history.unshift(this.crashAt);
    if (this.history.length > 12) this.history.pop();

    // Mark non-cashed-out bettors as lost
    for (const [sid, p] of this.players) {
      if (p.betAmount > 0 && !p.cashedOut) {
        io.to(sid).emit('player:lost', { amount: p.betAmount, crashAt: this.crashAt });
        p.betAmount = 0;
      }
    }

    this.broadcast('room:crashed', { crashAt: this.crashAt, history: this.history });
    setTimeout(() => this.startCountdown(), 3000);
  }

  playerBet(socketId, amount) {
    const p = this.players.get(socketId);
    if (!p || this.state !== 'waiting') return { ok: false, msg: 'Impossible de miser maintenant' };
    if (amount < 10) return { ok: false, msg: 'Mise minimum 10 FCFA' };
    if (amount > p.balance) return { ok: false, msg: 'Solde insuffisant' };
    p.balance -= amount;
    p.betAmount = amount;
    p.cashedOut = false;
    return { ok: true, balance: p.balance };
  }

  playerCashout(socketId) {
    const p = this.players.get(socketId);
    if (!p || this.state !== 'flying' || p.cashedOut || p.betAmount <= 0) {
      return { ok: false, msg: 'Cashout impossible' };
    }
    p.cashedOut = true;
    const winAmount = Math.floor(p.betAmount * this.currentMult);
    p.balance += winAmount;
    const profit = winAmount - p.betAmount;
    p.betAmount = 0;
    return { ok: true, winAmount, profit, mult: this.currentMult, balance: p.balance };
  }

  addPlayer(socketId, name) {
    this.players.set(socketId, {
      name, balance: 1000, bet: 0, betAmount: 0, cashedOut: false
    });
    this.broadcast('room:playerCount', { count: this.players.size });
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
    this.broadcast('room:playerCount', { count: this.players.size });
    if (this.players.size === 0) {
      clearInterval(this.tickInterval);
      clearInterval(this.countdownInterval);
      delete rooms[this.code];
    }
  }
}

function getOrCreateRoom(code, name, flag) {
  if (!rooms[code]) rooms[code] = new GameRoom(code, name, flag);
  return rooms[code];
}

// ─── GEOLOCATION ──────────────────────────────────────────────
async function getCountry(ip) {
  // Strip IPv6 prefix
  const cleanIp = ip.replace(/^::ffff:/, '');
  // Localhost / private → default to CM for dev
  if (!cleanIp || cleanIp === '127.0.0.1' || cleanIp.startsWith('192.168') || cleanIp.startsWith('10.')) {
    return { code: 'CM', name: 'Cameroun', flag: '🇨🇲' };
  }
  try {
    const { data } = await axios.get(`http://ip-api.com/json/${cleanIp}?fields=countryCode,country`, { timeout: 3000 });
    return {
      code: data.countryCode || 'CM',
      name: data.country || 'Cameroun',
      flag: countryFlag(data.countryCode || 'CM')
    };
  } catch {
    return { code: 'CM', name: 'Cameroun', flag: '🇨🇲' };
  }
}

function countryFlag(code) {
  return code.toUpperCase().replace(/./g, c =>
    String.fromCodePoint(c.charCodeAt(0) + 127397)
  );
}

// ─── SOCKET.IO ────────────────────────────────────────────────
io.on('connection', async (socket) => {
  const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0] || socket.handshake.address;
  const geo = await getCountry(ip);

  // Join country room
  socket.join(geo.code);
  const room = getOrCreateRoom(geo.code, geo.name, geo.flag);
  const playerName = `Joueur_${Math.floor(Math.random() * 9000) + 1000}`;
  room.addPlayer(socket.id, playerName);

  // Send current state
  socket.emit('player:init', {
    name: playerName,
    balance: 1000,
    country: geo,
    roomState: room.getRoomInfo()
  });

  socket.on('player:bet', ({ amount }) => {
    const result = room.playerBet(socket.id, amount);
    socket.emit('player:betResult', result);
  });

  socket.on('player:cashout', () => {
    const result = room.playerCashout(socket.id);
    if (result.ok) socket.emit('player:cashoutResult', result);
  });

  socket.on('disconnect', () => {
    room.removePlayer(socket.id);
  });
});

// ─── START ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✈ Aviator server running on port ${PORT}`));
