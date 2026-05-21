const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const httpServer = createServer(app);

const DEFAULT_CORS_ORIGINS = [
  'http://localhost',
  'http://localhost:80',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1',
  'http://127.0.0.1:80',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001'
];
const parseAllowedOrigins = (value) => String(value || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const ALLOWED_CORS_ORIGINS = parseAllowedOrigins(process.env.CORS_ORIGINS || DEFAULT_CORS_ORIGINS.join(','));
const getHostname = (value) => {
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch (e) {
    return '';
  }
};
const isSameHostOrigin = (origin, host) => {
  if (!origin || !host) return false;
  return getHostname(origin) === getHostname(host);
};
const isAllowedRequestOrigin = (req) => {
  const origin = req.headers.origin;
  return !origin || ALLOWED_CORS_ORIGINS.includes(origin) || isSameHostOrigin(origin, req.headers.host);
};
const corsOptions = (req, callback) => {
  callback(null, { origin: isAllowedRequestOrigin(req) });
};
app.use((req, res, next) => {
  if (!isAllowedRequestOrigin(req)) {
    return res.status(403).json({ error: 'Origin not allowed.' });
  }
  next();
});
app.use(cors(corsOptions));

const pubClient = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
const subClient = pubClient.duplicate();
const dataClient = pubClient.duplicate();

Promise.all([pubClient.connect(), subClient.connect(), dataClient.connect()]).then(async () => {
  const io = new Server(httpServer, {
    cors: {
      origin(origin, callback) {
        callback(null, true);
      }
    },
    allowRequest: (req, callback) => callback(null, isAllowedRequestOrigin(req)),
    adapter: createAdapter(pubClient, subClient)
  });

  // --- API ROUTES FOR "NEWS DESK" ---

  const TOKEN_SECRET = process.env.AUTH_SECRET || 'change-this-secret-in-compose';
  const DEFAULT_ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
  const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
  const DEFAULT_FALLBACK_STREAM = process.env.FALLBACK_STREAM || '[SYSTEM] ALL STATIONS CLEAR // ROTATING TIMELINE STANDBY';
  const USERS_INDEX_KEY = 'users:index';
  const TICKERS_INDEX_KEY = 'tickers:index';
  const TEAMS_INDEX_KEY = 'teams:index';
  const UNASSIGNED_TEAM_KEY = '__unassigned__';
  const UNASSIGNED_TEAM_LABEL = 'Unassigned';
  const LOGIN_RATE_LIMIT_WINDOW_MS = parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || '600000', 10);
  const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = parseInt(process.env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS || '5', 10);
  const isUnassignedTeam = (team) => team === UNASSIGNED_TEAM_KEY ||
    normalizeTeam(team) === normalizeTeam(UNASSIGNED_TEAM_LABEL);
  const getStoredAssignmentTeam = (team) => isUnassignedTeam(team)
    ? UNASSIGNED_TEAM_KEY
    : String(team || '').trim();
  const hydratedIndexes = new Set();

  const scanKeys = async (pattern) => {
    const keys = [];
    for await (const key of dataClient.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      if (Array.isArray(key)) {
        keys.push(...key);
      } else {
        keys.push(key);
      }
    }
    return keys;
  };

  const listIndexedValues = async (indexKey, pattern, prefix) => {
    const values = new Set(await dataClient.sMembers(indexKey));

    if (!hydratedIndexes.has(indexKey)) {
      const keys = await scanKeys(pattern);
      const scannedValues = keys
        .filter(key => key !== indexKey && key.startsWith(prefix))
        .map(key => key.slice(prefix.length));

      for (const value of scannedValues) {
        values.add(value);
      }

      if (scannedValues.length > 0) {
        await dataClient.sAdd(indexKey, scannedValues);
      }
      hydratedIndexes.add(indexKey);
    }

    return Array.from(values);
  };

  const listUsernames = () => listIndexedValues(USERS_INDEX_KEY, 'users:*', 'users:');
  const listTickerIds = () => listIndexedValues(TICKERS_INDEX_KEY, 'tickers:*', 'tickers:');
  const listExpireKeys = (tickerId) => scanKeys(`expire:${tickerId}:*`);

  const base64UrlEncode = (value) => Buffer.from(value).toString('base64url');
  const base64UrlDecode = (value) => Buffer.from(value, 'base64url').toString('utf8');

  const signToken = (payload) => {
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const signature = crypto
      .createHmac('sha256', TOKEN_SECRET)
      .update(encodedPayload)
      .digest('base64url');
    return `${encodedPayload}.${signature}`;
  };

  const verifyToken = (token) => {
    try {
      if (!token || !token.includes('.')) return null;
      const [encodedPayload, signature] = token.split('.');
      const expectedSignature = crypto
        .createHmac('sha256', TOKEN_SECRET)
        .update(encodedPayload)
        .digest('base64url');

      if (signature.length !== expectedSignature.length) return null;
      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return null;

      const payload = JSON.parse(base64UrlDecode(encodedPayload));
      if (payload.exp && payload.exp < Date.now()) return null;
      return payload;
    } catch (e) {
      return null;
    }
  };

  const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => {
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return { salt, hash };
  };

  const verifyPassword = (password, salt, expectedHash) => {
    if (!salt || !expectedHash) return false;
    const { hash } = hashPassword(password, salt);
    if (hash.length !== expectedHash.length) return false;
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expectedHash));
  };

  const normalizeUsername = (username) => String(username || '').trim().toLowerCase();
  const normalizeTeam = (team) => String(team || '').trim().toLowerCase();
  const loginAttempts = new Map();
  const getRequestIp = (req) => String(req.ip || req.socket?.remoteAddress || 'unknown');
  const getLoginLimitKeys = (req, username) => [
    `ip:${getRequestIp(req)}`,
    `user:${normalizeUsername(username)}`
  ];
  const pruneLoginAttempts = (now = Date.now()) => {
    for (const [key, attempt] of loginAttempts.entries()) {
      if (attempt.resetAt <= now) loginAttempts.delete(key);
    }
  };
  const getLoginRetryAfterSeconds = (req, username) => {
    const now = Date.now();
    pruneLoginAttempts(now);
    const retryAfterMs = getLoginLimitKeys(req, username)
      .map(key => loginAttempts.get(key))
      .filter(attempt => attempt && attempt.count >= LOGIN_RATE_LIMIT_MAX_ATTEMPTS)
      .reduce((maxRetryAfter, attempt) => Math.max(maxRetryAfter, attempt.resetAt - now), 0);
    return retryAfterMs > 0 ? Math.ceil(retryAfterMs / 1000) : 0;
  };
  const recordFailedLoginAttempt = (req, username) => {
    const now = Date.now();
    pruneLoginAttempts(now);
    for (const key of getLoginLimitKeys(req, username)) {
      const current = loginAttempts.get(key);
      const nextAttempt = current && current.resetAt > now
        ? { count: current.count + 1, resetAt: current.resetAt }
        : { count: 1, resetAt: now + LOGIN_RATE_LIMIT_WINDOW_MS };
      loginAttempts.set(key, nextAttempt);
    }
  };
  const clearLoginAttempts = (req, username) => {
    for (const key of getLoginLimitKeys(req, username)) {
      loginAttempts.delete(key);
    }
  };
  const parseTeams = (value, fallbackTeam = '') => {
    let rawTeams = [];
    if (Array.isArray(value)) {
      rawTeams = value;
    } else if (typeof value === 'string' && value.trim().startsWith('[')) {
      try {
        rawTeams = JSON.parse(value);
      } catch (e) {
        rawTeams = [];
      }
    } else if (typeof value === 'string') {
      rawTeams = value.split(',');
    }

    if (rawTeams.length === 0 && fallbackTeam) rawTeams = [fallbackTeam];

    const seen = new Set();
    return rawTeams
      .map(team => String(team || '').trim())
      .filter(team => {
        const key = normalizeTeam(team);
        if (!key || isUnassignedTeam(team) || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  };
  const ensureTeams = async (teams) => {
    const resolvedTeams = parseTeams(teams);
    if (resolvedTeams.length > 0) {
      await dataClient.sAdd(TEAMS_INDEX_KEY, resolvedTeams);
    }
  };
  const listTeams = async () => {
    const teamsByKey = new Map();
    const addTeam = (team) => {
      const cleanedTeam = String(team || '').trim();
      const teamKey = normalizeTeam(cleanedTeam);
      if (!teamKey || isUnassignedTeam(cleanedTeam) || teamsByKey.has(teamKey)) return;
      teamsByKey.set(teamKey, cleanedTeam);
    };

    (await dataClient.sMembers(TEAMS_INDEX_KEY)).forEach(addTeam);

    for (const username of await listUsernames()) {
      const user = await dataClient.hGetAll(`users:${username}`);
      getUserTeams(user).forEach(addTeam);
    }

    for (const tickerId of await listTickerIds()) {
      const ticker = await dataClient.hGetAll(`tickers:${tickerId}`);
      if (ticker.unassigned === 'true' || isUnassignedTeam(ticker.team)) continue;
      addTeam(ticker.team);
    }

    const teams = Array.from(teamsByKey.values()).sort((a, b) => a.localeCompare(b));
    await ensureTeams(teams);
    return teams;
  };
  const getUserTeams = (user) => parseTeams(user.teams, user.team);
  const userHasTeam = (user, team) => {
    const teamKey = normalizeTeam(team);
    return Boolean(teamKey && getUserTeams(user).some(userTeam => normalizeTeam(userTeam) === teamKey));
  };

  const slugify = (value) => String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const slugifyPrefix = (value) => String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const getTickerPrefixForUser = (user, tickerScope = 'team') => {
    if (tickerScope === 'private') return slugifyPrefix(user.username);
    return slugifyPrefix(getUserTeams(user)[0]) || slugifyPrefix(user.username);
  };

  const getTickerTeamForUser = (user, tickerScope = 'team') => {
    if (user.role === 'admin') return String(user.adminTeam || '').trim();
    if (tickerScope === 'private') return '';
    return getUserTeams(user)[0] || '';
  };

  const getTickerIdForUser = (requestedId, user, tickerScope = 'team') => {
    const requestedSlug = slugify(requestedId);
    if (!requestedSlug) return '';
    if (user.role === 'admin') return requestedSlug;

    const prefix = getTickerPrefixForUser(user, tickerScope);
    if (requestedSlug.toLowerCase().startsWith(`${prefix.toLowerCase()}-`)) return requestedSlug;
    return `${prefix}-${requestedSlug}`;
  };

  const stripTickerPrefix = (tickerId, user) => {
    const prefixes = [
      ...getUserTeams(user).map(team => slugifyPrefix(team)),
      slugifyPrefix(user.username)
    ].filter(Boolean);

    for (const prefix of prefixes) {
      if (tickerId.toLowerCase().startsWith(`${prefix.toLowerCase()}-`)) {
        return tickerId.slice(prefix.length + 1);
      }
    }

    return tickerId;
  };

  const getUser = async (username) => {
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername) return null;
    const user = await dataClient.hGetAll(`users:${normalizedUsername}`);
    if (!user || !user.username) return null;
    return user;
  };

  const createUser = async ({ username, password, role = 'user', team = '', teams }) => {
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername || !password) {
      throw new Error('Username and password are required.');
    }

    const resolvedTeams = parseTeams(teams, team);
    const { salt, hash } = hashPassword(password);
    await dataClient.hSet(`users:${normalizedUsername}`, {
      username: normalizedUsername,
      passwordHash: hash,
      salt,
      role: role === 'admin' ? 'admin' : 'user',
      team: resolvedTeams[0] || '',
      teams: JSON.stringify(resolvedTeams),
      createdAt: new Date().toISOString()
    });
    await ensureTeams(resolvedTeams);
    await dataClient.sAdd(USERS_INDEX_KEY, normalizedUsername);
  };

  const ensureAdminUser = async () => {
    const admin = await getUser(DEFAULT_ADMIN_USERNAME);
    if (!admin) {
      await createUser({
        username: DEFAULT_ADMIN_USERNAME,
        password: DEFAULT_ADMIN_PASSWORD,
        role: 'admin'
      });
    }
  };

  const requireAuth = async (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const payload = verifyToken(token);

    if (!payload?.username) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const user = await getUser(payload.username);
    if (!user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const teams = getUserTeams(user);
    req.user = {
      username: user.username,
      role: user.role || 'user',
      team: teams[0] || '',
      teams,
      teamKeys: teams.map(normalizeTeam)
    };
    next();
  };

  const requireAdmin = (req, res, next) => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    next();
  };

  const userCanManageTicker = async (user, tickerId) => {
    if (user.role === 'admin') return true;
    const ticker = await dataClient.hGetAll(`tickers:${tickerId}`);
    if (!ticker || !ticker.owner) return false;
    if (ticker.owner === user.username) return true;
    if (isUnassignedTeam(ticker.team) || ticker.unassigned === 'true') return false;

    const tickerTeam = normalizeTeam(ticker.team);
    return Boolean(tickerTeam && (user.teamKeys || []).includes(tickerTeam));
  };

  await ensureAdminUser();

  const PRIORITY_SCORE_BASE = {
    breaking: 1000000,
    normal: 0
  };

  const normalizePriority = (priority) => priority === 'breaking' ? 'breaking' : 'normal';

  const parseHeadlineElement = (el) => {
    const item = JSON.parse(el.value);
    const legacyPriority = el.score === 100 ? 'breaking' : 'normal';
    return { ...item, priority: normalizePriority(item.priority || legacyPriority) };
  };

  const getOrderedHeadlines = async (tickerId) => {
    const elements = await dataClient.zRangeWithScores(`headlines:active:${tickerId}`, 0, -1);
    const ordered = elements
      .map(el => ({ headline: parseHeadlineElement(el), score: el.score }))
      .sort((a, b) => {
        const priorityDiff = PRIORITY_SCORE_BASE[b.headline.priority] - PRIORITY_SCORE_BASE[a.headline.priority];
        if (priorityDiff !== 0) return priorityDiff;
        return b.score - a.score;
      })
      .map(item => item.headline);

    return Promise.all(ordered.map(async (headline) => {
      const ttlSeconds = await dataClient.ttl(`expire:${tickerId}:${headline.id}`);
      const expiresInSeconds = ttlSeconds > 0 ? ttlSeconds : 0;
      return {
        ...headline,
        expiresInSeconds,
        expiresAt: expiresInSeconds > 0 ? Date.now() + expiresInSeconds * 1000 : null
      };
    }));
  };

  const getNextHeadlineScore = async (tickerId, priority) => {
    const normalizedPriority = normalizePriority(priority);
    const elements = await dataClient.zRangeWithScores(`headlines:active:${tickerId}`, 0, -1);
    const groupScores = elements
      .filter(el => parseHeadlineElement(el).priority === normalizedPriority)
      .map(el => el.score);
    const baseScore = PRIORITY_SCORE_BASE[normalizedPriority];
    const maxScore = groupScores.length > 0 ? Math.max(...groupScores) : baseScore;
    return Math.max(maxScore + 1, baseScore + 1);
  };

  const setTickerEmergencyMode = async (tickerId, active) => {
    const mode = active ? 'emergency alert' : 'normal';
    const currentMode = await dataClient.hGet(`tickers:${tickerId}`, 'mode') || 'normal';

    if (currentMode === mode) return;

    await dataClient.hSet(`tickers:${tickerId}`, 'mode', mode);
    io.emit('tickers_updated');
    io.to(`ticker_${tickerId}`).emit('mode_changed', { mode });
  };

  const tickerHasBreakingHeadlines = async (tickerId) => {
    const elements = await dataClient.zRangeWithScores(`headlines:active:${tickerId}`, 0, -1);
    return elements.some(el => parseHeadlineElement(el).priority === 'breaking');
  };

  const migrateOwnedTickersForTeamChange = async (username, oldTeam, newTeam, role) => {
    if (role === 'admin') return [];
    await ensureTeams([newTeam]);

    const tickerIds = await listTickerIds();
    const migrations = [];

    for (const oldTickerId of tickerIds) {
      const key = `tickers:${oldTickerId}`;
      const ticker = await dataClient.hGetAll(key);
      if (ticker.owner !== username) continue;
      if (!normalizeTeam(ticker.team) || normalizeTeam(ticker.team) !== normalizeTeam(oldTeam)) continue;

      const baseSlug = stripTickerPrefix(oldTickerId, { username, team: oldTeam });
      const newTickerId = getTickerIdForUser(baseSlug, { username, role: 'user', team: newTeam });
      if (!newTickerId || oldTickerId === newTickerId) {
        await dataClient.hSet(key, 'team', String(newTeam || '').trim());
        continue;
      }

      migrations.push({ oldTickerId, newTickerId, ticker });
    }

    for (const migration of migrations) {
      const targetExists = await dataClient.exists(`tickers:${migration.newTickerId}`);
      if (targetExists) {
        throw new Error(`Ticker URL /${migration.newTickerId} already exists.`);
      }

      const targetHeadlinesExist = await dataClient.exists(`headlines:active:${migration.newTickerId}`);
      if (targetHeadlinesExist) {
        throw new Error(`Headline queue for /${migration.newTickerId} already exists.`);
      }
    }

    for (const { oldTickerId, newTickerId, ticker } of migrations) {
      await dataClient.hSet(`tickers:${newTickerId}`, {
        ...ticker,
        team: String(newTeam || '').trim()
      });
      await dataClient.del(`tickers:${oldTickerId}`);
      await dataClient.sRem(TICKERS_INDEX_KEY, oldTickerId);
      await dataClient.sAdd(TICKERS_INDEX_KEY, newTickerId);

      if (await dataClient.exists(`headlines:active:${oldTickerId}`)) {
        await dataClient.rename(`headlines:active:${oldTickerId}`, `headlines:active:${newTickerId}`);
      }

      const expireKeys = await listExpireKeys(oldTickerId);
      for (const expireKey of expireKeys) {
        const headlineId = expireKey.split(':').slice(2).join(':');
        await dataClient.rename(expireKey, `expire:${newTickerId}:${headlineId}`);
      }

      io.to(`ticker_${oldTickerId}`).emit('ticker_deleted');
    }

    return migrations;
  };

  const migrateOwnedTickersForUsernameChange = async (oldUsername, newUsername, team, role) => {
    const tickerIds = await listTickerIds();
    const migrations = [];
    const ownerUpdates = [];

    for (const oldTickerId of tickerIds) {
      const key = `tickers:${oldTickerId}`;
      const ticker = await dataClient.hGetAll(key);
      if (ticker.owner !== oldUsername) continue;

      if (role === 'admin' || normalizeTeam(ticker.team)) {
        ownerUpdates.push(key);
        continue;
      }

      const baseSlug = stripTickerPrefix(oldTickerId, { username: oldUsername, team });
      const newTickerId = getTickerIdForUser(baseSlug, { username: newUsername, role: 'user', team: '' }, 'private');

      if (!newTickerId || oldTickerId === newTickerId) {
        ownerUpdates.push(key);
        continue;
      }

      migrations.push({ oldTickerId, newTickerId, ticker });
    }

    for (const migration of migrations) {
      const targetExists = await dataClient.exists(`tickers:${migration.newTickerId}`);
      if (targetExists) {
        throw new Error(`Ticker URL /${migration.newTickerId} already exists.`);
      }

      const targetHeadlinesExist = await dataClient.exists(`headlines:active:${migration.newTickerId}`);
      if (targetHeadlinesExist) {
        throw new Error(`Headline queue for /${migration.newTickerId} already exists.`);
      }
    }

    for (const key of ownerUpdates) {
      await dataClient.hSet(key, 'owner', newUsername);
    }

    for (const { oldTickerId, newTickerId, ticker } of migrations) {
      await dataClient.hSet(`tickers:${newTickerId}`, {
        ...ticker,
        owner: newUsername
      });
      await dataClient.del(`tickers:${oldTickerId}`);
      await dataClient.sRem(TICKERS_INDEX_KEY, oldTickerId);
      await dataClient.sAdd(TICKERS_INDEX_KEY, newTickerId);

      if (await dataClient.exists(`headlines:active:${oldTickerId}`)) {
        await dataClient.rename(`headlines:active:${oldTickerId}`, `headlines:active:${newTickerId}`);
      }

      const expireKeys = await listExpireKeys(oldTickerId);
      for (const expireKey of expireKeys) {
        const headlineId = expireKey.split(':').slice(2).join(':');
        await dataClient.rename(expireKey, `expire:${newTickerId}:${headlineId}`);
      }

      io.to(`ticker_${oldTickerId}`).emit('ticker_deleted');
    }

    return migrations;
  };

  const moveTickerToTeam = async (tickerId, newTeam) => {
    const key = `tickers:${tickerId}`;
    const ticker = await dataClient.hGetAll(key);

    if (!ticker || !ticker.owner) {
      throw new Error('Ticker not found.');
    }

    const owner = await getUser(ticker.owner);
    const ownerRole = owner?.role || 'user';
    const ownerTeam = String(ticker.team || '').trim();
    const targetTeam = getStoredAssignmentTeam(newTeam);
    const isTargetUnassigned = targetTeam === UNASSIGNED_TEAM_KEY;
    await ensureTeams([targetTeam]);
    const targetScope = targetTeam ? 'team' : 'private';
    const baseSlug = stripTickerPrefix(tickerId, { username: ticker.owner, team: ownerTeam });
    const nextTickerId = getTickerIdForUser(
      baseSlug,
      { username: ticker.owner, role: ownerRole, team: targetTeam },
      targetScope
    );

    if (!nextTickerId) {
      throw new Error('Ticker ID is required.');
    }

    if (nextTickerId === tickerId) {
      await dataClient.hSet(key, {
        team: targetTeam,
        unassigned: isTargetUnassigned ? 'true' : 'false'
      });
      return { oldTickerId: tickerId, newTickerId: tickerId };
    }

    if (await dataClient.exists(`tickers:${nextTickerId}`)) {
      throw new Error(`Ticker URL /${nextTickerId} already exists.`);
    }

    if (await dataClient.exists(`headlines:active:${nextTickerId}`)) {
      throw new Error(`Headline queue for /${nextTickerId} already exists.`);
    }

    await dataClient.hSet(`tickers:${nextTickerId}`, {
      ...ticker,
      team: targetTeam,
      unassigned: isTargetUnassigned ? 'true' : 'false'
    });
    await dataClient.del(key);
    await dataClient.sRem(TICKERS_INDEX_KEY, tickerId);
    await dataClient.sAdd(TICKERS_INDEX_KEY, nextTickerId);

    if (await dataClient.exists(`headlines:active:${tickerId}`)) {
      await dataClient.rename(`headlines:active:${tickerId}`, `headlines:active:${nextTickerId}`);
    }

    const expireKeys = await listExpireKeys(tickerId);
    for (const expireKey of expireKeys) {
      const headlineId = expireKey.split(':').slice(2).join(':');
      await dataClient.rename(expireKey, `expire:${nextTickerId}:${headlineId}`);
    }

    io.to(`ticker_${tickerId}`).emit('ticker_deleted');
    return { oldTickerId: tickerId, newTickerId: nextTickerId };
  };

  const moveTickerToOwner = async (tickerId, newOwner) => {
    const key = `tickers:${tickerId}`;
    const ticker = await dataClient.hGetAll(key);

    if (!ticker || !ticker.owner) {
      throw new Error('Ticker not found.');
    }

    const owner = await getUser(newOwner);
    if (!owner) {
      throw new Error('Owner must be an existing user.');
    }

    const tickerTeam = String(ticker.team || '').trim();
    if (normalizeTeam(tickerTeam)) {
      await dataClient.hSet(key, 'owner', owner.username);
      return { oldTickerId: tickerId, newTickerId: tickerId };
    }

    const baseSlug = stripTickerPrefix(tickerId, { username: ticker.owner, team: tickerTeam });
    const nextTickerId = getTickerIdForUser(
      baseSlug,
      { username: owner.username, role: owner.role || 'user', team: tickerTeam },
      'private'
    );

    if (!nextTickerId) {
      throw new Error('Ticker ID is required.');
    }

    if (nextTickerId === tickerId) {
      await dataClient.hSet(key, 'owner', owner.username);
      return { oldTickerId: tickerId, newTickerId: tickerId };
    }

    if (await dataClient.exists(`tickers:${nextTickerId}`)) {
      throw new Error(`Ticker URL /${nextTickerId} already exists.`);
    }

    if (await dataClient.exists(`headlines:active:${nextTickerId}`)) {
      throw new Error(`Headline queue for /${nextTickerId} already exists.`);
    }

    await dataClient.hSet(`tickers:${nextTickerId}`, {
      ...ticker,
      owner: owner.username
    });
    await dataClient.del(key);
    await dataClient.sRem(TICKERS_INDEX_KEY, tickerId);
    await dataClient.sAdd(TICKERS_INDEX_KEY, nextTickerId);

    if (await dataClient.exists(`headlines:active:${tickerId}`)) {
      await dataClient.rename(`headlines:active:${tickerId}`, `headlines:active:${nextTickerId}`);
    }

    const expireKeys = await listExpireKeys(tickerId);
    for (const expireKey of expireKeys) {
      const headlineId = expireKey.split(':').slice(2).join(':');
      await dataClient.rename(expireKey, `expire:${nextTickerId}:${headlineId}`);
    }

    io.to(`ticker_${tickerId}`).emit('ticker_deleted');
    return { oldTickerId: tickerId, newTickerId: nextTickerId };
  };

  // Authentication
  app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const retryAfterSeconds = getLoginRetryAfterSeconds(req, username);
    if (retryAfterSeconds > 0) {
      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
    }

    const user = await getUser(username);

    if (!user || !verifyPassword(password || '', user.salt, user.passwordHash)) {
      recordFailedLoginAttempt(req, username);
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    clearLoginAttempts(req, username);

    const token = signToken({
      username: user.username,
      role: user.role || 'user',
      team: getUserTeams(user)[0] || '',
      exp: Date.now() + 1000 * 60 * 60 * 24 * 7
    });

    res.json({
      token,
      user: { username: user.username, role: user.role || 'user', team: getUserTeams(user)[0] || '', teams: getUserTeams(user) }
    });
  });

  app.get('/api/auth/me', requireAuth, async (req, res) => {
    res.json({ user: req.user });
  });

  app.get('/api/teams', requireAuth, requireAdmin, async (req, res) => {
    res.json(await listTeams());
  });

  app.post('/api/teams', requireAuth, requireAdmin, async (req, res) => {
    const [team] = parseTeams([req.body.team]);
    if (!team) {
      return res.status(400).json({ error: 'Team name is required.' });
    }

    const teams = await listTeams();
    if (teams.some(existingTeam => normalizeTeam(existingTeam) === normalizeTeam(team))) {
      return res.status(409).json({ error: 'Team already exists.' });
    }

    await ensureTeams([team]);
    res.json({ success: true, team });
  });

  app.patch('/api/teams/:team', requireAuth, requireAdmin, async (req, res) => {
    const oldTeam = String(req.params.team || '').trim();
    const [newTeam] = parseTeams([req.body.team]);

    if (!oldTeam || isUnassignedTeam(oldTeam)) {
      return res.status(400).json({ error: 'This team cannot be edited.' });
    }

    if (!newTeam) {
      return res.status(400).json({ error: 'Team name is required.' });
    }

    if (oldTeam === newTeam) {
      await dataClient.sRem(TEAMS_INDEX_KEY, oldTeam);
      await ensureTeams([newTeam]);
      return res.json({ success: true });
    }

    const teams = await listTeams();
    if (!teams.some(team => normalizeTeam(team) === normalizeTeam(oldTeam))) {
      return res.status(404).json({ error: 'Team not found.' });
    }

    if (
      normalizeTeam(oldTeam) !== normalizeTeam(newTeam) &&
      teams.some(team => normalizeTeam(team) === normalizeTeam(newTeam))
    ) {
      return res.status(409).json({ error: 'Team already exists.' });
    }

    const migrations = [];
    const tickerIds = await listTickerIds();

    try {
      for (const tickerId of tickerIds) {
        const ticker = await dataClient.hGetAll(`tickers:${tickerId}`);
        if (ticker.unassigned === 'true' || normalizeTeam(ticker.team) !== normalizeTeam(oldTeam)) continue;
        migrations.push(await moveTickerToTeam(tickerId, newTeam));
      }
    } catch (e) {
      return res.status(409).json({ error: e.message });
    }

    for (const username of await listUsernames()) {
      const user = await dataClient.hGetAll(`users:${username}`);
      const updatedTeams = getUserTeams(user).map(team => (
        normalizeTeam(team) === normalizeTeam(oldTeam) ? newTeam : team
      ));
      if (JSON.stringify(updatedTeams) !== JSON.stringify(getUserTeams(user))) {
        await dataClient.hSet(`users:${username}`, {
          team: updatedTeams[0] || '',
          teams: JSON.stringify(updatedTeams)
        });
      }
    }

    await dataClient.sRem(TEAMS_INDEX_KEY, oldTeam);
    await ensureTeams([newTeam]);
    io.emit('tickers_updated');
    res.json({ success: true, migrations });
  });

  app.delete('/api/teams/:team', requireAuth, requireAdmin, async (req, res) => {
    const team = String(req.params.team || '').trim();
    if (!team || isUnassignedTeam(team)) {
      return res.status(400).json({ error: 'This team cannot be deleted.' });
    }

    const teams = await listTeams();
    if (!teams.some(existingTeam => normalizeTeam(existingTeam) === normalizeTeam(team))) {
      return res.status(404).json({ error: 'Team not found.' });
    }

    const migrations = [];
    const tickerIds = await listTickerIds();

    try {
      for (const tickerId of tickerIds) {
        const ticker = await dataClient.hGetAll(`tickers:${tickerId}`);
        if (ticker.unassigned === 'true' || normalizeTeam(ticker.team) !== normalizeTeam(team)) continue;
        migrations.push(await moveTickerToTeam(tickerId, ''));
      }
    } catch (e) {
      return res.status(409).json({ error: e.message });
    }

    for (const username of await listUsernames()) {
      const user = await dataClient.hGetAll(`users:${username}`);
      const updatedTeams = getUserTeams(user).filter(userTeam => normalizeTeam(userTeam) !== normalizeTeam(team));
      if (updatedTeams.length !== getUserTeams(user).length) {
        await dataClient.hSet(`users:${username}`, {
          team: updatedTeams[0] || '',
          teams: JSON.stringify(updatedTeams)
        });
      }
    }

    await dataClient.sRem(TEAMS_INDEX_KEY, team);
    io.emit('tickers_updated');
    res.json({ success: true, migrations });
  });

  app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
    const usernames = await listUsernames();
    const users = [];

    for (const username of usernames) {
      const user = await dataClient.hGetAll(`users:${username}`);
      if (user.username) {
        users.push({
          username: user.username,
          role: user.role || 'user',
          team: getUserTeams(user)[0] || '',
          teams: getUserTeams(user),
          createdAt: user.createdAt || ''
        });
      }
    }

    users.sort((a, b) => a.username.localeCompare(b.username));
    res.json(users);
  });

  app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
    const { username, password, role, team, teams } = req.body;
    const normalizedUsername = normalizeUsername(username);

    if (!normalizedUsername || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    if (await getUser(normalizedUsername)) {
      return res.status(409).json({ error: 'User already exists.' });
    }

    await createUser({ username: normalizedUsername, password, role, team, teams });
    res.json({ success: true });
  });

  app.patch('/api/users/:username', requireAuth, requireAdmin, async (req, res) => {
    const username = normalizeUsername(req.params.username);
    const existingUser = await getUser(username);

    if (!existingUser) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const updates = {};
    const newUsername = req.body.username !== undefined ? normalizeUsername(req.body.username) : username;
    const oldTeams = getUserTeams(existingUser);
    const oldTeam = oldTeams[0] || '';
    const requestedTeams = req.body.teams !== undefined
      ? parseTeams(req.body.teams)
      : parseTeams(req.body.team, oldTeam);
    const newTeam = requestedTeams[0] || '';
    const newRole = req.body.role !== undefined ? (req.body.role === 'admin' ? 'admin' : 'user') : (existingUser.role || 'user');

    if (!newUsername) {
      return res.status(400).json({ error: 'Username is required.' });
    }

    if (newUsername !== username && await getUser(newUsername)) {
      return res.status(409).json({ error: 'User already exists.' });
    }

    if (req.body.username !== undefined) {
      updates.username = newUsername;
    }

    if (req.body.role !== undefined) {
      updates.role = newRole;
    }
    if (req.body.team !== undefined || req.body.teams !== undefined) {
      updates.team = newTeam;
      updates.teams = JSON.stringify(requestedTeams);
      await ensureTeams(requestedTeams);
    }
    if (req.body.password) {
      const { salt, hash } = hashPassword(req.body.password);
      updates.salt = salt;
      updates.passwordHash = hash;
    }

    let migrations = [];
    if (newUsername !== username) {
      try {
        migrations = migrations.concat(await migrateOwnedTickersForUsernameChange(
          username,
          newUsername,
          oldTeam,
          existingUser.role || 'user'
        ));
      } catch (e) {
        return res.status(409).json({ error: e.message });
      }
    }

    if ((req.body.team !== undefined || req.body.teams !== undefined) && oldTeam !== newTeam) {
      try {
        migrations = migrations.concat(await migrateOwnedTickersForTeamChange(
          newUsername,
          oldTeam,
          newTeam,
          newRole
        ));
      } catch (e) {
        return res.status(409).json({ error: e.message });
      }
    }

    if (Object.keys(updates).length > 0) {
      await dataClient.hSet(`users:${newUsername}`, {
        ...existingUser,
        ...updates,
        username: newUsername
      });
      if (newUsername !== username) {
        await dataClient.del(`users:${username}`);
        await dataClient.sRem(USERS_INDEX_KEY, username);
        await dataClient.sAdd(USERS_INDEX_KEY, newUsername);
      }
    }

    if (migrations.length > 0) {
      io.emit('tickers_updated');
    }

    res.json({ success: true, migrations: migrations.map(({ oldTickerId, newTickerId }) => ({ oldTickerId, newTickerId })) });
  });

  app.patch('/api/auth/password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const user = await getUser(req.user.username);

    if (!newPassword) {
      return res.status(400).json({ error: 'New password is required.' });
    }

    if (!user || !verifyPassword(currentPassword || '', user.salt, user.passwordHash)) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const { salt, hash } = hashPassword(newPassword);
    await dataClient.hSet(`users:${req.user.username}`, {
      salt,
      passwordHash: hash
    });

    res.json({ success: true });
  });

  app.delete('/api/users/:username', requireAuth, requireAdmin, async (req, res) => {
    const username = normalizeUsername(req.params.username);

    if (username === req.user.username) {
      return res.status(400).json({ error: 'You cannot delete your own user.' });
    }

    const user = await getUser(username);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const reassignedTickers = [];
    const tickerIds = await listTickerIds();
    for (const tickerId of tickerIds) {
      const ticker = await dataClient.hGetAll(`tickers:${tickerId}`);
      if (ticker.owner !== username) continue;

      await dataClient.hSet(`tickers:${tickerId}`, {
        owner: req.user.username,
        team: UNASSIGNED_TEAM_KEY,
        unassigned: 'true'
      });
      reassignedTickers.push(tickerId);
      io.to(`ticker_${tickerId}`).emit('config_changed', {
        badge: ticker.badge !== undefined ? ticker.badge : 'NEWS',
        badgeType: ticker.badgeType || 'text',
        speed: parseInt(ticker.speed || '20', 10),
        mode: ticker.mode || 'normal',
        colorBg: ticker.colorBg || '#141414',
        colorText: ticker.colorText || '#ffffff',
        colorBadgeBg: ticker.colorBadgeBg || '#d32f2f',
        colorBadgeText: ticker.colorBadgeText || '#ffffff',
        colorRegion: ticker.colorRegion || '#ff3333',
        fontFamily: ticker.fontFamily || 'sans-serif',
        continuousMode: ticker.continuousMode === 'true',
        fallbackMessage: ticker.fallbackMode === 'blank' ? '' : (ticker.fallbackMessage || DEFAULT_FALLBACK_STREAM),
        fallbackMode: ticker.fallbackMode || 'default'
      });
    }

    await dataClient.del(`users:${username}`);
    await dataClient.sRem(USERS_INDEX_KEY, username);
    io.emit('tickers_updated');
    res.json({ success: true, reassignedTickers });
  });

  // Get all tickers
  app.get('/api/tickers', requireAuth, async (req, res) => {
    const tickerIds = await listTickerIds();
    const tickers = [];
    for (const id of tickerIds) {
      const data = await dataClient.hGetAll(`tickers:${id}`);
      if (!data || (!data.owner && !data.team && !data.badge)) continue;

      const isUnassigned = data.unassigned === 'true' || isUnassignedTeam(data.team);
      const tickerTeam = isUnassigned ? '' : normalizeTeam(data.team);
      const canViewTicker = !isUnassigned && (
        data.owner === req.user.username ||
        Boolean(tickerTeam && (req.user.teamKeys || []).includes(tickerTeam))
      );
      if (req.user.role !== 'admin' && !canViewTicker) continue;

      tickers.push({
        id,
        owner: data.owner || '',
        team: isUnassigned ? UNASSIGNED_TEAM_LABEL : String(data.team || '').trim(),
        unassigned: isUnassigned,
        sortOrder: parseInt(data.sortOrder || '0', 10),
        badge: data.badge !== undefined ? data.badge : 'NEWS',
        badgeType: data.badgeType || 'text',
        speed: parseInt(data.speed || '20', 10),
        mode: data.mode || 'normal',
        colorBg: data.colorBg || '#141414',
        colorText: data.colorText || '#ffffff',
        colorBadgeBg: data.colorBadgeBg || '#d32f2f',
        colorBadgeText: data.colorBadgeText || '#ffffff',
        colorRegion: data.colorRegion || '#ff3333',
        fontFamily: data.fontFamily || 'sans-serif',
        continuousMode: data.continuousMode === 'true',
        fallbackMessage: data.fallbackMode === 'blank' ? '' : (data.fallbackMessage || DEFAULT_FALLBACK_STREAM),
        fallbackMode: data.fallbackMode || 'default'
      });
    }
    tickers.sort((a, b) => {
      const orderDiff = (a.sortOrder || 0) - (b.sortOrder || 0);
      if (orderDiff !== 0) return orderDiff;
      return a.id.localeCompare(b.id);
    });
    res.json(tickers);
  });

  // Create or Update a ticker
  app.post('/api/tickers', requireAuth, async (req, res) => {
    const { id, badge, badgeType, speed, colorBg, colorText, colorBadgeBg, colorBadgeText, colorRegion, fontFamily, continuousMode, fallbackMessage, fallbackMode, tickerScope, adminTeam, team } = req.body;
    const resolvedTickerScope = tickerScope === 'private' ? 'private' : 'team';
    const requestedTeam = String(team || '').trim();
    if (req.user.role !== 'admin' && resolvedTickerScope === 'team' && requestedTeam && !userHasTeam(req.user, requestedTeam)) {
      return res.status(403).json({ error: 'You can only create tickers for one of your teams.' });
    }
    const tickerUser = req.user.role === 'admin'
      ? { ...req.user, adminTeam }
      : { ...req.user, team: requestedTeam || req.user.team, teams: requestedTeam ? [requestedTeam] : req.user.teams };
    const tickerId = getTickerIdForUser(id, tickerUser, resolvedTickerScope);

    if (!tickerId || tickerId.endsWith('-')) {
      return res.status(400).json({ error: 'Ticker ID is required.' });
    }

    const key = `tickers:${tickerId}`;
    const existingOwner = await dataClient.hGet(key, 'owner');
    const existingTeam = await dataClient.hGet(key, 'team');

    if (existingOwner && !await userCanManageTicker(req.user, tickerId)) {
      return res.status(403).json({ error: 'You cannot update another user ticker.' });
    }

    // Check if updating or creating to preserve mode
    const currentMode = await dataClient.hGet(key, 'mode') || 'normal';
    const resolvedContinuousMode = continuousMode === true || continuousMode === 'true';
    const resolvedFallbackMode = fallbackMode === 'blank' ? 'blank' : (fallbackMessage ? 'custom' : 'default');
    const resolvedFallbackMessage = resolvedFallbackMode === 'blank' ? '' : (fallbackMessage || DEFAULT_FALLBACK_STREAM);
    const currentSortOrder = await dataClient.hGet(key, 'sortOrder');
    const sortOrder = currentSortOrder || String(Date.now());
    const resolvedTickerTeam = existingTeam !== null ? existingTeam : getTickerTeamForUser(tickerUser, resolvedTickerScope);
    await ensureTeams([resolvedTickerTeam]);

    await dataClient.hSet(key, {
      owner: existingOwner || req.user.username,
      team: resolvedTickerTeam,
      badge: badge !== undefined ? badge : '',
      badgeType: badgeType || 'text',
      speed: speed !== undefined ? String(speed) : '20',
      mode: currentMode,
      sortOrder,
      unassigned: isUnassignedTeam(existingTeam) ? 'true' : 'false',
      colorBg: colorBg || '#141414',
      colorText: colorText || '#ffffff',
      colorBadgeBg: colorBadgeBg || '#d32f2f',
      colorBadgeText: colorBadgeText || '#ffffff',
      colorRegion: colorRegion || '#ff3333',
      fontFamily: fontFamily || 'sans-serif',
      continuousMode: resolvedContinuousMode ? 'true' : 'false',
      fallbackMessage: resolvedFallbackMessage,
      fallbackMode: resolvedFallbackMode
    });
    await dataClient.sAdd(TICKERS_INDEX_KEY, tickerId);

    io.emit('tickers_updated');
    io.to(`ticker_${tickerId}`).emit('config_changed', {
      badge, badgeType, speed: parseInt(speed), mode: currentMode, colorBg, colorText, colorBadgeBg, colorBadgeText, colorRegion, fontFamily, continuousMode: resolvedContinuousMode, fallbackMessage: resolvedFallbackMessage, fallbackMode: resolvedFallbackMode
    });
    res.json({ success: true, id: tickerId });
  });

  app.patch('/api/tickers/:id/assignment', requireAuth, async (req, res) => {
    const { id } = req.params;
    const requestedTeam = String(req.body.team || '').trim();
    const ticker = await dataClient.hGetAll(`tickers:${id}`);

    if (!ticker || !ticker.owner) {
      return res.status(404).json({ error: 'Ticker not found.' });
    }

    if (req.user.role !== 'admin') {
      if (ticker.owner !== req.user.username) {
        return res.status(403).json({ error: 'Only the ticker owner can change assignment.' });
      }

      if (requestedTeam && !userHasTeam(req.user, requestedTeam)) {
        return res.status(403).json({ error: 'You can only assign tickers to one of your teams.' });
      }
    }

    try {
      const migration = await moveTickerToTeam(id, requestedTeam);
      io.emit('tickers_updated');
      res.json({ success: true, ...migration });
    } catch (e) {
      res.status(409).json({ error: e.message });
    }
  });

  app.patch('/api/tickers/:id/owner', requireAuth, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const owner = normalizeUsername(req.body.owner);

    if (!owner || !await getUser(owner)) {
      return res.status(400).json({ error: 'Owner must be an existing user.' });
    }

    try {
      const migration = await moveTickerToOwner(id, owner);
      io.emit('tickers_updated');
      res.json({ success: true, ...migration });
    } catch (e) {
      const status = e.message === 'Ticker not found.' ? 404 : 409;
      res.status(status).json({ error: e.message });
    }
  });

  app.patch('/api/tickers/order', requireAuth, requireAdmin, async (req, res) => {
    const { tickerIds } = req.body;

    if (!Array.isArray(tickerIds)) {
      return res.status(400).json({ error: 'tickerIds must be an array.' });
    }

    for (const [index, tickerId] of tickerIds.entries()) {
      if (await dataClient.exists(`tickers:${tickerId}`)) {
        await dataClient.hSet(`tickers:${tickerId}`, 'sortOrder', String(index + 1));
      }
    }

    io.emit('tickers_updated');
    res.json({ success: true });
  });

  // Delete Ticker
  app.delete('/api/tickers/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    const ticker = await dataClient.hGetAll(`tickers:${id}`);
    if (!ticker || !ticker.owner) {
      return res.status(404).json({ error: 'Ticker not found.' });
    }

    if (req.user.role !== 'admin' && ticker.owner !== req.user.username) {
      return res.status(403).json({ error: 'You cannot delete this ticker.' });
    }

    await dataClient.del(`tickers:${id}`);
    await dataClient.sRem(TICKERS_INDEX_KEY, id);
    await dataClient.del(`headlines:active:${id}`);
    const expireKeys = await listExpireKeys(id);
    for (const expireKey of expireKeys) {
      await dataClient.del(expireKey);
    }
    io.emit('tickers_updated');
    io.to(`ticker_${id}`).emit('ticker_deleted');
    res.json({ success: true });
  });

  // Get Headlines for a Ticker
  app.get('/api/tickers/:id/headlines', async (req, res) => {
    const { id } = req.params;
    const headlines = await getOrderedHeadlines(id);
    res.json(headlines);
  });

  // Add Headline
  app.post('/api/headlines', requireAuth, async (req, res) => {
    const { tickerId, text, category, priority, durationMinutes } = req.body;
    if (!await userCanManageTicker(req.user, tickerId)) {
      return res.status(403).json({ error: 'You cannot manage this ticker.' });
    }

    const headlineId = crypto.randomUUID();
    const normalizedPriority = normalizePriority(priority);
    const score = await getNextHeadlineScore(tickerId, normalizedPriority);

    const headlineData = { id: headlineId, text, category: category || '', priority: normalizedPriority };
    await dataClient.zAdd(`headlines:active:${tickerId}`, [{ score, value: JSON.stringify(headlineData) }]);

    if (normalizedPriority === 'breaking') {
      await setTickerEmergencyMode(tickerId, true);
    }

    // 0 means it never expires
    if (durationMinutes && parseInt(durationMinutes) > 0) {
      await dataClient.setEx(`expire:${tickerId}:${headlineId}`, parseInt(durationMinutes) * 60, 'true');
    }

    io.to(`ticker_${tickerId}`).emit('headlines_updated');
    res.json({ success: true });
  });

  // Reorder Headlines
  app.patch('/api/tickers/:tickerId/headlines/order', requireAuth, async (req, res) => {
    const { tickerId } = req.params;
    const { headlineIds } = req.body;

    if (!await userCanManageTicker(req.user, tickerId)) {
      return res.status(403).json({ error: 'You cannot manage this ticker.' });
    }

    if (!Array.isArray(headlineIds)) {
      return res.status(400).json({ error: 'headlineIds must be an array' });
    }

    const key = `headlines:active:${tickerId}`;
    const current = await dataClient.zRangeWithScores(key, 0, -1);
    const currentById = new Map();
    const currentDisplayOrder = await getOrderedHeadlines(tickerId);

    for (const el of current) {
      const parsed = parseHeadlineElement(el);
      currentById.set(parsed.id, { rawValue: el.value, data: parsed });
    }

    const requestedIds = headlineIds.filter(id => currentById.has(id));
    const remainingIds = currentDisplayOrder
      .map(headline => headline.id)
      .filter(id => !requestedIds.includes(id));
    const orderedIds = [...requestedIds, ...remainingIds];

    if (orderedIds.length !== current.length) {
      return res.status(409).json({ error: 'Headline order is out of sync. Refresh and try again.' });
    }

    const firstNormalIndex = orderedIds.findIndex(id => currentById.get(id).data.priority === 'normal');
    const hasBreakingAfterNormal = firstNormalIndex !== -1 &&
      orderedIds.slice(firstNormalIndex + 1).some(id => currentById.get(id).data.priority === 'breaking');

    if (hasBreakingAfterNormal) {
      return res.status(400).json({ error: 'Breaking headlines must stay above normal headlines.' });
    }

    if (current.length > 0) {
      await dataClient.del(key);
      await dataClient.zAdd(key, orderedIds.map((id, index) => {
        const headline = currentById.get(id).data;
        const priorityBase = PRIORITY_SCORE_BASE[headline.priority || 'normal'];
        const samePriorityCount = orderedIds
          .slice(index)
          .filter(candidateId => currentById.get(candidateId).data.priority === headline.priority)
          .length;
        const score = priorityBase + samePriorityCount;
        return {
          score,
          value: JSON.stringify({
            id: headline.id,
            text: headline.text,
            category: headline.category || '',
            priority: headline.priority || 'normal'
          })
        };
      }));
    }

    io.to(`ticker_${tickerId}`).emit('headlines_updated');
    res.json({ success: true });
  });

  // Edit Headline
  app.patch('/api/tickers/:tickerId/headlines/:headlineId', requireAuth, async (req, res) => {
    const { tickerId, headlineId } = req.params;
    const { text, category, priority, durationMinutes } = req.body;

    if (!await userCanManageTicker(req.user, tickerId)) {
      return res.status(403).json({ error: 'You cannot manage this ticker.' });
    }

    if (!String(text || '').trim()) {
      return res.status(400).json({ error: 'Headline text is required.' });
    }

    const key = `headlines:active:${tickerId}`;
    const elements = await dataClient.zRangeWithScores(key, 0, -1);
    const match = elements.find(el => parseHeadlineElement(el).id === headlineId);

    if (!match) {
      return res.status(404).json({ error: 'Headline not found.' });
    }

    const currentHeadline = parseHeadlineElement(match);
    const normalizedPriority = normalizePriority(priority);
    const score = currentHeadline.priority === normalizedPriority
      ? match.score
      : await getNextHeadlineScore(tickerId, normalizedPriority);
    const updatedHeadline = {
      id: currentHeadline.id,
      text: String(text).trim(),
      category: category || '',
      priority: normalizedPriority
    };

    await dataClient.zRem(key, match.value);
    await dataClient.zAdd(key, [{ score, value: JSON.stringify(updatedHeadline) }]);

    if (durationMinutes !== undefined) {
      const parsedDuration = parseInt(durationMinutes, 10) || 0;
      if (parsedDuration > 0) {
        await dataClient.setEx(`expire:${tickerId}:${headlineId}`, parsedDuration * 60, 'true');
      } else {
        await dataClient.del(`expire:${tickerId}:${headlineId}`);
      }
    }

    if (normalizedPriority === 'breaking') {
      await setTickerEmergencyMode(tickerId, true);
    } else if (currentHeadline.priority === 'breaking') {
      const hasBreakingHeadlines = await tickerHasBreakingHeadlines(tickerId);
      if (!hasBreakingHeadlines) {
        await setTickerEmergencyMode(tickerId, false);
      }
    }

    io.to(`ticker_${tickerId}`).emit('headlines_updated');
    res.json({ success: true });
  });

  // Delete Headline
  app.delete('/api/tickers/:tickerId/headlines/:headlineId', requireAuth, async (req, res) => {
    const { tickerId, headlineId } = req.params;
    if (!await userCanManageTicker(req.user, tickerId)) {
      return res.status(403).json({ error: 'You cannot manage this ticker.' });
    }

    const elements = await dataClient.zRangeWithScores(`headlines:active:${tickerId}`, 0, -1);
    let removedHeadline = null;

    for (const el of elements) {
      const parsed = parseHeadlineElement(el);
      if (parsed.id === headlineId) {
        removedHeadline = parsed;
        await dataClient.zRem(`headlines:active:${tickerId}`, el.value);
        break;
      }
    }

    await dataClient.del(`expire:${tickerId}:${headlineId}`);
    if (removedHeadline?.priority === 'breaking') {
      const hasBreakingHeadlines = await tickerHasBreakingHeadlines(tickerId);
      if (!hasBreakingHeadlines) {
        await setTickerEmergencyMode(tickerId, false);
      }
    }

    io.to(`ticker_${tickerId}`).emit('headlines_updated');
    res.json({ success: true });
  });

  // Emergency Mode Toggle
  app.post('/api/tickers/:id/emergency', requireAuth, async (req, res) => {
    const { id } = req.params;
    const { active } = req.body;
    if (!await userCanManageTicker(req.user, id)) {
      return res.status(403).json({ error: 'You cannot manage this ticker.' });
    }

    await setTickerEmergencyMode(id, active);

    res.json({ success: true });
  });

  // Redis Keyspace Notifications for Headline Expirations
  const expiredSubClient = pubClient.duplicate();
  expiredSubClient.connect().then(() => {
    expiredSubClient.subscribe('__keyevent@0__:expired', async (key) => {
      if (key.startsWith('expire:')) {
        const parts = key.split(':');
        const tickerId = parts[1];
        const headlineId = parts[2];

        const elements = await dataClient.zRangeWithScores(`headlines:active:${tickerId}`, 0, -1);
        let removedHeadline = null;
        for (const el of elements) {
          const parsed = parseHeadlineElement(el);
          if (parsed.id === headlineId) {
            removedHeadline = parsed;
            await dataClient.zRem(`headlines:active:${tickerId}`, el.value);
            if (removedHeadline.priority === 'breaking') {
              const hasBreakingHeadlines = await tickerHasBreakingHeadlines(tickerId);
              if (!hasBreakingHeadlines) {
                await setTickerEmergencyMode(tickerId, false);
              }
            }
            io.to(`ticker_${tickerId}`).emit('headlines_updated');
            break;
          }
        }
      }
    });
  });

  // --- WEBSOCKETS FOR TICKER CLIENTS ---
  io.on('connection', (socket) => {
    const getTickerRoom = (tickerId) => `ticker_${String(tickerId || '').trim()}`;

    socket.on('join_ticker', async (tickerId) => {
      const normalizedTickerId = String(tickerId || '').trim();
      if (!normalizedTickerId) return;

      socket.join(getTickerRoom(normalizedTickerId));

      const data = await dataClient.hGetAll(`tickers:${normalizedTickerId}`);
      if (data) {
        socket.emit('config_changed', {
          badge: data.badge !== undefined ? data.badge : 'NEWS',
          badgeType: data.badgeType || 'text',
          speed: parseInt(data.speed || '20', 10),
          mode: data.mode || 'normal',
          colorBg: data.colorBg || '#141414',
          colorText: data.colorText || '#ffffff',
          colorBadgeBg: data.colorBadgeBg || '#d32f2f',
          colorBadgeText: data.colorBadgeText || '#ffffff',
          colorRegion: data.colorRegion || '#ff3333',
          fontFamily: data.fontFamily || 'sans-serif',
          continuousMode: data.continuousMode === 'true',
          fallbackMessage: data.fallbackMode === 'blank' ? '' : (data.fallbackMessage || DEFAULT_FALLBACK_STREAM),
          fallbackMode: data.fallbackMode || 'default'
        });
      }
    });

    socket.on('leave_ticker', (tickerId) => {
      const normalizedTickerId = String(tickerId || '').trim();
      if (!normalizedTickerId) return;
      socket.leave(getTickerRoom(normalizedTickerId));
    });
  });

  const PORT = process.env.PORT || 3000;
  httpServer.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
}).catch(console.error);
