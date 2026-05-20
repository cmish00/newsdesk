import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, useParams, useNavigate } from 'react-router-dom';
import { io } from 'socket.io-client';

const API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:3000' : '';
const socket = io(window.location.hostname === 'localhost' ? 'http://localhost:3000' : '/');
const runtimeConfig = window.WZN_CONFIG || {};
const PANEL_NAME = runtimeConfig.PANEL_NAME || 'NEWS DESK CONTROL PANEL';
const PANEL_DESC = runtimeConfig.PANEL_DESC || 'Real-Time Ticker & Queue Control Management System';
const TAB_TITLE = runtimeConfig.TAB_Title || 'CONTROL PANEL';
const slugify = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');
const slugifyPrefix = (value) => String(value || '')
  .trim()
  .replace(/[^a-zA-Z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

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

function LoginPanel({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');

    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      if (!res.ok) throw new Error('Invalid username or password.');

      const auth = await res.json();
      localStorage.setItem('wzn_auth', JSON.stringify(auth));
      onLogin(auth);
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="news-desk auth-page">
      <section className="desk-card auth-card">
        <h2>Control Panel Login</h2>
        <form onSubmit={handleLogin} className="compact-form">
          <div className="form-group">
            <label>Username</label>
            <input type="text" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required />
          </div>
          <div className="form-group">
            <label>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />
          </div>
          {error && <p className="error-text">{error}</p>}
          <button type="submit" className="btn-primary">Sign In</button>
        </form>
      </section>
    </div>
  );
}

function NewsDesk() {
  const navigate = useNavigate();
  const [auth, setAuth] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('wzn_auth')) || null;
    } catch (e) {
      return null;
    }
  });
  const [activeTickerId, setActiveTickerId] = useState('');
  const [tickers, setTickers] = useState([]);
  const [users, setUsers] = useState([]);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newUserRole, setNewUserRole] = useState('user');
  const [newUserTeam, setNewUserTeam] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [myNewPassword, setMyNewPassword] = useState('');
  const [passwordMessage, setPasswordMessage] = useState('');
  const [showUserManagement, setShowUserManagement] = useState(false);
  const [showMyPassword, setShowMyPassword] = useState(false);

  // Form States for Creating/Editing Ticker
  const [newTickerId, setNewTickerId] = useState('');
  const [tickerScope, setTickerScope] = useState('team');
  const [adminTickerTeam, setAdminTickerTeam] = useState('');
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

  const user = auth?.user;
  const tickerSlug = slugify(newTickerId);
  const canCreateTeamTicker = Boolean(user?.team) && user?.role !== 'admin';
  const resolvedTickerScope = canCreateTeamTicker && tickerScope !== 'private' ? 'team' : 'private';
  const tickerPrefix = resolvedTickerScope === 'team'
    ? slugifyPrefix(user?.team)
    : slugifyPrefix(user?.username);
  const finalTickerId = user?.role === 'admin' || !tickerSlug
    ? tickerSlug
    : tickerSlug.toLowerCase().startsWith(`${tickerPrefix.toLowerCase()}-`)
      ? tickerSlug
      : `${tickerPrefix}-${tickerSlug}`;

  const authFetch = async (url, options = {}) => {
    const res = await fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${auth.token}`
      }
    });

    if (res.status === 401) {
      localStorage.removeItem('wzn_auth');
      setAuth(null);
    }

    return res;
  };

  const loadTickers = async () => {
    if (!auth?.token) return;
    try {
      const res = await authFetch(`${API_BASE}/api/tickers`);
      const data = await res.json();
      setTickers(data);
      if (data.length > 0 && !activeTickerId) {
        setActiveTickerId(data[0].id);
      } else if (activeTickerId && !data.some(t => t.id === activeTickerId)) {
        setActiveTickerId(data[0]?.id || '');
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

  const loadUsers = async () => {
    if (user?.role !== 'admin') return;
    try {
      const res = await authFetch(`${API_BASE}/api/users`);
      const data = await res.json();
      setUsers(data.map(listUser => ({
        ...listUser,
        originalUsername: listUser.username,
        draftPassword: ''
      })));
    } catch (e) { console.error(e); }
  };

  useEffect(() => {
    if (!auth?.token) return;
    loadTickers();
    socket.on('tickers_updated', loadTickers);
    return () => socket.off('tickers_updated');
  }, [auth?.token, activeTickerId]);

  useEffect(() => {
    if (auth?.token && user?.role === 'admin') loadUsers();
  }, [auth?.token, user?.role]);

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
    await authFetch(`${API_BASE}/api/tickers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: finalTickerId,
        tickerScope: resolvedTickerScope,
        adminTeam: user?.role === 'admin' ? adminTickerTeam : undefined,
        badge, badgeType, speed, colorBg, colorText, colorBadgeBg, colorBadgeText, colorRegion, fontFamily
      })
    });
    setNewTickerId('');
  };

  const handleDeleteTicker = async (id) => {
    if (window.confirm(`Delete entirely new ticker "${id}"?`)) {
      await authFetch(`${API_BASE}/api/tickers/${id}`, { method: 'DELETE' });
      if (activeTickerId === id) setActiveTickerId('');
    }
  };

  const handleAddHeadline = async (e) => {
    e.preventDefault();
    if (!headlineText || !activeTickerId) return;
    const category = headlineCategory === '__custom__' ? headlineCustomCategory.trim() : headlineCategory;

    await authFetch(`${API_BASE}/api/headlines`, {
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
    await authFetch(`${API_BASE}/api/tickers/${activeTickerId}/headlines/${headlineId}`, {
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
      const res = await authFetch(`${API_BASE}/api/tickers/${activeTickerId}/headlines/order`, {
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
    await authFetch(`${API_BASE}/api/tickers/${id}/emergency`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active })
    });
  };

  const handleCreateUser = async (e) => {
    e.preventDefault();
    const res = await authFetch(`${API_BASE}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: newUsername, password: newPassword, role: newUserRole, team: newUserTeam })
    });

    if (res.ok) {
      setNewUsername('');
      setNewPassword('');
      setNewUserRole('user');
      setNewUserTeam('');
      loadUsers();
    }
  };

  const handleUpdateUser = async (listUser) => {
    const res = await authFetch(`${API_BASE}/api/users/${listUser.originalUsername}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: listUser.username,
        team: listUser.team || '',
        role: listUser.role,
        password: listUser.draftPassword || undefined
      })
    });
    if (res.ok) {
      loadUsers();
      loadTickers();
    } else {
      const data = await res.json().catch(() => ({ error: 'Unable to update team.' }));
      window.alert(data.error || 'Unable to update team.');
      loadUsers();
    }
  };

  const handleUpdateOwnPassword = async (e) => {
    e.preventDefault();
    setPasswordMessage('');

    const res = await authFetch(`${API_BASE}/api/auth/password`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword: myNewPassword })
    });

    if (res.ok) {
      setCurrentPassword('');
      setMyNewPassword('');
      setPasswordMessage('Password updated.');
    } else {
      const data = await res.json().catch(() => ({ error: 'Unable to update password.' }));
      setPasswordMessage(data.error || 'Unable to update password.');
    }
  };

  const handleUpdateTickerAssignment = async (ticker, team) => {
    const res = await authFetch(`${API_BASE}/api/tickers/${ticker.id}/assignment`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team })
    });

    if (res.ok) {
      const data = await res.json();
      if (activeTickerId === ticker.id) {
        setActiveTickerId(data.newTickerId);
        loadHeadlines(data.newTickerId);
      }
      loadTickers();
    } else {
      const data = await res.json().catch(() => ({ error: 'Unable to update ticker assignment.' }));
      window.alert(data.error || 'Unable to update ticker assignment.');
      loadTickers();
    }
  };

  const handleDeleteUser = async (username) => {
    if (!window.confirm(`Delete user "${username}"?`)) return;
    const res = await authFetch(`${API_BASE}/api/users/${username}`, { method: 'DELETE' });
    if (res.ok) loadUsers();
  };

  const handleLogout = () => {
    localStorage.removeItem('wzn_auth');
    setAuth(null);
    setActiveTickerId('');
    setTickers([]);
    setUsers([]);
  };

  if (!auth?.token) {
    return <LoginPanel onLogin={setAuth} />;
  };

  const tickerGroups = tickers.reduce((groups, ticker) => {
    const groupName = ticker.team || 'No Team / Private';
    if (!groups[groupName]) groups[groupName] = [];
    groups[groupName].push(ticker);
    return groups;
  }, {});
  const sortedTickerGroups = Object.entries(tickerGroups)
    .sort(([a], [b]) => {
      if (a === 'No Team / Private') return 1;
      if (b === 'No Team / Private') return -1;
      return a.localeCompare(b);
    })
    .map(([teamName, teamTickers]) => [
      teamName,
      teamTickers.sort((a, b) => a.id.localeCompare(b.id))
    ]);
  const availableTeams = Array.from(new Set([
    ...users.map(listUser => listUser.team),
    ...tickers.map(ticker => ticker.team)
  ].filter(Boolean))).sort((a, b) => a.localeCompare(b));

  return (
    <div className="news-desk dark-theme">
      <header className="desk-header">
        <h1>🎙️ {PANEL_NAME}</h1>
        <p>{PANEL_DESC}</p>
        <div className="session-actions">
          <span>{user.username} | {user.role}</span>
          <button type="button" className="btn-warn" onClick={handleLogout}>Sign Out</button>
        </div>
      </header>

      <div className="dashboard-grid">
        <section className="desk-card">
          <h2>📁 Ticker Profiles</h2>
          <form onSubmit={handleCreateTicker} className="compact-form">
            <div className="form-group">
              <label>Ticker ID / Slug (Becomes your URL)</label>
              <input type="text" placeholder="e.g. main-broadcast" value={newTickerId} onChange={e => setNewTickerId(e.target.value)} required />
              {finalTickerId && <div className="slug-preview">Final URL: /{finalTickerId}</div>}
            </div>

            {canCreateTeamTicker && (
              <div className="form-group">
                <label>Ticker Visibility</label>
                <select value={tickerScope} onChange={e => setTickerScope(e.target.value)}>
                  <option value="team">Team Shared ({user.team})</option>
                  <option value="private">Private ({user.username})</option>
                </select>
              </div>
            )}

            {user.role === 'admin' && (
              <div className="form-group">
                <label>Ticker Assignment</label>
                <select value={adminTickerTeam} onChange={e => setAdminTickerTeam(e.target.value)}>
                  <option value="">Admin / No Team</option>
                  {availableTeams.map(team => (
                    <option key={team} value={team}>Team Shared ({team})</option>
                  ))}
                </select>
              </div>
            )}

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
            {sortedTickerGroups.map(([teamName, teamTickers]) => (
              <div key={teamName} className="ticker-team-group">
                <div className="ticker-team-heading">{teamName}</div>
                {teamTickers.map(t => (
                  <div key={t.id} className={`ticker-list-item ${activeTickerId === t.id ? 'selected' : ''}`} onClick={() => setActiveTickerId(t.id)}>
                    <div>
                      <strong>/{t.id}</strong> <span className="small-badge" style={{backgroundColor: t.colorBadgeBg, color: t.colorBadgeText}}>{t.badge}</span>
                      <div className="speed-text">
                        Speed: {t.speed} | Font: {t.fontFamily}
                        {user.role === 'admin' && t.owner ? ` | Owner: ${t.owner}` : ''}
                      </div>
                      {(user.role === 'admin' || t.owner === user.username) && (
                        <div className="ticker-assignment-control" onClick={e => e.stopPropagation()}>
                          <label>Assignment</label>
                          <select
                            value={t.team || ''}
                            onChange={e => handleUpdateTickerAssignment(t, e.target.value)}
                          >
                            <option value="">No Team / Private</option>
                            {user.role === 'admin' ? (
                              availableTeams.map(team => (
                                <option key={team} value={team}>{team}</option>
                              ))
                            ) : (
                              user.team ? <option value={user.team}>{user.team}</option> : null
                            )}
                          </select>
                        </div>
                      )}
                    </div>
                    <div className="item-actions" onClick={e => e.stopPropagation()}>
                      <button className={t.mode === 'emergency alert' ? 'btn-danger flashing' : 'btn-warn'} onClick={() => toggleEmergency(t.id, t.mode)}>
                        {t.mode === 'emergency alert' ? 'REMOVE OVERRIDE' : 'EMERGENCY'}
                      </button>
                      <button className="btn-delete" onClick={() => handleDeleteTicker(t.id)}>X</button>
                    </div>
                  </div>
                ))}
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

        {user.role !== 'admin' && (
          <section className="desk-card">
            <h2>
              My Password
              <button type="button" className="btn-toggle" onClick={() => setShowMyPassword(!showMyPassword)}>
                {showMyPassword ? 'Collapse' : 'Expand'}
              </button>
            </h2>
            {showMyPassword && (
              <form onSubmit={handleUpdateOwnPassword} className="compact-form">
                <div className="form-row">
                  <div className="form-group">
                    <label>Current Password</label>
                    <input
                      type="password"
                      value={currentPassword}
                      onChange={e => setCurrentPassword(e.target.value)}
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label>New Password</label>
                    <input
                      type="password"
                      value={myNewPassword}
                      onChange={e => setMyNewPassword(e.target.value)}
                      required
                    />
                  </div>
                </div>
                {passwordMessage && <p className="status-text">{passwordMessage}</p>}
                <button type="submit" className="btn-primary">Update Password</button>
              </form>
            )}
          </section>
        )}

        {user.role === 'admin' && (
          <section className="desk-card admin-management-card">
            <h2>
              User Management
              <button type="button" className="btn-toggle" onClick={() => setShowUserManagement(!showUserManagement)}>
                {showUserManagement ? 'Collapse' : 'Expand'}
              </button>
            </h2>
            {showUserManagement && (
              <>
                <form onSubmit={handleCreateUser} className="compact-form">
                  <div className="form-row">
                    <div className="form-group">
                      <label>Username</label>
                      <input type="text" value={newUsername} onChange={e => setNewUsername(e.target.value)} required />
                    </div>
                    <div className="form-group">
                      <label>Password</label>
                      <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required />
                    </div>
                    <div className="form-group">
                      <label>Role</label>
                      <select value={newUserRole} onChange={e => setNewUserRole(e.target.value)}>
                        <option value="user">User</option>
                        <option value="admin">Admin</option>
                      </select>
                    </div>
                    <div className="form-group">
                      <label>Team</label>
                      <input
                        type="text"
                        placeholder="e.g. newsroom"
                        value={newUserTeam}
                        onChange={e => setNewUserTeam(e.target.value)}
                      />
                    </div>
                  </div>
                  <button type="submit" className="btn-primary">Create User</button>
                </form>

                <div className="user-list">
              {users.map(listUser => (
                <div key={listUser.originalUsername} className="user-list-item">
                  <div className="user-profile-editor">
                    <label>Username</label>
                    <input
                      type="text"
                      value={listUser.username || ''}
                      onChange={e => setUsers(users.map(u => u.originalUsername === listUser.originalUsername ? { ...u, username: e.target.value } : u))}
                    />
                  </div>
                  <div className="user-profile-editor">
                    <label>Role</label>
                    <select
                      value={listUser.role || 'user'}
                      onChange={e => setUsers(users.map(u => u.originalUsername === listUser.originalUsername ? { ...u, role: e.target.value } : u))}
                    >
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>
                  <div className="user-profile-editor">
                    <label>Team</label>
                    <input
                      type="text"
                      value={listUser.team || ''}
                      placeholder="No team"
                      onChange={e => setUsers(users.map(u => u.originalUsername === listUser.originalUsername ? { ...u, team: e.target.value } : u))}
                    />
                  </div>
                  <div className="user-profile-editor">
                    <label>New Password</label>
                    <input
                      type="password"
                      value={listUser.draftPassword || ''}
                      placeholder="Leave blank"
                      onChange={e => setUsers(users.map(u => u.originalUsername === listUser.originalUsername ? { ...u, draftPassword: e.target.value } : u))}
                    />
                  </div>
                  <div className="user-row-actions">
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => handleUpdateUser(listUser)}
                    >
                      Apply
                    </button>
                    <button
                      className="btn-delete"
                      onClick={() => handleDeleteUser(listUser.originalUsername)}
                      disabled={listUser.originalUsername === user.username}
                    >
                      X
                    </button>
                  </div>
                </div>
              ))}
                </div>
              </>
            )}
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
