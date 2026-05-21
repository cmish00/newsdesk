import React, { useState, useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route, useParams, useNavigate } from 'react-router-dom';
import { io } from 'socket.io-client';

const API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:3000' : '';
const socket = io(window.location.hostname === 'localhost' ? 'http://localhost:3000' : '/');
const runtimeConfig = window.WZN_CONFIG || {};
const PANEL_NAME = runtimeConfig.PANEL_NAME || 'NEWS DESK CONTROL PANEL';
const PANEL_DESC = runtimeConfig.PANEL_DESC || 'Real-Time Ticker & Queue Control Management System';
const TAB_TITLE = runtimeConfig.TAB_Title || 'CONTROL PANEL';
const FALLBACK_STREAM = runtimeConfig.FALLBACK_STREAM || '[SYSTEM] ALL STATIONS CLEAR // ROTATING TIMELINE STANDBY';
const HEADLINE_CATEGORY_OPTIONS = ['', 'BREAKING', 'Los Santos', 'Blaine County', 'Roxwood County'];
const UNASSIGNED_TEAM_LABEL = 'Unassigned';
const NO_TEAM_LABEL = 'No Team / Private';
const SELECT_SEPARATOR_VALUE = '__separator__';
const SELECT_SEPARATOR_LABEL = '────────────────────────────────────────────────────────';
const isUnassignedTeam = (team) => String(team || '').trim().toLowerCase() === UNASSIGNED_TEAM_LABEL.toLowerCase();
const FONT_GROUPS = [
  {
    label: 'Standard',
    options: [
      { label: 'Standard Sans', value: 'sans-serif' },
      { label: 'Retro Digital Monospace', value: 'monospace' },
      { label: 'Bold Impact Title', value: 'Impact, sans-serif' }
    ]
  },
  {
    label: 'Additional Fonts',
    options: [
      { label: 'Inter', value: "'Inter', sans-serif" },
      { label: 'Roboto', value: "'Roboto', sans-serif" },
      { label: 'Source Sans 3', value: "'Source Sans 3', sans-serif" },
      { label: 'Lato', value: "'Lato', sans-serif" },
      { label: 'Montserrat', value: "'Montserrat', sans-serif" },
      { label: 'Oswald', value: "'Oswald', sans-serif" },
      { label: 'Barlow Condensed', value: "'Barlow Condensed', sans-serif" },
      { label: 'Rajdhani', value: "'Rajdhani', sans-serif" },
      { label: 'Exo 2', value: "'Exo 2', sans-serif" },
      { label: 'Orbitron', value: "'Orbitron', sans-serif" },
      { label: 'Audiowide', value: "'Audiowide', sans-serif" },
      { label: 'Bebas Neue', value: "'Bebas Neue', sans-serif" },
      { label: 'Merriweather Sans', value: "'Merriweather Sans', sans-serif" },
      { label: 'Playfair Display', value: "'Playfair Display', serif" }
    ]
  }
];
const getFontLabel = (fontValue) => (
  FONT_GROUPS.flatMap(group => group.options).find(option => option.value === fontValue)?.label || fontValue
);
const slugify = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');
const slugifyPrefix = (value) => String(value || '')
  .trim()
  .replace(/[^a-zA-Z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');
const stripSlugPrefix = (value, prefix) => {
  const slug = String(value || '');
  const cleanPrefix = slugifyPrefix(prefix);
  if (!cleanPrefix) return slug;
  return slug.toLowerCase().startsWith(`${cleanPrefix.toLowerCase()}-`)
    ? slug.slice(cleanPrefix.length + 1)
    : slug;
};
const getTeams = (entity) => {
  if (Array.isArray(entity?.teams)) return entity.teams.filter(Boolean);
  return entity?.team ? [entity.team] : [];
};
const hexToRgb = (hex) => {
  const cleanHex = String(hex || '').replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(cleanHex)) return null;
  return {
    r: parseInt(cleanHex.slice(0, 2), 16),
    g: parseInt(cleanHex.slice(2, 4), 16),
    b: parseInt(cleanHex.slice(4, 6), 16)
  };
};
const rgbToHex = ({ r, g, b }) => `#${[r, g, b].map(channel => {
  const hex = Math.max(0, Math.min(255, channel)).toString(16);
  return hex.length === 1 ? `0${hex}` : hex;
}).join('')}`;
const parseColorValue = (value) => {
  const color = String(value || '').trim();
  if (color.toLowerCase() === 'transparent') return { r: 255, g: 255, b: 255, a: 0 };

  const hexRgb = color.startsWith('#') ? hexToRgb(color) : null;
  if (hexRgb) return { ...hexRgb, a: 1 };

  const rgbaMatch = color.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/i);
  if (rgbaMatch) {
    return {
      r: Math.max(0, Math.min(255, parseInt(rgbaMatch[1], 10))),
      g: Math.max(0, Math.min(255, parseInt(rgbaMatch[2], 10))),
      b: Math.max(0, Math.min(255, parseInt(rgbaMatch[3], 10))),
      a: rgbaMatch[4] === undefined ? 1 : Math.max(0, Math.min(1, parseFloat(rgbaMatch[4])))
    };
  }

  return { r: 255, g: 255, b: 255, a: 1 };
};
const formatColorWithOpacity = ({ r, g, b }, alpha) => {
  const opacity = Math.max(0, Math.min(1, alpha));
  return opacity === 1 ? rgbToHex({ r, g, b }) : `rgba(${r}, ${g}, ${b}, ${Number(opacity.toFixed(2))})`;
};

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
  const parsedColor = parseColorValue(value);
  const safeColor = rgbToHex(parsedColor);

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
          onChange={(e) => {
            const nextColor = hexToRgb(e.target.value);
            onChange(formatColorWithOpacity(nextColor, parsedColor.a));
          }}
          className="color-picker-input"
          title="Open color picker"
        />
      </div>
      <div className="opacity-control">
        <span>Opacity</span>
        <input
          type="range"
          min="0"
          max="100"
          value={Math.round(parsedColor.a * 100)}
          onChange={(e) => onChange(formatColorWithOpacity(parsedColor, parseInt(e.target.value, 10) / 100))}
        />
        <span>{Math.round(parsedColor.a * 100)}%</span>
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
        <h2>🔏 Control Panel Login</h2>
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
  const [newUserTeamMode, setNewUserTeamMode] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [myNewPassword, setMyNewPassword] = useState('');
  const [passwordMessage, setPasswordMessage] = useState('');
  const [showUserManagement, setShowUserManagement] = useState(false);
  const [showMyPassword, setShowMyPassword] = useState(false);
  const [showActiveTickers, setShowActiveTickers] = useState(true);
  const [showTickerProfiles, setShowTickerProfiles] = useState(false);
  const [collapsedTickerTeams, setCollapsedTickerTeams] = useState({});

  // Form States for Creating/Editing Ticker
  const [newTickerId, setNewTickerId] = useState('');
  const [tickerScope, setTickerScope] = useState('team');
  const [tickerTeam, setTickerTeam] = useState('');
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
  const [fallbackMessage, setFallbackMessage] = useState('');
  const [fallbackBlank, setFallbackBlank] = useState(false);

  // Form States for Headlines
  const [selectedTickerHeadlines, setSelectedTickerHeadlines] = useState([]);
  const [headlineText, setHeadlineText] = useState('');
  const [headlineCategory, setHeadlineCategory] = useState(''); // Blank Region support
  const [headlineCustomCategory, setHeadlineCustomCategory] = useState('');
  const [headlinePriority, setHeadlinePriority] = useState('normal');
  const [duration, setDuration] = useState(0); // 0 means never expires
  const [editingHeadlineId, setEditingHeadlineId] = useState('');
  const [editHeadlineText, setEditHeadlineText] = useState('');
  const [editHeadlineCategory, setEditHeadlineCategory] = useState('');
  const [editHeadlineCustomCategory, setEditHeadlineCustomCategory] = useState('');
  const [editHeadlinePriority, setEditHeadlinePriority] = useState('normal');
  const [editHeadlineDuration, setEditHeadlineDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(Date.now());

  const user = auth?.user;
  const userTeams = getTeams(user);
  const primaryUserTeam = userTeams[0] || '';
  const selectedTickerTeam = userTeams.includes(tickerTeam) ? tickerTeam : primaryUserTeam;
  const tickerSlug = slugify(newTickerId);
  const canCreateTeamTicker = userTeams.length > 0 && user?.role !== 'admin';
  const resolvedTickerScope = canCreateTeamTicker && tickerScope !== 'private' ? 'team' : 'private';
  const tickerPrefix = resolvedTickerScope === 'team'
    ? slugifyPrefix(selectedTickerTeam)
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
      if (activeTickerId && !data.some(t => t.id === activeTickerId)) {
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
        teams: getTeams(listUser),
        draftPassword: ''
      })));
    } catch (e) { console.error(e); }
  };

  useEffect(() => {
    if (!auth?.token) return;
    loadTickers();
    socket.on('tickers_updated', loadTickers);
    return () => socket.off('tickers_updated', loadTickers);
  }, [auth?.token, activeTickerId]);

  useEffect(() => {
    if (auth?.token && user?.role === 'admin') loadUsers();
  }, [auth?.token, user?.role]);

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    cancelEditingHeadline();
    if (!activeTickerId) return undefined;

    const handleHeadlinesUpdated = () => loadHeadlines(activeTickerId);
    loadHeadlines(activeTickerId);
    socket.emit('join_ticker', activeTickerId);
    socket.on('headlines_updated', handleHeadlinesUpdated);

    return () => {
      socket.emit('leave_ticker', activeTickerId);
      socket.off('headlines_updated', handleHeadlinesUpdated);
    };
  }, [activeTickerId]);

  const handleCreateTicker = async (e) => {
    e.preventDefault();
    if (!newTickerId) return;
    const res = await authFetch(`${API_BASE}/api/tickers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: finalTickerId,
        tickerScope: resolvedTickerScope,
        team: user?.role !== 'admin' && resolvedTickerScope === 'team' ? selectedTickerTeam : undefined,
        adminTeam: user?.role === 'admin' ? adminTickerTeam : undefined,
        badge, badgeType, speed, colorBg, colorText, colorBadgeBg, colorBadgeText, colorRegion, fontFamily, fallbackMessage: fallbackBlank ? '' : fallbackMessage, fallbackMode: fallbackBlank ? 'blank' : undefined
      })
    });
    if (res.ok) {
      const data = await res.json();
      const existingTicker = tickers.find(ticker => ticker.id === activeTickerId || ticker.id === data.id || ticker.id === finalTickerId);
      populateTickerProfileForm({
        ...(existingTicker || {}),
        id: data.id,
        owner: existingTicker?.owner || user.username,
        team: user?.role === 'admin'
          ? adminTickerTeam
          : resolvedTickerScope === 'team'
            ? selectedTickerTeam
            : '',
        badge,
        badgeType,
        speed,
        colorBg,
        colorText,
        colorBadgeBg,
        colorBadgeText,
        colorRegion,
        fontFamily,
        fallbackMessage: fallbackBlank ? '' : fallbackMessage,
        fallbackMode: fallbackBlank ? 'blank' : (fallbackMessage ? 'custom' : 'default')
      });
      loadTickers();
    }
  };

  const populateTickerProfileForm = (ticker) => {
    if (activeTickerId === ticker.id) {
      resetTickerProfileForm();
      return;
    }

    const tickerTeam = ticker.team || '';
    const isTeamTicker = Boolean(tickerTeam);
    const slugPrefix = isTeamTicker ? tickerTeam : ticker.owner;
    const editableSlug = user?.role === 'admin'
      ? ticker.id
      : stripSlugPrefix(ticker.id, slugPrefix);

    setActiveTickerId(ticker.id);
    setNewTickerId(editableSlug);
    setTickerScope(isTeamTicker ? 'team' : 'private');
    setTickerTeam(tickerTeam);
    setAdminTickerTeam(tickerTeam);
    setBadge(ticker.badge || '');
    setBadgeType(ticker.badgeType || 'text');
    setSpeed(parseInt(ticker.speed || '20', 10));
    setColorBg(ticker.colorBg || '#141414');
    setColorText(ticker.colorText || '#ffffff');
    setColorBadgeBg(ticker.colorBadgeBg || '#d32f2f');
    setColorBadgeText(ticker.colorBadgeText || '#ffffff');
    setColorRegion(ticker.colorRegion || '#ff3333');
    setFontFamily(ticker.fontFamily || 'sans-serif');
    setFallbackBlank(ticker.fallbackMode === 'blank');
    setFallbackMessage(ticker.fallbackMode === 'blank' ? '' : (ticker.fallbackMessage && ticker.fallbackMessage !== FALLBACK_STREAM ? ticker.fallbackMessage : ''));
  };

  const resetTickerProfileForm = () => {
    setActiveTickerId('');
    setNewTickerId('');
    setTickerScope(canCreateTeamTicker ? 'team' : 'private');
    setTickerTeam(primaryUserTeam);
    setAdminTickerTeam('');
    setBadge('');
    setBadgeType('text');
    setSpeed(20);
    setColorBg('#141414');
    setColorText('#ffffff');
    setColorBadgeBg('#d32f2f');
    setColorBadgeText('#ffffff');
    setColorRegion('#ff3333');
    setFontFamily('sans-serif');
    setFallbackMessage('');
    setFallbackBlank(false);
    setSelectedTickerHeadlines([]);
    cancelEditingHeadline();
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

  const formatExpireLabel = (headline) => {
    if (!headline.expiresAt) return 'Static';
    const remainingSeconds = Math.max(0, Math.ceil((headline.expiresAt - currentTime) / 1000));
    if (remainingSeconds <= 0) return 'Expiring';
    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  };

  const startEditingHeadline = (headline) => {
    const category = headline.category || '';
    setEditingHeadlineId(headline.id);
    setEditHeadlineText(headline.text || '');
    setEditHeadlinePriority(headline.priority || 'normal');
    setEditHeadlineDuration(headline.expiresAt ? Math.max(1, Math.ceil((headline.expiresAt - Date.now()) / 60000)) : 0);
    if (HEADLINE_CATEGORY_OPTIONS.includes(category)) {
      setEditHeadlineCategory(category);
      setEditHeadlineCustomCategory('');
    } else {
      setEditHeadlineCategory('__custom__');
      setEditHeadlineCustomCategory(category);
    }
  };

  const cancelEditingHeadline = () => {
    setEditingHeadlineId('');
    setEditHeadlineText('');
    setEditHeadlineCategory('');
    setEditHeadlineCustomCategory('');
    setEditHeadlinePriority('normal');
    setEditHeadlineDuration(0);
  };

  const handleHeadlinePriorityChange = (priority) => {
    setHeadlinePriority(priority);
    if (priority === 'breaking') {
      setHeadlineCategory('BREAKING');
      setHeadlineCustomCategory('');
    }
  };

  const handleEditHeadlinePriorityChange = (priority) => {
    setEditHeadlinePriority(priority);
    if (priority === 'breaking') {
      setEditHeadlineCategory('BREAKING');
      setEditHeadlineCustomCategory('');
    }
  };

  const handleUpdateHeadline = async (headlineId) => {
    const category = editHeadlineCategory === '__custom__'
      ? editHeadlineCustomCategory.trim()
      : editHeadlineCategory;

    const res = await authFetch(`${API_BASE}/api/tickers/${activeTickerId}/headlines/${headlineId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: editHeadlineText,
        category,
        priority: editHeadlinePriority,
        durationMinutes: editHeadlineDuration
      })
    });

    if (res.ok) {
      cancelEditingHeadline();
      loadHeadlines(activeTickerId);
    } else {
      const data = await res.json().catch(() => ({ error: 'Unable to update headline.' }));
      window.alert(data.error || 'Unable to update headline.');
    }
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
    const assignableNewUserTeam = isUnassignedTeam(newUserTeam) ? '' : newUserTeam;
    const res = await authFetch(`${API_BASE}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: newUsername, password: newPassword, role: newUserRole, teams: assignableNewUserTeam ? [assignableNewUserTeam] : [] })
    });

    if (res.ok) {
      setNewUsername('');
      setNewPassword('');
      setNewUserRole('user');
      setNewUserTeam('');
      setNewUserTeamMode('');
      loadUsers();
    }
  };

  const handleUpdateUser = async (listUser) => {
    const res = await authFetch(`${API_BASE}/api/users/${listUser.originalUsername}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: listUser.username,
        teams: getTeams(listUser),
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

  const addTeamToUserDraft = (originalUsername, team) => {
    const nextTeam = String(team || '').trim();
    if (!nextTeam || isUnassignedTeam(nextTeam)) return;
    setUsers(users.map(listUser => {
      if (listUser.originalUsername !== originalUsername) return listUser;
      const existingTeams = getTeams(listUser);
      if (existingTeams.some(existingTeam => existingTeam.toLowerCase() === nextTeam.toLowerCase())) {
        return { ...listUser, draftTeam: '', draftTeamMode: '' };
      }
      return { ...listUser, teams: [...existingTeams, nextTeam], draftTeam: '', draftTeamMode: '' };
    }));
  };

  const removeTeamFromUserDraft = (originalUsername, team) => {
    setUsers(users.map(listUser => (
      listUser.originalUsername === originalUsername
        ? { ...listUser, teams: getTeams(listUser).filter(existingTeam => existingTeam !== team) }
        : listUser
    )));
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

  const handleUpdateTickerOwner = async (ticker, owner) => {
    const res = await authFetch(`${API_BASE}/api/tickers/${ticker.id}/owner`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner })
    });

    if (res.ok) {
      const data = await res.json();
      if (activeTickerId === ticker.id) {
        setActiveTickerId(data.newTickerId);
        loadHeadlines(data.newTickerId);
      }
      loadTickers();
    } else {
      const data = await res.json().catch(() => ({ error: 'Unable to update ticker owner.' }));
      window.alert(data.error || 'Unable to update ticker owner.');
      loadTickers();
    }
  };

  const handleMoveTicker = async (teamTickers, index, direction) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= teamTickers.length) return;

    const reorderedGroup = [...teamTickers];
    [reorderedGroup[index], reorderedGroup[targetIndex]] = [reorderedGroup[targetIndex], reorderedGroup[index]];
    const groupIds = new Set(reorderedGroup.map(t => t.id));
    const reorderedAll = [
      ...reorderedGroup.map(t => t.id),
      ...tickers.filter(t => !groupIds.has(t.id)).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)).map(t => t.id)
    ];

    const res = await authFetch(`${API_BASE}/api/tickers/order`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickerIds: reorderedAll })
    });

    if (res.ok) {
      loadTickers();
    } else {
      const data = await res.json().catch(() => ({ error: 'Unable to reorder tickers.' }));
      window.alert(data.error || 'Unable to reorder tickers.');
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

  const toggleTickerTeam = (teamName) => {
    setCollapsedTickerTeams(prev => ({
      ...prev,
      [teamName]: !(prev[teamName] ?? true)
    }));
  };

  const isTickerTeamCollapsed = (teamName) => collapsedTickerTeams[teamName] ?? true;

  if (!auth?.token) {
    return <LoginPanel onLogin={setAuth} />;
  };

  const tickerGroups = tickers.reduce((groups, ticker) => {
    const groupName = ticker.team || NO_TEAM_LABEL;
    if (!groups[groupName]) groups[groupName] = [];
    groups[groupName].push(ticker);
    return groups;
  }, {});
  const sortedTickerGroups = Object.entries(tickerGroups)
    .sort(([a], [b]) => {
      if (a === NO_TEAM_LABEL) return 1;
      if (b === NO_TEAM_LABEL) return -1;
      if (isUnassignedTeam(a) && b !== NO_TEAM_LABEL) return 1;
      if (isUnassignedTeam(b) && a !== NO_TEAM_LABEL) return -1;
      return a.localeCompare(b);
    })
    .map(([teamName, teamTickers]) => [
      teamName,
      teamTickers.sort((a, b) => {
        const orderDiff = (a.sortOrder || 0) - (b.sortOrder || 0);
        if (orderDiff !== 0) return orderDiff;
        return a.id.localeCompare(b.id);
      })
    ]);
  const availableTeams = Array.from(new Set([
    ...users.flatMap(listUser => getTeams(listUser)),
    ...tickers.map(ticker => ticker.team)
  ].filter(Boolean))).sort((a, b) => a.localeCompare(b));
  const userAssignableTeams = availableTeams.filter(team => !isUnassignedTeam(team));

  return (
    <div className="news-desk dark-theme">
      <header className="desk-header">
        <h1>🎙️ {PANEL_NAME}</h1>
        <p>{PANEL_DESC}</p>
        <div className="session-actions">
          <span>{user.username.toUpperCase()} | {user.role.toUpperCase()}</span>
          <button type="button" className="btn-warn" onClick={handleLogout}>Sign Out</button>
        </div>
      </header>

      <div className="dashboard-grid">
        <section className="desk-card ticker-profiles-card full-width-card">
          <h2>
            <button type="button" className="panel-title-toggle" onClick={() => setShowTickerProfiles(prev => !prev)}>
            📁 Ticker Profiles
            </button>
            <span className="panel-heading-actions">
              <button type="button" className="btn-toggle" onClick={resetTickerProfileForm}>Clear Fields</button>
              <button type="button" className="btn-toggle" onClick={() => setShowTickerProfiles(prev => !prev)}>
                {showTickerProfiles ? 'Collapse' : 'Expand'}
              </button>
            </span>
          </h2>
          {showTickerProfiles && (
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
                  <option value="team">Team Shared ({selectedTickerTeam})</option>
                  <option value="private">Private ({user.username})</option>
                </select>
              </div>
            )}

            {canCreateTeamTicker && tickerScope !== 'private' && userTeams.length > 1 && (
              <div className="form-group">
                <label>Ticker Team</label>
                <select value={selectedTickerTeam} onChange={e => setTickerTeam(e.target.value)}>
                  {userTeams.map(team => (
                    <option key={team} value={team}>{team}</option>
                  ))}
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
                <select
                  value={fontFamily}
                  onChange={e => setFontFamily(e.target.value)}
                  style={{ fontFamily }}
                >
                  {FONT_GROUPS.map(group => (
                    <optgroup key={group.label} label={group.label}>
                      {group.options.map(option => (
                        <option key={option.value} value={option.value} style={{ fontFamily: option.value }}>
                          {option.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
            </div>

            <div className="form-group">
              <div className="label-with-check">
                <label>Fallback Message (When Queue Is Empty)</label>
                <label className="inline-check">
                  BLANK
                  <input
                    type="checkbox"
                    checked={fallbackBlank}
                    onChange={e => {
                      setFallbackBlank(e.target.checked);
                      if (e.target.checked) setFallbackMessage('');
                    }}
                  />
                </label>
              </div>
              <input
                type="text"
                placeholder={fallbackBlank
                  ? 'Fallback message checked as blank. The fallback message will not display.'
                  : `Leave empty to use default: ${FALLBACK_STREAM}`}
                value={fallbackMessage}
                disabled={fallbackBlank}
                onChange={e => setFallbackMessage(e.target.value)}
              />
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
          )}
        </section>

          <section className="desk-card manage-feed-card">
            <h2>
              <button type="button" className="panel-title-toggle" onClick={() => setShowActiveTickers(prev => !prev)}>
                📢 Manage Feed: <span className="highlight">{activeTickerId ? `/${activeTickerId}` : '[searching...]'}</span>
              </button>
              <button type="button" className="btn-toggle" onClick={e => {
                setShowActiveTickers(prev => !prev);
              }}>
                {showActiveTickers ? 'Collapse' : 'Expand'}
              </button>
            </h2>
            {!activeTickerId && showActiveTickers && (
              <div className="manage-feed-empty">
                <p className="empty-text">No ticker selected. Scanning for changes.</p>
              </div>
            )}
            {activeTickerId && showActiveTickers && (
            <>
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
                  <label>Queue Hierarchy</label>
                  <select value={headlinePriority} onChange={e => handleHeadlinePriorityChange(e.target.value)}>
                    <option value="normal">Rotating Standard Queue</option>
                    <option value="breaking">Priority Breaking Queue</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Region Jurisdiction</label>
                  <select value={headlineCategory} onChange={e => setHeadlineCategory(e.target.value)}>
                    <option value={HEADLINE_CATEGORY_OPTIONS[0]}>None (Blank)</option>
                    <option value={HEADLINE_CATEGORY_OPTIONS[1]}>BREAKING</option>
                    <option value={HEADLINE_CATEGORY_OPTIONS[2]}>Los Santos</option>
                    <option value={HEADLINE_CATEGORY_OPTIONS[3]}>Blaine County</option>
                    <option value={HEADLINE_CATEGORY_OPTIONS[4]}>Roxwood County</option>
                    <option className="select-separator-option" value={SELECT_SEPARATOR_VALUE} disabled>{SELECT_SEPARATOR_LABEL}</option>
                    <option value="__custom__">New / Custom</option>
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
                  {editingHeadlineId === hl.id ? (
                    <div className="queue-edit-form">
                      <div className="form-group">
                        <label>Headline Copy</label>
                        <textarea
                          rows="2"
                          value={editHeadlineText}
                          onChange={e => setEditHeadlineText(e.target.value)}
                        />
                      </div>
                      <div className="form-row">
                        <div className="form-group">
                          <label>Queue Hierarchy</label>
                          <select value={editHeadlinePriority} onChange={e => handleEditHeadlinePriorityChange(e.target.value)}>
                            <option value="normal">Rotating Standard Queue</option>
                            <option value="breaking">Priority Breaking Queue</option>
                          </select>
                        </div>
                        <div className="form-group">
                          <label>Region Jurisdiction</label>
                          <select value={editHeadlineCategory} onChange={e => setEditHeadlineCategory(e.target.value)}>
                            <option value={HEADLINE_CATEGORY_OPTIONS[0]}>None (Blank)</option>
                            <option value={HEADLINE_CATEGORY_OPTIONS[1]}>BREAKING</option>
                            <option value={HEADLINE_CATEGORY_OPTIONS[2]}>Los Santos</option>
                            <option value={HEADLINE_CATEGORY_OPTIONS[3]}>Blaine County</option>
                            <option value={HEADLINE_CATEGORY_OPTIONS[4]}>Roxwood County</option>
                            <option className="select-separator-option" value={SELECT_SEPARATOR_VALUE} disabled>{SELECT_SEPARATOR_LABEL}</option>
                            <option value="__custom__">New / Custom</option>
                          </select>
                        </div>
                        {editHeadlineCategory === '__custom__' && (
                          <div className="form-group">
                            <label>Custom Region Text</label>
                            <input
                              type="text"
                              value={editHeadlineCustomCategory}
                              onChange={e => setEditHeadlineCustomCategory(e.target.value)}
                            />
                          </div>
                        )}
                        <div className="form-group">
                          <label>Auto-Expire (0 = Never Expires)</label>
                          <input
                            type="number"
                            min="0"
                            max="1440"
                            value={editHeadlineDuration}
                            onChange={e => setEditHeadlineDuration(parseInt(e.target.value, 10) || 0)}
                          />
                        </div>
                      </div>
                      <div className="queue-edit-actions">
                        <button type="button" className="btn-primary" onClick={() => handleUpdateHeadline(hl.id)}>Save Headline</button>
                        <button type="button" className="btn-toggle" onClick={cancelEditingHeadline}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
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
                  <div className="queue-item-actions">
                    <span className="expire-badge">{formatExpireLabel(hl)}</span>
                    <button type="button" className="btn-toggle" onClick={() => startEditingHeadline(hl)}>Edit</button>
                    <button className="btn-delete" onClick={() => handleDeleteHeadline(hl.id)}>❌</button>
                  </div>
                    </>
                  )}
                </div>
              ))}
            </div>
            </>
            )}
          </section>

        <section className="desk-card active-tickers-card">
          <h2>
            <button type="button" className="panel-title-toggle" onClick={() => setShowActiveTickers(prev => !prev)}>
            ✅ Active System Tickers
            </button>
            <button type="button" className="btn-toggle" onClick={e => {
              setShowActiveTickers(prev => !prev);
            }}>
              {showActiveTickers ? 'Collapse' : 'Expand'}
            </button>
          </h2>
          {showActiveTickers && (
            <div className="ticker-list">
              {sortedTickerGroups.map(([teamName, teamTickers]) => (
                <div key={teamName} className="ticker-team-group">
                  <button
                    type="button"
                    className="ticker-team-heading"
                    onClick={() => toggleTickerTeam(teamName)}
                  >
                    <span>{teamName}</span>
                    <span>{isTickerTeamCollapsed(teamName) ? 'Expand' : 'Collapse'}</span>
                  </button>
                  {!isTickerTeamCollapsed(teamName) && teamTickers.map((t, index) => (
                    <div key={t.id} className={`ticker-list-item ${activeTickerId === t.id ? 'selected' : ''}`} onClick={() => populateTickerProfileForm(t)}>
                      <div>
                        <strong>/{t.id}</strong> <span className="small-badge" style={{backgroundColor: t.colorBadgeBg, color: t.colorBadgeText}}>{t.badgeType === 'image' ? 'IMAGE' : t.badge}</span>
                        <div className="speed-text">
                          Speed: {t.speed} | Font: {getFontLabel(t.fontFamily)}
                          {user.role === 'admin' && t.owner ? ` | Owner: ${t.owner}` : ''}
                        </div>
                        {(user.role === 'admin' || t.owner === user.username) && (
                          <div className="ticker-row-controls" onClick={e => e.stopPropagation()}>
                            <div className="ticker-assignment-control">
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
                                  userTeams.map(team => (
                                    <option key={team} value={team}>{team}</option>
                                  ))
                                )}
                              </select>
                            </div>
                            {user.role === 'admin' && (
                              <div className="ticker-assignment-control">
                                <label>Owner</label>
                                <select
                                  value={t.owner || ''}
                                  onChange={e => handleUpdateTickerOwner(t, e.target.value)}
                                >
                                  {users.map(listUser => (
                                    <option key={listUser.username} value={listUser.username}>{listUser.username}</option>
                                  ))}
                                </select>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="item-actions" onClick={e => e.stopPropagation()}>
                        {user.role === 'admin' && (
                          <div className="ticker-order-actions">
                            <button
                              type="button"
                              className="btn-reorder"
                              onClick={() => handleMoveTicker(teamTickers, index, -1)}
                              disabled={index === 0}
                              title="Move ticker up"
                            >
                              ^
                            </button>
                            <button
                              type="button"
                              className="btn-reorder"
                              onClick={() => handleMoveTicker(teamTickers, index, 1)}
                              disabled={index === teamTickers.length - 1}
                              title="Move ticker down"
                            >
                              v
                            </button>
                          </div>
                        )}
                        <button className={t.mode === 'emergency alert' ? 'btn-danger flashing' : 'btn-warn'} onClick={() => toggleEmergency(t.id, t.mode)}>
                          {t.mode === 'emergency alert' ? 'REMOVE OVERRIDE' : 'EMERGENCY'}
                        </button>
                        {(user.role === 'admin' || t.owner === user.username) && (
                          <button className="btn-delete" onClick={() => handleDeleteTicker(t.id)}>X</button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </section>

        {user.role !== 'admin' && (
          <section className="desk-card full-width-card">
            <h2>
              <button type="button" className="panel-title-toggle" onClick={() => setShowMyPassword(prev => !prev)}>
              🔐 My Password
              </button>
              <button type="button" className="btn-toggle" onClick={e => {
                setShowMyPassword(prev => !prev);
              }}>
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
              <button type="button" className="panel-title-toggle" onClick={() => setShowUserManagement(prev => !prev)}>
              👤 User Management
              </button>
              <button type="button" className="btn-toggle" onClick={e => {
                setShowUserManagement(prev => !prev);
              }}>
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
                      <select
                        value={newUserTeamMode}
                        onChange={e => {
                          setNewUserTeamMode(e.target.value);
                          if (e.target.value !== '__custom__') setNewUserTeam(e.target.value);
                        }}
                      >
                        <option value="">No team</option>
                        {userAssignableTeams.map(team => (
                          <option key={team} value={team}>{team}</option>
                        ))}
                        <option className="select-separator-option" value={SELECT_SEPARATOR_VALUE} disabled>{SELECT_SEPARATOR_LABEL}</option>
                        <option value="__custom__">New / Custom</option>
                      </select>
                      {newUserTeamMode === '__custom__' && (
                        <input
                          type="text"
                          placeholder="e.g. newsroom"
                          value={newUserTeam}
                          onChange={e => setNewUserTeam(e.target.value)}
                        />
                      )}
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
                    <div className="user-field-heading">
                    <label>Teams</label>
                    <div className="team-chip-list">
                      {getTeams(listUser).length === 0 ? <span className="team-empty">No teams</span> : null}
                      {getTeams(listUser).map(team => (
                        <button
                          key={team}
                          type="button"
                          className="team-chip"
                          onClick={() => removeTeamFromUserDraft(listUser.originalUsername, team)}
                        >
                          {team} ×
                        </button>
                      ))}
                    </div>
                    </div>
                    <div className="user-team-actions">
                      <select
                        value={listUser.draftTeamMode || ''}
                        onChange={e => {
                          const mode = e.target.value;
                          setUsers(users.map(u => u.originalUsername === listUser.originalUsername ? {
                            ...u,
                            draftTeamMode: mode,
                            draftTeam: mode === '__custom__' ? (u.draftTeam || '') : mode
                          } : u));
                        }}
                      >
                        <option value="">Add team</option>
                        {userAssignableTeams.map(team => (
                          <option key={team} value={team}>{team}</option>
                        ))}
                        <option className="select-separator-option" value={SELECT_SEPARATOR_VALUE} disabled>{SELECT_SEPARATOR_LABEL}</option>
                        <option value="__custom__">New / Custom</option>
                      </select>
                      {listUser.draftTeamMode === '__custom__' && (
                        <input
                          type="text"
                          value={listUser.draftTeam || ''}
                          placeholder="New team"
                          onChange={e => setUsers(users.map(u => u.originalUsername === listUser.originalUsername ? { ...u, draftTeam: e.target.value } : u))}
                        />
                      )}
                      <button type="button" className="btn-toggle" onClick={() => addTeamToUserDraft(listUser.originalUsername, listUser.draftTeam)}>
                        Add
                      </button>
                    </div>
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
  const tickerContainerRef = useRef(null);
  const tickerContentRef = useRef(null);
  const [scrollDistance, setScrollDistance] = useState(0);

  const fetchDisplayHeadlines = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/tickers/${id}/headlines`);
      const data = await res.json();
      setHeadlines(data);
    } catch (e) { console.error(e); }
  };

  useEffect(() => {
    if (!id) return;
    const handleConfigChanged = (newConfig) => setConfig(newConfig);
    const handleModeChanged = (data) => setConfig(prev => prev ? { ...prev, mode: data.mode } : null);
    const handleTickerDeleted = () => window.location.reload();

    socket.emit('join_ticker', id);
    fetchDisplayHeadlines();

    socket.on('config_changed', handleConfigChanged);
    socket.on('mode_changed', handleModeChanged);
    socket.on('headlines_updated', fetchDisplayHeadlines);
    socket.on('ticker_deleted', handleTickerDeleted);

    return () => {
      socket.emit('leave_ticker', id);
      socket.off('config_changed', handleConfigChanged);
      socket.off('mode_changed', handleModeChanged);
      socket.off('headlines_updated', fetchDisplayHeadlines);
      socket.off('ticker_deleted', handleTickerDeleted);
    };
  }, [id]);

  useEffect(() => {
    if (!config) return undefined;

    const measureScrollDistance = () => {
      const content = tickerContentRef.current;
      if (!content) return;
      setScrollDistance(content.scrollWidth || content.offsetWidth || 0);
    };

    measureScrollDistance();
    window.addEventListener('resize', measureScrollDistance);

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(measureScrollDistance)
      : null;

    if (resizeObserver) {
      if (tickerContainerRef.current) resizeObserver.observe(tickerContainerRef.current);
      if (tickerContentRef.current) resizeObserver.observe(tickerContentRef.current);
    }

    return () => {
      window.removeEventListener('resize', measureScrollDistance);
      if (resizeObserver) resizeObserver.disconnect();
    };
  }, [config, headlines]);

  if (!config) return <div className="loading">CONNECTING TO REDIS DATA LOGSTREAM...</div>;

  const isEmergency = config.mode === 'emergency alert';
  const fallbackScrollDistance = typeof window !== 'undefined' ? window.innerWidth * 2 : 1200;
  const effectiveScrollDistance = scrollDistance || fallbackScrollDistance;
  const configuredSpeed = parseInt(config.speed || '0', 10);
  const emergencySpeedMultiplier = isEmergency ? 0.75 : 1;
  const pixelsPerSecond = Math.max(configuredSpeed, 1) * 8 * emergencySpeedMultiplier;
  const animationDuration = configuredSpeed > 0
    ? `${Math.max(effectiveScrollDistance / pixelsPerSecond, 1)}s`
    : '0s';
  const displayedHeadlines = headlines.filter(hl => hl.priority === (isEmergency ? 'breaking' : 'normal'));
  const fallbackText = config.fallbackMode === 'blank' ? '' : (config.fallbackMessage || FALLBACK_STREAM);
  const fallbackPrefixMatch = fallbackText.match(/^(\[[^\]]+\])\s*(.*)$/);

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
    <div ref={tickerContainerRef} className={`ticker-container ${isEmergency ? 'emergency-mode' : ''}`} style={containerStyle}>
      <div className="badge-wrapper" style={badgeStyle}>
        {config.badgeType === 'image' ? (
          <img src={config.badge} alt="Logo" className="badge-img" onError={(e)=>{e.target.style.display='none';}} />
        ) : (
          config.badge
        )}
      </div>
      <div ref={tickerContentRef} className={`ticker-content ${config.speed === 0 ? 'speed-0' : ''}`} style={{ animationDuration }}>
        {displayedHeadlines.length === 0 && fallbackText ? (
          <span className="headline-item">
            {fallbackPrefixMatch ? (
              <>
                <span className="cat-bracket" style={{ color: isEmergency ? '#ffea00' : config.colorRegion }}>
                  {fallbackPrefixMatch[1]}
                </span>
                {fallbackPrefixMatch[2] ? ` ${fallbackPrefixMatch[2]}` : ''}
              </>
            ) : (
              fallbackText
            )}
          </span>
        ) : displayedHeadlines.length > 0 ? (
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
        ) : null}
      </div>
    </div>
  );
};

export default App;
