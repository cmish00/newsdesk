const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const httpServer = createServer(app);

const pubClient = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
const subClient = pubClient.duplicate();
const dataClient = pubClient.duplicate();

Promise.all([pubClient.connect(), subClient.connect(), dataClient.connect()]).then(() => {
  const io = new Server(httpServer, {
    cors: { origin: '*' },
    adapter: createAdapter(pubClient, subClient)
  });

  // --- API ROUTES FOR "NEWS DESK" ---

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

  // Get all tickers
  app.get('/api/tickers', async (req, res) => {
    const keys = await dataClient.keys('tickers:*');
    const tickers = [];
    for (const key of keys) {
      const id = key.split(':')[1];
      const data = await dataClient.hGetAll(key);
      tickers.push({
        id,
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
  app.post('/api/tickers', async (req, res) => {
    const { id, badge, badgeType, speed, colorBg, colorText, colorBadgeBg, colorBadgeText, colorRegion, fontFamily } = req.body;
    const key = `tickers:${id}`;

    // Check if updating or creating to preserve mode
    const currentMode = await dataClient.hGet(key, 'mode') || 'normal';

    await dataClient.hSet(key, {
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
    io.to(`ticker_${id}`).emit('config_changed', {
      badge, badgeType, speed: parseInt(speed), mode: currentMode, colorBg, colorText, colorBadgeBg, colorBadgeText, colorRegion, fontFamily
    });
    res.json({ success: true, id });
  });

  // Delete Ticker
  app.delete('/api/tickers/:id', async (req, res) => {
    const { id } = req.params;
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
  app.post('/api/headlines', async (req, res) => {
    const { tickerId, text, category, priority, durationMinutes } = req.body;
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
  app.patch('/api/tickers/:tickerId/headlines/order', async (req, res) => {
    const { tickerId } = req.params;
    const { headlineIds } = req.body;

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
  app.delete('/api/tickers/:tickerId/headlines/:headlineId', async (req, res) => {
    const { tickerId, headlineId } = req.params;
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
  app.post('/api/tickers/:id/emergency', async (req, res) => {
    const { id } = req.params;
    const { active } = req.body;
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
