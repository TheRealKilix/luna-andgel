'use strict';

const { redis } = require('../lib/redis');

module.exports = async function health(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end('Method not allowed');
  }
  if (!redis) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ ok: false, error: 'REDIS_URL is not configured' }));
  }
  try {
    await redis.ping();
    const [andgel, luna, schedules] = await Promise.all([
      redis.llen('la:pending:andgel'),
      redis.llen('la:pending:luna'),
      redis.zcard('la:schedules')
    ]);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, pending: { andgel, luna }, schedules }));
  } catch (error) {
    console.error('[relay] Health check failed:', error.message);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: 'Redis is unavailable' }));
  }
};
