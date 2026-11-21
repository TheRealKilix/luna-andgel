'use strict';

const Redis = require('ioredis');

const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      retryStrategy: times => Math.min(times * 200, 5000)
    })
  : null;

redis?.on('error', error => console.error('[relay] Redis error:', error.message));

module.exports = { redis };
