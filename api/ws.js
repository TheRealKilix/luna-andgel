'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocket, WebSocketServer } = require('ws');
const { redis } = require('../lib/redis');

const TOKENS = { andgel: process.env.TOKEN_ANDGEL, luna: process.env.TOKEN_LUNA };
const CHANNEL = 'la:events';
const INSTANCE = crypto.randomUUID();
const sockets = new Map([['andgel', new Set()], ['luna', new Set()]]);
const sessions = new WeakMap();
const reader = redis?.duplicate({ maxRetriesPerRequest: null });
reader?.on('error', error => console.error('[relay] Redis subscription error:', error.message));
const other = who => who === 'andgel' ? 'luna' : 'andgel';
let connectionCount = 0;
let subscriptionPromise = null;
let unsubscribePromise = null;
let scheduleTimer = null;

const server = http.createServer((req, res) => {
  res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('WebSocket upgrade required');
});
const wss = new WebSocketServer({ server, maxPayload: 12 * 1024 * 1024 });

function sameToken(candidate, expected) {
  if (!candidate || !expected) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(ws, data) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(data), error => {
    if (error) console.error('[relay] WebSocket send failed:', error.message);
  });
}

function sendLocal(who, data) {
  for (const ws of sockets.get(who) || []) send(ws, data);
}

async function publish(who, data) {
  sendLocal(who, data);
  await redis.publish(CHANNEL, JSON.stringify({ origin: INSTANCE, who, data }));
}

async function enqueue(who, entry) {
  const result = await redis.eval(
    "if redis.call('LLEN', KEYS[1]) >= tonumber(ARGV[1]) then return 0 end; redis.call('RPUSH', KEYS[1], ARGV[2]); return 1",
    1,
    `la:pending:${who}`,
    500,
    JSON.stringify(entry)
  );
  return Number(result) === 1;
}

async function sendPending(ws, who) {
  const entries = await redis.lrange(`la:pending:${who}`, 0, -1);
  for (const encoded of entries) {
    const entry = JSON.parse(encoded);
    send(ws, { t: 'msg', id: entry.id, d: entry.d });
  }
}

async function acknowledge(who, id) {
  const key = `la:pending:${who}`;
  const entries = await redis.lrange(key, 0, -1);
  for (const encoded of entries) {
    if (JSON.parse(encoded).id === id) {
      await redis.lrem(key, 1, encoded);
      return;
    }
  }
}

function startSubscription() {
  if (!reader) return Promise.reject(new Error('REDIS_URL is not configured'));
  if (unsubscribePromise) return unsubscribePromise.then(() => startSubscription());
  if (!subscriptionPromise) {
    subscriptionPromise = reader.subscribe(CHANNEL).catch(error => {
      subscriptionPromise = null;
      throw error;
    });
  }
  return subscriptionPromise;
}

reader?.on('message', (channel, raw) => {
  if (channel !== CHANNEL) return;
  try {
    const event = JSON.parse(raw);
    if (event.origin !== INSTANCE) sendLocal(event.who, event.data);
  } catch (error) {
    console.error('[relay] Invalid Redis pub/sub event:', error.message);
  }
});

async function processDueSchedules() {
  const due = await redis.zrangebyscore('la:schedules', '-inf', Date.now(), 'LIMIT', 0, 50);
  for (const encoded of due) {
    const schedule = JSON.parse(encoded);
    if (!(await redis.zrem('la:schedules', encoded))) continue;
    const entry = {
      id: crypto.randomBytes(12).toString('hex'),
      d: schedule.d,
      clientId: schedule.clientId,
      scheduled: 1
    };
    if (!(await enqueue(schedule.recipient, entry))) {
      schedule.deliverAt = Date.now() + 30000;
      await redis.zadd('la:schedules', schedule.deliverAt, JSON.stringify(schedule));
      await publish(schedule.sender, { t: 'scheduleDelayed', clientId: schedule.clientId });
      continue;
    }
    await publish(schedule.recipient, { t: 'msg', id: entry.id, d: entry.d });
    await publish(schedule.sender, {
      t: 'scheduleFired',
      clientId: schedule.clientId,
      deliverAt: schedule.deliverAt
    });
  }
}

async function handleMessage(ws, message) {
  let data;
  try {
    data = JSON.parse(message.toString());
  } catch {
    return;
  }

  const state = sessions.get(ws);
  if (data.t === 'hi') {
    if (state || !['andgel', 'luna'].includes(data.who) ||
        !TOKENS[data.who] || !sameToken(data.tok, TOKENS[data.who])) {
      send(ws, { t: 'bad' });
      ws.close(1008, 'Invalid login');
      return;
    }
    if (typeof data.pub !== 'string' || data.pub.length > 2048) {
      send(ws, { t: 'bad' });
      ws.close(1008, 'Invalid public key');
      return;
    }
    await startSubscription();
    const who = data.who;
    const peer = other(who);
    const sessionId = crypto.randomUUID();
    sessions.set(ws, { who, sessionId });
    sockets.get(who).add(ws);
    const peerKey = await redis.get(`la:pub:${peer}`);
    const peerOnline = Boolean(await redis.get(`la:online:${peer}`));
    await redis.set(`la:pub:${who}`, data.pub);
    await redis.set(`la:online:${who}`, sessionId, 'EX', 90);
    send(ws, { t: 'peer', pub: peerKey || null, online: peerOnline });
    await sendPending(ws, who);
    await publish(peer, { t: 'presence', online: true });
    ws.relayHeartbeat = setInterval(() => {
      redis.set(`la:online:${who}`, sessionId, 'EX', 90).catch(error => {
        console.error('[relay] Presence refresh failed:', error.message);
      });
    }, 30000);
    void processDueSchedules().catch(error => console.error('[relay] Schedule check failed:', error.message));
    return;
  }

  if (!state) return;
  if (data.t === 'msg') {
    const payload = typeof data.d === 'string' ? data.d : '';
    const clientId = String(data.clientId || '').slice(0, 128);
    if (!payload || payload.length > 11 * 1024 * 1024) return;
    const recipient = other(state.who);
    const entry = { id: crypto.randomBytes(12).toString('hex'), d: payload, clientId };
    if (!(await enqueue(recipient, entry))) {
      send(ws, { t: 'queuefull' });
      return;
    }
    await publish(recipient, { t: 'msg', id: entry.id, d: entry.d });
    send(ws, { t: 'accepted', clientId });
  } else if (data.t === 'ack' && typeof data.id === 'string') {
    await acknowledge(state.who, data.id);
  } else if (data.t === 'schedule') {
    const deliverAt = Number(data.deliverAt);
    const clientId = String(data.clientId || '').slice(0, 128);
    const payload = typeof data.d === 'string' ? data.d : '';
    if (!clientId || !payload || payload.length > 11 * 1024 * 1024 ||
        deliverAt < Date.now() + 5000 || deliverAt > Date.now() + 30 * 86400000 ||
        await redis.zcard('la:schedules') >= 200) {
      send(ws, { t: 'scheduleRejected', clientId, reason: 'invalid' });
      return;
    }
    const item = {
      sender: state.who,
      recipient: other(state.who),
      clientId,
      d: payload,
      deliverAt
    };
    await redis.zadd('la:schedules', deliverAt, JSON.stringify(item));
    send(ws, { t: 'scheduleAccepted', clientId });
  } else if (data.t === 'cancelSchedule' && typeof data.clientId === 'string') {
    const items = await redis.zrange('la:schedules', 0, -1);
    for (const encoded of items) {
      const item = JSON.parse(encoded);
      if (item.sender === state.who && item.clientId === data.clientId) {
        await redis.zrem('la:schedules', encoded);
        send(ws, { t: 'scheduleCanceled', clientId: item.clientId });
        break;
      }
    }
  }
}

function closeSession(ws) {
  const state = sessions.get(ws);
  if (!state) return;
  sessions.delete(ws);
  clearInterval(ws.relayHeartbeat);
  sockets.get(state.who).delete(ws);
  void (async () => {
    const onlineKey = `la:online:${state.who}`;
    if (await redis.get(onlineKey) === state.sessionId) await redis.del(onlineKey);
    await publish(other(state.who), { t: 'presence', online: Boolean(await redis.get(onlineKey)) });
  })().catch(error => console.error('[relay] Disconnect cleanup failed:', error.message));
}

wss.on('connection', ws => {
  connectionCount++;
  void startSubscription().catch(error => {
    console.error('[relay] Redis subscription failed:', error.message);
    ws.close(1011, 'Relay unavailable');
  });
  if (!scheduleTimer) {
    scheduleTimer = setInterval(() => {
      void processDueSchedules().catch(error => console.error('[relay] Schedule check failed:', error.message));
    }, 30000);
  }
  let pending = Promise.resolve();
  ws.on('message', message => {
    pending = pending.then(() => handleMessage(ws, message)).catch(error => {
      console.error('[relay] Request failed:', error.message);
      send(ws, { t: 'relayError' });
      ws.close(1011, 'Relay unavailable');
    });
  });
  ws.on('close', () => {
    connectionCount = Math.max(0, connectionCount - 1);
    closeSession(ws);
    if (!connectionCount && scheduleTimer) {
      clearInterval(scheduleTimer);
      scheduleTimer = null;
    }
    if (!connectionCount && subscriptionPromise) {
      const currentSubscription = subscriptionPromise;
      subscriptionPromise = null;
      unsubscribePromise = currentSubscription
        .then(() => reader.unsubscribe(CHANNEL))
        .catch(error => console.error('[relay] Redis unsubscribe failed:', error.message))
        .finally(() => { unsubscribePromise = null; });
    }
  });
  ws.on('error', error => console.error('[relay] WebSocket error:', error.message));
});

module.exports = server;
