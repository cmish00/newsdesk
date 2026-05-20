import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, useParams, useNavigate } from 'react-router-dom';
import { io } from 'socket.io-client';

const API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:3000' : '';
const socket = io(window.location.hostname === 'localhost' ? 'http://localhost:3000' : '/');
const runtimeConfig = window.WZN_CONFIG || {};
const PANEL_NAME = runtimeConfig.PANEL_NAME || 'NEWS DESK CONTROL PANEL';
const PANEL_DESC = runtimeConfig.PANEL_DESC || 'Real-Time Ticker & Queue Control Management System';
const TAB_TITLE = runtimeConfig.TAB_Title || 'CONTROL PANEL';

function App() {
  useEffect(() => {
    document.title = TAB_TITLE;
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<NewsDesk />} />
        <Route path="/:tickerId" element={<TickerRoute />} />
      </Routes>
    </BrowserRouter>
  );
}

function TickerRoute() {
  const { tickerId } = useParams();

  // Apply transparent body background for the ticker route to support OBS overlays
  useEffect(() => {
    document.body.classList.add('transparent-bg');
    return () => document.body.classList.remove('transparent-bg');
  }, []);

  return (
    <div className="fullscreen-ticker-wrapper">
      <TickerDisplay id={tickerId} />
    </div>
  );
}


function ColorField({ label, value, onChange, placeholder }) {
  const safeColor = value?.startsWith('#') ? value : '#ffffff';

  return (
    <div className="form-group color-field-group">
      <label>{label}</label>

      <div className="color-input-wrapper">
        <input
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="color-text-input"
        />

        <input
          type="color"
          value={safeColor}
          onChange={(e) => onChange(e.target.value)}
          className="color-picker-input"
          title="Open color picker"
        />
      </div>
    </div>
  );
}

function NewsDesk() {
  const navigate = useNavigate();
  const [activeTickerId, setActiveTickerId] = useState('');
  const [tickers, setTickers] = useState([]);

  // Form States for Creating/Editing Ticker
  const [newTickerId, setNewTickerId] = useState('');
  const [badge, setBadge] = useState(''); // Empty badge support
  const [badgeType, setBadgeType] = useState('text');
  const [speed, setSpeed] = useState(20);

  // Using text inputs to allow 'transparent', 'rgba(...)', hex, etc.
  const [colorBg, setColorBg] = useState('#141414');
  const [colorText, setColorText] = useState('#ffffff');
  const [colorBadgeBg, setColorBadgeBg] = useState('#d32f2f');
  const [colorBadgeText, setColorBadgeText] = useState('#ffffff');
  const [colorRegion, setColorRegion] = useState('#ff3333');
  const [fontFamily, setFontFamily] = useState('sans-serif');

  // Form States for Headlines
  const [selectedTickerHeadlines, setSelectedTickerHeadlines] = useState([]);
  const [headlineText, setHeadlineText] = useState('');
  const [headlineCategory, setHeadlineCategory] = useState(''); // Blank Region support
  const [headlineCustomCategory, setHeadlineCustomCategory] = useState('');
  const [headlinePriority, setHeadlinePriority] = useState('normal');
  const [duration, setDuration] = useState(0); // 0 means never expires

  const loadTickers = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/tickers`);
      const data = await res.json();
      setTickers(data);
      if (data.length > 0 && !activeTickerId) {
        setActiveTickerId(data[0].id);
      }
    } catch (e) { console.error(e); }
  };

  const loadHeadlines = async (id) => {
    if (!id) return;
    try {
      const res = await fetch(`${API_BASE}/api/tickers/${id}/headlines`);
      const data = await res.json();
      setSelectedTickerHeadlines(data);
    } catch (e) { console.error(e); }
  };

  useEffect(() => {
    loadTickers();
    socket.on('tickers_updated', loadTickers);
    return () => socket.off('tickers_updated');
  }, []);

  useEffect(() => {
    if (activeTickerId) {
      loadHeadlines(activeTickerId);
      socket.emit('join_ticker', activeTickerId);
      socket.on('headlines_updated', () => loadHeadlines(activeTickerId));
    }
    return () => {
      socket.off('headlines_updated');
    };
  }, [activeTickerId]);

  const handleCreateTicker = async (e) => {
    e.preventDefault();
    if (!newTickerId) return;
    await fetch(`${API_BASE}/api/tickers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: newTickerId.toLowerCase().replace(/\\s+/g, '-'),
        badge, badgeType, speed, colorBg, colorText, colorBadgeBg, colorBadgeText, colorRegion, fontFamily
      })
    });
    setNewTickerId('');
  };

  const handleDeleteTicker = async (id) => {
    if (window.confirm(`Delete entirely new ticker "${id}"?`)) {
      await fetch(`${API_BASE}/api/tickers/${id}`, { method: 'DELETE' });
      if (activeTickerId === id) setActiveTickerId('');
    }
  };

  const handleAddHeadline = async (e) => {
    e.preventDefault();
    if (!headlineText || !activeTickerId) return;
    const category = headlineCategory === '__custom__' ? headlineCustomCategory.trim() : headlineCategory;

    await fetch(`${API_BASE}/api/headlines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tickerId: activeTickerId,
        text: headlineText,
        category,
        priority: headlinePriority,
        durationMinutes: duration
      })
    });
    setHeadlineText('');
    if (headlineCategory === '__custom__') setHeadlineCustomCategory('');
  };

  const handleDeleteHeadline = async (headlineId) => {
    await fetch(`${API_BASE}/api/tickers/${activeTickerId}/headlines/${headlineId}`, {
      method: 'DELETE'
    });
  };

  const canMoveHeadline = (index, direction) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= selectedTickerHeadlines.length) return false;
    return selectedTickerHeadlines[index].priority === selectedTickerHeadlines[targetIndex].priority;
  };

  const handleMoveHeadline = async (index, direction) => {
    const targetIndex = index + direction;
    if (!canMoveHeadline(index, direction)) return;

    const reordered = [...selectedTickerHeadlines];
    [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
    setSelectedTickerHeadlines(reordered);

    try {
      const res = await fetch(`${API_BASE}/api/tickers/${activeTickerId}/headlines/order`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headlineIds: reordered.map(headline => headline.id) })
      });
      if (!res.ok) throw new Error('Unable to reorder headlines');
    } catch (e) {
      console.error(e);
      loadHeadlines(activeTickerId);
    }
  };

  const toggleEmergency = async (id, currentMode) => {
    const active = currentMode !== 'emergency alert';
    await fetch(`${API_BASE}/api/tickers/${id}/emergency`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active })
    });
  };

  return (
    <div className="news-desk dark-theme">
      <header className="desk-header">
        <h1>🎙️ {PANEL_NAME}</h1>
        <p>{PANEL_DESC}</p>
      </header>

      <div className="dashboard-grid">
        <section className="desk-card">
          <h2>📁 Ticker Profiles</h2>
          <form onSubmit={handleCreateTicker} className="compact-form">
            <div className="form-group">
              <label>Ticker ID / Slug (Becomes your URL)</label>
              <input type="text" placeholder="e.g. main-broadcast" value={newTickerId} onChange={e => setNewTickerId(e.target.value)} required />
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Badge Content (Can be blank)</label>
                <input type="text" placeholder="Leave empty for no badge text" value={badge} onChange={e => setBadge(e.target.value)} />
              </div>
              <div className="form-group">
                <label>Badge Type</label>
                <select value={badgeType} onChange={e => setBadgeType(e.target.value)}>
                  <option value="text">Plain Text</option>
                  <option value="image">Image URL</option>
                </select>
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Scroll Speed (0 = Static)</label>
                <input type="number" min="0" max="100" value={speed} onChange={e => setSpeed(parseInt(e.target.value) || 0)} />
              </div>
              <div className="form-group">
                <label>Font Styling</label>
                <select value={fontFamily} onChange={e => setFontFamily(e.target.value)}>
                  <option value="sans-serif">Standard Sans</option>
                  <option value="monospace">Retro Digital Monospace</option>
                  <option value="Impact, sans-serif">Bold Impact Title</option>
                </select>
              </div>
            </div>

            <label className="section-label">Colors (Supports: hex, transparent, rgba)</label>
            <div className="form-row">
              <ColorField
                label="Background"
                value={colorBg}
                onChange={setColorBg}
                placeholder="transparent"
              />

              <ColorField
                label="Text"
                value={colorText}
                onChange={setColorText}
                placeholder="#ffffff"
              />

              <ColorField
                label="Badge Bg"
                value={colorBadgeBg}
                onChange={setColorBadgeBg}
                placeholder="transparent"
              />

              <ColorField
                label="Badge Text"
                value={colorBadgeText}
                onChange={setColorBadgeText}
                placeholder="#ffffff"
              />

              <ColorField
                label="Region"
                value={colorRegion}
                onChange={setColorRegion}
                placeholder="#ff3333"
              />
            </div>

            <button type="submit" className="btn-primary">⚡ Setup / Update Ticker Profile</button>
          </form>

          <div className="ticker-list">
            <h3>Active System Tickers</h3>
            {tickers.map(t => (
              <div key={t.id} className={`ticker-list-item ${activeTickerId === t.id ? 'selected' : ''}`} onClick={() => setActiveTickerId(t.id)}>
                <div>
                  <strong>/{t.id}</strong> <span className="small-badge" style={{backgroundColor: t.colorBadgeBg, color: t.colorBadgeText}}>{t.badge}</span>
                  <div className="speed-text">Speed: {t.speed} | Font: {t.fontFamily}</div>
                </div>
                <div className="item-actions" onClick={e => e.stopPropagation()}>
                  <button className={t.mode === 'emergency alert' ? 'btn-danger flashing' : 'btn-warn'} onClick={() => toggleEmergency(t.id, t.mode)}>
                    {t.mode === 'emergency alert' ? 'REMOVE OVERRIDE' : '🚨 EMERGENCY'}
                  </button>
                  <button className="btn-delete" onClick={() => handleDeleteTicker(t.id)}>❌</button>
                </div>
              </div>
            ))}
          </div>
        </section>

        {activeTickerId && (
          <section className="desk-card">
            <h2>📢 Manage Feed: <span className="highlight">/{activeTickerId}</span></h2>
            <div className="action-row" style={{marginBottom: '1rem'}}>
              <button className="btn-success" onClick={() => window.open(`/${activeTickerId}`, '_blank')}>📺 Open Ticker in New Window (Unique URL)</button>
            </div>

            <form onSubmit={handleAddHeadline} className="compact-form headline-form">
              <h3>Publish New Headline</h3>
              <div className="form-group">
                <label>Headline Copy</label>
                <textarea rows="2" placeholder="ENTER NEWS TEXT HERE..." value={headlineText} onChange={e => setHeadlineText(e.target.value)} required />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Region Jurisdiction</label>
                  <select value={headlineCategory} onChange={e => setHeadlineCategory(e.target.value)}>
                    <option value="">None (Blank)</option>
                    <option value="BREAKING">BREAKING</option>
                    <option value="Los Santos">Los Santos</option>
                    <option value="Blaine County">Blaine County</option>
                    <option value="Roxwood County">Roxwood County</option>
                    <option value="__custom__">Custom Text</option>
                  </select>
                </div>
                {headlineCategory === '__custom__' && (
                  <div className="form-group">
                    <label>Custom Region Text</label>
                    <input
                      type="text"
                      placeholder="e.g. San Andreas"
                      value={headlineCustomCategory}
                      onChange={e => setHeadlineCustomCategory(e.target.value)}
                    />
                  </div>
                )}
                <div className="form-group">
                  <label>Queue Hierarchy</label>
                  <select value={headlinePriority} onChange={e => setHeadlinePriority(e.target.value)}>
                    <option value="normal">Rotating Standard Queue</option>
                    <option value="breaking">🔥 Priority Breaking Queue</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Auto-Expire (0 = Never Expires)</label>
                  <input type="number" min="0" max="1440" value={duration} onChange={e => setDuration(parseInt(e.target.value) || 0)} />
                </div>
              </div>
              <button type="submit" className="btn-success">📨 Inject Into Redis Feed</button>
            </form>

            <div className="headline-queue">
              <h3>Live Operational Queue</h3>
              {selectedTickerHeadlines.length === 0 ? <p className="empty-text">Queue empty. Displaying fallback message stream.</p> : null}
              {selectedTickerHeadlines.map((hl, index) => (
                <div key={hl.id} className={`queue-item ${hl.priority === 'breaking' ? 'breaking-border' : ''}`}>
                  <div className="queue-order-controls">
                    <button
                      type="button"
                      className="btn-reorder"
                      onClick={() => handleMoveHeadline(index, -1)}
                      disabled={!canMoveHeadline(index, -1)}
                      title="Move headline up"
                      aria-label="Move headline up"
                    >
                      ^
                    </button>
                    <button
                      type="button"
                      className="btn-reorder"
                      onClick={() => handleMoveHeadline(index, 1)}
                      disabled={!canMoveHeadline(index, 1)}
                      title="Move headline down"
                      aria-label="Move headline down"
                    >
                      v
                    </button>
                  </div>
                  <span className={`priority-indicator ${hl.priority}`}>{hl.priority.toUpperCase()}</span>
                  <div className="queue-body">
                    {hl.category && <strong>[{hl.category.toUpperCase()}] </strong>}
                    {hl.text.toUpperCase()}
                  </div>
                  <button className="btn-delete" onClick={() => handleDeleteHeadline(hl.id)}>❌</button>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

const TickerDisplay = ({ id }) => {
  const [config, setConfig] = useState(null);
  const [headlines, setHeadlines] = useState([]);

  const fetchDisplayHeadlines = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/tickers/${id}/headlines`);
      const data = await res.json();
      setHeadlines(data);
    } catch (e) { console.error(e); }
  };

  useEffect(() => {
    if (!id) return;
    socket.emit('join_ticker', id);
    fetchDisplayHeadlines();

    socket.on('config_changed', (newConfig) => setConfig(newConfig));
    socket.on('mode_changed', (data) => setConfig(prev => prev ? { ...prev, mode: data.mode } : null));
    socket.on('headlines_updated', fetchDisplayHeadlines);
    socket.on('ticker_deleted', () => window.location.reload());

    return () => {
      socket.off('config_changed');
      socket.off('mode_changed');
      socket.off('headlines_updated');
      socket.off('ticker_deleted');
    };
  }, [id]);

  if (!config) return <div className="loading">CONNECTING TO REDIS DATA LOGSTREAM...</div>;

  const animationDuration = config.speed > 0 ? `${120 / config.speed}s` : '0s';
  const isEmergency = config.mode === 'emergency alert';
  const displayedHeadlines = headlines.filter(hl => hl.priority === (isEmergency ? 'breaking' : 'normal'));

  const containerStyle = {
    backgroundColor: isEmergency ? '#b71c1c' : config.colorBg,
    color: isEmergency ? '#ffffff' : config.colorText,
    fontFamily: config.fontFamily
  };

  const badgeStyle = {
    backgroundColor: isEmergency ? '#ff0000' : config.colorBadgeBg,
    color: isEmergency ? '#ffffff' : config.colorBadgeText,
    display: config.badge || config.badgeType === 'image' ? 'flex' : 'none'
  };

  return (
    <div className={`ticker-container ${isEmergency ? 'emergency-mode' : ''}`} style={containerStyle}>
      <div className="badge-wrapper" style={badgeStyle}>
        {config.badgeType === 'image' ? (
          <img src={config.badge} alt="Logo" className="badge-img" onError={(e)=>{e.target.style.display='none';}} />
        ) : (
          config.badge
        )}
      </div>
      <div className={`ticker-content ${config.speed === 0 ? 'speed-0' : ''}`} style={{ animationDuration }}>
        {displayedHeadlines.length === 0 ? (
          <span className="headline-item">[SYSTEM] ALL STATIONS CLEAR // ROTATING TIMELINE STANDBY</span>
        ) : (
          displayedHeadlines.map(hl => (
            <span key={hl.id} className="headline-item">
              {hl.category ? (
                <span className="cat-bracket" style={{ color: isEmergency ? '#ffea00' : config.colorRegion }}>
                  [{hl.category}]
                </span>
              ) : null}
              {hl.category ? " " : ""}
              {hl.text}
            </span>
          ))
        )}
      </div>
    </div>
  );
};

export default App;
