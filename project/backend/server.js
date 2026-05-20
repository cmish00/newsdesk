const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(cors());

const httpServer = createServer(app);

const pubClient = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
const subClient = pubClient.duplicate();
const dataClient = pubClient.duplicate();

Promise.all([pubClient.connect(), subClient.connect(), dataClient.connect()]).then(async () => {
  const io = new Server(httpServer, {
    cors: { origin: '*' },
    adapter: createAdapter(pubClient, subClient)
  });

  // --- API ROUTES FOR "NEWS DESK" ---

  const TOKEN_SECRET = process.env.AUTH_SECRET || 'change-this-secret-in-compose';
  const DEFAULT_ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
  const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

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
    return slugifyPrefix(user.team) || slugifyPrefix(user.username);
  };

  const getTickerTeamForUser = (user, tickerScope = 'team') => {
    if (user.role === 'admin' || tickerScope === 'private') return '';
    return String(user.team || '').trim();
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
      slugifyPrefix(user.team),
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

  const createUser = async ({ username, password, role = 'user', team = '' }) => {
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername || !password) {
      throw new Error('Username and password are required.');
    }

    const { salt, hash } = hashPassword(password);
    await dataClient.hSet(`users:${normalizedUsername}`, {
      username: normalizedUsername,
      passwordHash: hash,
      salt,
      role: role === 'admin' ? 'admin' : 'user',
      team: String(team || '').trim(),
      createdAt: new Date().toISOString()
    });
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

    req.user = {
      username: user.username,
      role: user.role || 'user',
      team: String(user.team || '').trim(),
      teamKey: normalizeTeam(user.team)
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

    const tickerTeam = normalizeTeam(ticker.team);
    return Boolean(user.teamKey && tickerTeam && user.teamKey === tickerTeam);
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
    return elements
      .map(el => ({ headline: parseHeadlineElement(el), score: el.score }))
      .sort((a, b) => {
        const priorityDiff = PRIORITY_SCORE_BASE[b.headline.priority] - PRIORITY_SCORE_BASE[a.headline.priority];
        if (priorityDiff !== 0) return priorityDiff;
        return b.score - a.score;
      })
      .map(item => item.headline);
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

    const keys = await dataClient.keys('tickers:*');
    const migrations = [];

    for (const key of keys) {
      const oldTickerId = key.slice('tickers:'.length);
      const ticker = await dataClient.hGetAll(key);
      if (ticker.owner !== username) continue;
      if (!normalizeTeam(ticker.team)) continue;

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

      if (await dataClient.exists(`headlines:active:${oldTickerId}`)) {
        await dataClient.rename(`headlines:active:${oldTickerId}`, `headlines:active:${newTickerId}`);
      }

      const expireKeys = await dataClient.keys(`expire:${oldTickerId}:*`);
      for (const expireKey of expireKeys) {
        const headlineId = expireKey.split(':').slice(2).join(':');
        await dataClient.rename(expireKey, `expire:${newTickerId}:${headlineId}`);
      }

      io.to(`ticker_${oldTickerId}`).emit('ticker_deleted');
    }

    return migrations;
  };

  const migrateOwnedTickersForUsernameChange = async (oldUsername, newUsername, team, role) => {
    const keys = await dataClient.keys('tickers:*');
    const migrations = [];
    const ownerUpdates = [];

    for (const key of keys) {
      const oldTickerId = key.slice('tickers:'.length);
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

      if (await dataClient.exists(`headlines:active:${oldTickerId}`)) {
        await dataClient.rename(`headlines:active:${oldTickerId}`, `headlines:active:${newTickerId}`);
      }

      const expireKeys = await dataClient.keys(`expire:${oldTickerId}:*`);
      for (const expireKey of expireKeys) {
        const headlineId = expireKey.split(':').slice(2).join(':');
        await dataClient.rename(expireKey, `expire:${newTickerId}:${headlineId}`);
      }

      io.to(`ticker_${oldTickerId}`).emit('ticker_deleted');
    }

    return migrations;
  };

  // Authentication
  app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await getUser(username);

    if (!user || !verifyPassword(password || '', user.salt, user.passwordHash)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const token = signToken({
      username: user.username,
      role: user.role || 'user',
      team: String(user.team || '').trim(),
      exp: Date.now() + 1000 * 60 * 60 * 24 * 7
    });

    res.json({
      token,
      user: { username: user.username, role: user.role || 'user', team: String(user.team || '').trim() }
    });
  });

  app.get('/api/auth/me', requireAuth, async (req, res) => {
    res.json({ user: req.user });
  });

  app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
    const keys = await dataClient.keys('users:*');
    const users = [];

    for (const key of keys) {
      const user = await dataClient.hGetAll(key);
      if (user.username) {
        users.push({
          username: user.username,
          role: user.role || 'user',
          team: String(user.team || '').trim(),
          createdAt: user.createdAt || ''
        });
      }
    }

    users.sort((a, b) => a.username.localeCompare(b.username));
    res.json(users);
  });

  app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
    const { username, password, role, team } = req.body;
    const normalizedUsername = normalizeUsername(username);

    if (!normalizedUsername || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    if (await getUser(normalizedUsername)) {
      return res.status(409).json({ error: 'User already exists.' });
    }

    await createUser({ username: normalizedUsername, password, role, team });
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
    const oldTeam = String(existingUser.team || '').trim();
    const newTeam = req.body.team !== undefined ? String(req.body.team || '').trim() : oldTeam;
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
    if (req.body.team !== undefined) {
      updates.team = newTeam;
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

    if (req.body.team !== undefined && oldTeam !== newTeam) {
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

    await dataClient.del(`users:${username}`);
    res.json({ success: true });
  });

  // Get all tickers
  app.get('/api/tickers', requireAuth, async (req, res) => {
    const keys = await dataClient.keys('tickers:*');
    const tickers = [];
    for (const key of keys) {
      const id = key.split(':')[1];
      const data = await dataClient.hGetAll(key);
      const tickerTeam = normalizeTeam(data.team);
      const canViewTicker = data.owner === req.user.username ||
        Boolean(req.user.teamKey && tickerTeam && req.user.teamKey === tickerTeam);
      if (req.user.role !== 'admin' && !canViewTicker) continue;

      tickers.push({
        id,
        owner: data.owner || '',
        team: String(data.team || '').trim(),
        badge: data.badge !== undefined ? data.badge : 'NEWS',
        badgeType: data.badgeType || 'text',
        speed: parseInt(data.speed || '20', 10),
        mode: data.mode || 'normal',
        colorBg: data.colorBg || '#141414',
        colorText: data.colorText || '#ffffff',
        colorBadgeBg: data.colorBadgeBg || '#d32f2f',
        colorBadgeText: data.colorBadgeText || '#ffffff',
        colorRegion: data.colorRegion || '#ff3333',
        fontFamily: data.fontFamily || 'sans-serif'
      });
    }
    res.json(tickers);
  });

  // Create or Update a ticker
  app.post('/api/tickers', requireAuth, async (req, res) => {
    const { id, badge, badgeType, speed, colorBg, colorText, colorBadgeBg, colorBadgeText, colorRegion, fontFamily, tickerScope } = req.body;
    const resolvedTickerScope = tickerScope === 'private' ? 'private' : 'team';
    const tickerId = getTickerIdForUser(id, req.user, resolvedTickerScope);

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

    await dataClient.hSet(key, {
      owner: existingOwner || req.user.username,
      team: existingTeam !== null ? existingTeam : getTickerTeamForUser(req.user, resolvedTickerScope),
      badge: badge !== undefined ? badge : '',
      badgeType: badgeType || 'text',
      speed: speed !== undefined ? String(speed) : '20',
      mode: currentMode,
      colorBg: colorBg || '#141414',
      colorText: colorText || '#ffffff',
      colorBadgeBg: colorBadgeBg || '#d32f2f',
      colorBadgeText: colorBadgeText || '#ffffff',
      colorRegion: colorRegion || '#ff3333',
      fontFamily: fontFamily || 'sans-serif'
    });

    io.emit('tickers_updated');
    io.to(`ticker_${tickerId}`).emit('config_changed', {
      badge, badgeType, speed: parseInt(speed), mode: currentMode, colorBg, colorText, colorBadgeBg, colorBadgeText, colorRegion, fontFamily
    });
    res.json({ success: true, id: tickerId });
  });

  // Delete Ticker
  app.delete('/api/tickers/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    if (!await userCanManageTicker(req.user, id)) {
      return res.status(403).json({ error: 'You cannot delete this ticker.' });
    }

    await dataClient.del(`tickers:${id}`);
    await dataClient.del(`headlines:active:${id}`);
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

    const headlineId = `hl_${Date.now()}`;
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
    socket.on('join_ticker', async (tickerId) => {
      socket.join(`ticker_${tickerId}`);

      const data = await dataClient.hGetAll(`tickers:${tickerId}`);
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
          fontFamily: data.fontFamily || 'sans-serif'
        });
      }
    });
  });

  const PORT = process.env.PORT || 3000;
  httpServer.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
}).catch(console.error);
