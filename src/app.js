'use strict';

// State
let games = [];
let config = { sgdbKey: '' };
let activeFilter = 'Playing';
let editingId = null;
let deleteTargetId = null;
let importCandidates = [];
let selectedImports = new Set();
let liveTracking = {};
let searchTimer = null;
let aiProfile = null;
let pcSpecs = null;
let aiSending = false;

const STATUS_ORDER = ['Playing', 'Finished', 'Dropped'];

// Application Boot
async function boot() {
  [games, config] = await Promise.all([window.api.loadGames(), window.api.loadConfig()]);

  // Apply Theme and Layout from config
  if (!config.theme) config.theme = 'default';
  if (!config.layout) config.layout = 'poster';
  
  if (config.theme === 'custom' && config.customTheme) {
    applyCustomTheme(config.customTheme);
  } else {
    document.documentElement.dataset.theme = config.theme;
  }
  
  const gameGrid = document.getElementById('game-grid');
  gameGrid.classList.remove('layout-compact', 'layout-list', 'layout-banner');
  if (config.layout !== 'poster') {
    gameGrid.classList.add(`layout-${config.layout}`);
  }
  
  const cols = config.gridColumns || 8;
  document.documentElement.style.setProperty('--grid-columns', cols);
  
  if (config.noise === false) {
    document.body.classList.add('no-noise');
  }
  
  if (config.animations === false) {
    document.body.classList.add('no-animations');
  }
  
  if (config.sidebarCollapsed) {
    document.getElementById('sidebar').classList.add('collapsed');
  }

  if (config.aiEnabled) document.getElementById('open-ai-chat').style.display = 'flex';
  
  // Render immediately so user doesn't see "0 games" while waiting for AI specs
  render();

  // Initialize In-App Updater
  initAppUpdater();

  // Sanitize bad sessions (merge fragmented tracking sessions < 5min apart, drop <1m ones)
  let dataChanged = false;
  games.forEach(g => {
    if (g.sessions && g.sessions.length > 0) {
      g.sessions.sort((a, b) => a.start - b.start);
      const newSessions = [];
      for (const s of g.sessions) {
        const last = newSessions.length > 0 ? newSessions[newSessions.length - 1] : null;
        if (last && (s.start - last.end) < 5 * 60000) {
          last.end = Math.max(last.end, s.end);
          last.duration = (last.end - last.start) / 3600000;
          dataChanged = true;
        } else {
          newSessions.push(s);
        }
      }
      const filtered = newSessions.filter(s => s.duration >= (1 / 60));
      if (filtered.length !== g.sessions.length || dataChanged) {
        g.sessions = filtered;
        g.hours = Math.round(g.sessions.reduce((sum, ses) => sum + ses.duration, 0) * 10) / 10;
        dataChanged = true;
      }
    }
  });
  if (dataChanged) await window.api.saveGames(games);

  // Titlebar
  document.getElementById('btn-min').onclick  = () => window.api.minimize();
  document.getElementById('btn-max').onclick  = () => window.api.maximize();
  document.getElementById('btn-close').onclick = () => window.api.close();

  // Nav
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.onclick = () => {
      activeFilter = btn.dataset.filter;
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('page-title').textContent =
        activeFilter === 'All' ? 'All Games' : activeFilter;
      render();
    };
  });

  // Sync sidebar + title with default filter
  document.querySelectorAll('.nav-item').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === activeFilter);
  });
  document.getElementById('page-title').textContent = activeFilter === 'All' ? 'All Games' : activeFilter;

  // Search + sort
  document.getElementById('search').addEventListener('input', render);
  document.getElementById('sort-select').addEventListener('change', render);

  // Theme Picker
  document.querySelectorAll('#theme-picker .theme-card').forEach(card => {
    card.onclick = () => {
      document.querySelectorAll('#theme-picker .theme-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      const theme = card.dataset.theme;
      
      if (theme === 'custom') {
        document.getElementById('custom-theme-builder').style.display = 'block';
        applyCustomTheme();
      } else {
        document.getElementById('custom-theme-builder').style.display = 'none';
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.removeProperty('--bg-base');
        document.documentElement.style.removeProperty('--bg-sidebar');
        document.documentElement.style.removeProperty('--bg-card');
        document.documentElement.style.removeProperty('--accent');
        document.documentElement.style.removeProperty('--accent-hover');
        document.documentElement.style.removeProperty('--text-primary');
      }
      config.theme = theme;
    };
  });

  // Custom theme color pickers (sync color <-> hex inputs, and live-apply)
  ['bg', 'sidebar', 'card', 'accent', 'text'].forEach(key => {
    const colorInput = document.getElementById(`custom-${key}`);
    const hexInput = document.getElementById(`custom-${key}-hex`);
    if (!colorInput || !hexInput) return;
    colorInput.addEventListener('input', () => { hexInput.value = colorInput.value; applyCustomTheme(); });
    hexInput.addEventListener('input', () => { if (/^#[0-9a-f]{6}$/i.test(hexInput.value)) { colorInput.value = hexInput.value; applyCustomTheme(); } });
  });

  // Layout Picker
  document.querySelectorAll('#layout-picker .layout-option').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('#layout-picker .layout-option').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const layout = btn.dataset.layout;
      const grid = document.getElementById('game-grid');
      grid.classList.remove('layout-compact', 'layout-list', 'layout-banner');
      if (layout !== 'poster') grid.classList.add(`layout-${layout}`);
      config.layout = layout;
    };
  });

  // Cards per Row Slider
  const gridSizeSlider = document.getElementById('grid-size-slider');
  const gridSizeValue = document.getElementById('grid-size-value');
  if (gridSizeSlider) {
    gridSizeSlider.addEventListener('input', (e) => {
      const cols = parseInt(e.target.value, 10);
      gridSizeValue.textContent = cols === 8 ? '8 Columns (Default)' : `${cols} Columns`;
      document.documentElement.style.setProperty('--grid-columns', cols);
    });
  }

  // Visual Effects Toggles
  const noiseToggle = document.getElementById('settings-noise');
  if (noiseToggle) {
    noiseToggle.addEventListener('change', (e) => {
      config.noise = e.target.checked;
      document.body.classList.toggle('no-noise', !config.noise);
    });
  }

  const animToggle = document.getElementById('settings-animations');
  if (animToggle) {
    animToggle.addEventListener('change', (e) => {
      config.animations = e.target.checked;
      document.body.classList.toggle('no-animations', !config.animations);
    });
  }

  // Custom Theme Sliders
  const glowSlider = document.getElementById('custom-glow');
  const glowValue = document.getElementById('glow-value');
  if (glowSlider) {
    glowSlider.addEventListener('input', (e) => {
      glowValue.textContent = e.target.value + '%';
      applyCustomTheme();
    });
  }
  
  const radiusSlider = document.getElementById('custom-radius');
  const radiusValue = document.getElementById('radius-value');
  if (radiusSlider) {
    radiusSlider.addEventListener('input', (e) => {
      radiusValue.textContent = e.target.value + 'px';
      applyCustomTheme();
    });
  }
  
  const borderHexInput = document.getElementById('custom-border-hex');
  const borderColorInput = document.getElementById('custom-border');
  if (borderColorInput && borderHexInput) {
    borderColorInput.addEventListener('input', () => { borderHexInput.value = borderColorInput.value; applyCustomTheme(); });
    borderHexInput.addEventListener('input', () => { if (/^#[0-9a-f]{6}$/i.test(borderHexInput.value)) { borderColorInput.value = borderHexInput.value; applyCustomTheme(); } });
  }

  // Sidebar Toggle
  const toggleSidebar = () => {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('collapsed');
    config.sidebarCollapsed = sidebar.classList.contains('collapsed');
    window.api.saveConfig(config);
  };
  
  const sidebarCollapseBtn = document.getElementById('sidebar-collapse');
  if (sidebarCollapseBtn) sidebarCollapseBtn.addEventListener('click', toggleSidebar);
  
  // Sidebar Greeting
  const greetings = [
    "Ready to play,",
    "Welcome back,",
    "Game on,",
    "What's next,",
    "Level up,"
  ];
  const greetingTextEl = document.getElementById('greeting-text');
  if (greetingTextEl) {
    greetingTextEl.textContent = greetings[Math.floor(Math.random() * greetings.length)];
  }

  const usernameEl = document.getElementById('greeting-username');
  if (usernameEl) {
    usernameEl.textContent = config.username || "Player 1";
    usernameEl.addEventListener('blur', () => {
      const newName = usernameEl.textContent.trim();
      if (newName) {
        config.username = newName;
        window.api.saveConfig(config);
      } else {
        usernameEl.textContent = config.username || "Player 1";
      }
    });
    usernameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        usernameEl.blur();
      }
    });
  }

  // Settings Navigation Tabs
  document.querySelectorAll('.settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.settings-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const paneId = tab.dataset.tab;
      document.querySelector(`.settings-pane[data-pane="${paneId}"]`).classList.add('active');
    });
  });

  // Add game
  document.getElementById('open-add').onclick      = openAdd;
  document.getElementById('empty-add-btn').onclick = openAdd;

  // Wishlist
  document.getElementById('open-wishlist').onclick  = openWishlist;
  document.getElementById('wishlist-close').onclick  = closeWishlist;
  document.getElementById('wishlist-save').onclick   = saveWishlist;
  document.getElementById('wishlist-overlay').onclick = e => { if (e.target === e.currentTarget) closeWishlist(); };
  document.getElementById('wishlist-search').addEventListener('input', onWishlistSearch);
  document.getElementById('wishlist-name').addEventListener('keydown', e => { if (e.key === 'Enter') saveWishlist(); });

  // Media Library
  document.getElementById('open-media').onclick  = openMediaLibrary;
  document.getElementById('media-close').onclick = closeMediaLibrary;
  document.getElementById('media-overlay').onclick = e => { if (e.target === e.currentTarget) closeMediaLibrary(); };

  // Activity Dashboard
  document.getElementById('open-activity').onclick = openActivityDashboard;
  document.getElementById('activity-close').onclick = closeActivityDashboard;
  document.getElementById('activity-overlay').onclick = e => { if (e.target === e.currentTarget) closeActivityDashboard(); };

  // Import Sources Pop-up Modal
  function openImportSources() {
    document.getElementById('import-sources-overlay').style.display = 'flex';
  }
  function closeImportSources() {
    document.getElementById('import-sources-overlay').style.display = 'none';
  }
  document.getElementById('open-import-sources').onclick = openImportSources;
  document.getElementById('import-sources-close').onclick = closeImportSources;
  document.getElementById('import-sources-overlay').onclick = e => { if (e.target === e.currentTarget) closeImportSources(); };

  document.getElementById('source-steam').onclick  = () => { closeImportSources(); runDetect('steam'); };
  document.getElementById('source-epic').onclick   = () => { closeImportSources(); runDetect('epic'); };
  document.getElementById('source-folder').onclick = () => { closeImportSources(); runDetect('folder'); };
  document.getElementById('source-smart').onclick  = () => { closeImportSources(); runSmartScan(); };

  // Smart scan progress listener
  window.api.onDetectProgress((msg) => {
    const desc = document.getElementById('source-smart-desc');
    if (desc) desc.textContent = msg || 'Deep scan drives with heuristics';
  });

  // Add/edit modal
  document.getElementById('modal-close').onclick  = closeModal;
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('modal-save').onclick   = saveGame;
  document.getElementById('modal-overlay').onclick = e => { if (e.target === e.currentTarget) closeModal(); };
  document.getElementById('exe-pick-btn').onclick  = pickExe;
  document.getElementById('cover-pick-btn').onclick = async () => {
    const dataUrl = await window.api.pickImage();
    if (dataUrl) { document.getElementById('field-cover').value = dataUrl; setCoverPreview(dataUrl); }
  };

  // SGDB search
  document.getElementById('sgdb-search').addEventListener('input', onSGDBInput);

  // Import modal
  document.getElementById('import-close').onclick    = closeImport;
  document.getElementById('import-cancel').onclick   = closeImport;
  document.getElementById('import-select-all').onclick = selectAllImports;
  document.getElementById('import-deselect-all').onclick = () => {
    selectedImports.clear();
    document.querySelectorAll('.import-row').forEach(item => {
      item.classList.remove('selected');
      const check = item.querySelector('.import-row-check');
      if (check) check.textContent = '';
    });
  };
  document.getElementById('import-confirm').onclick  = confirmImport;

  // Settings
  document.getElementById('open-settings').onclick  = openSettings;
  document.getElementById('settings-close').onclick = closeSettings;
  document.getElementById('settings-cancel').onclick = closeSettings;
  document.getElementById('settings-save').onclick   = saveSettings;
  const sgdbLink = document.getElementById('sgdb-link');
  if (sgdbLink) sgdbLink.onclick = e => { e.preventDefault(); window.api.openExternal('https://steamgriddb.com/profile/preferences/api'); };


  // AI Chat
  document.getElementById('open-ai-chat').onclick = openAIChat;
  document.getElementById('ai-close').onclick = closeAIChat;
  document.getElementById('ai-clear-history').onclick = clearAIChatHistory;
  document.getElementById('ai-send').onclick = sendAIMessage;
  document.getElementById('ai-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAIMessage(); } });
  document.querySelectorAll('.ai-quick-btn').forEach(btn => {
    btn.onclick = () => { document.getElementById('ai-input').value = btn.dataset.msg; sendAIMessage(); };
  });

  // Delete confirm
  document.getElementById('confirm-cancel').onclick = () => { document.getElementById('confirm-overlay').style.display = 'none'; deleteTargetId = null; };
  document.getElementById('confirm-ok').onclick     = confirmDelete;
  document.getElementById('confirm-overlay').onclick = e => { if (e.target === e.currentTarget) { document.getElementById('confirm-overlay').style.display = 'none'; deleteTargetId = null; } };

  // Game detail page
  document.getElementById('gp-back').onclick = closeGamePage;
  document.getElementById('gp-launch').onclick = () => { if (currentGamePageId) launchGame(currentGamePageId); };
  document.getElementById('gp-edit').onclick = () => { const id = currentGamePageId; if (id) { closeGamePage(); openEdit(id); } };
  document.getElementById('gp-delete').onclick = () => { const id = currentGamePageId; if (id) { closeGamePage(); promptDelete(id); } };
  document.getElementById('gp-summary-refresh').onclick = () => {
    if (!currentGamePageId) return;
    const g = games.find(x => String(x.id) === String(currentGamePageId));
    if (g) { delete g.perfAnalysis; window.api.saveGames(games); }
    generatePerfAnalysis(currentGamePageId);
  };

  // Rating — button + input
  document.getElementById('gp-rate-btn').onclick = () => {
    const g = currentGamePageId ? games.find(x => String(x.id) === String(currentGamePageId)) : null;
    document.getElementById('gp-rate-btn').style.display = 'none';
    document.getElementById('gp-rate-input-wrap').style.display = 'flex';
    const input = document.getElementById('gp-rate-input');
    input.value = g?.rating || '';
    input.focus();
    input.select();
  };
  document.getElementById('gp-rate-save').onclick = () => saveRatingFromInput();
  document.getElementById('gp-rate-cancel').onclick = () => cancelRatingInput();
  document.getElementById('gp-rate-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveRatingFromInput();
    if (e.key === 'Escape') cancelRatingInput();
  });

  // Context menu items
  document.getElementById('ctx-launch').onclick = () => { if (ctxGameId) launchGame(ctxGameId); hideContextMenu(); };
  document.getElementById('ctx-edit').onclick = () => { if (ctxGameId) openEdit(ctxGameId); hideContextMenu(); };
  document.getElementById('ctx-page').onclick = () => { if (ctxGameId) openGamePage(ctxGameId); hideContextMenu(); };
  document.getElementById('ctx-delete').onclick = () => { if (ctxGameId) promptDelete(ctxGameId); hideContextMenu(); };

  // Click away to dismiss context menu
  document.addEventListener('click', () => hideContextMenu());
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.game-card')) hideContextMenu();
  });

  // Keyboard
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeGamePage(); hideContextMenu(); closeModal(); closeImport(); closeSettings(); closeWishlist(); closeAIChat(); closeMediaLibrary(); closeActivityDashboard(); document.getElementById('confirm-overlay').style.display = 'none'; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); openAdd(); }
  });

  // Tracking events from main process
  window.api.onProfileUpdated(profile => {
    const oldLen = aiProfile && aiProfile.chatHistory ? aiProfile.chatHistory.length : 0;
    const newLen = profile && profile.chatHistory ? profile.chatHistory.length : 0;
    aiProfile = profile;
    if (oldLen !== newLen && document.getElementById('ai-panel').classList.contains('open')) {
      renderAIChatHistory();
    }
  });
  window.api.onTrackingTick(({ gameId, sessionMins }) => {
    liveTracking[String(gameId)] = sessionMins;
    updateTrackingBadge(String(gameId), sessionMins);
  });
  window.api.onTrackingSessionEnd(async ({ gameId, sessionHours, sessionStart, sessionEnd }) => {
    delete liveTracking[String(gameId)];
    const g = games.find(x => String(x.id) === String(gameId));
    if (g) {
      if (!g.sessions) g.sessions = [];
      
      const lastSession = g.sessions.length > 0 ? g.sessions[g.sessions.length - 1] : null;
      let sessionSaved = false;
      // If gap is less than 5 minutes, merge them to prevent spam from tracker timeouts
      if (lastSession && (sessionStart - lastSession.end) < 5 * 60000) {
        lastSession.end = sessionEnd;
        lastSession.duration = (lastSession.end - lastSession.start) / 3600000;
        sessionSaved = true;
      } else {
        // Only save if duration is at least 1 minute to avoid accidental clicks
        if (sessionHours >= (1 / 60)) {
          g.sessions.push({ start: sessionStart, end: sessionEnd, duration: sessionHours });
          sessionSaved = true;
        }
      }
      
      g.hours = Math.round(g.sessions.reduce((s, ses) => s + ses.duration, 0) * 10) / 10;
      await window.api.saveGames(games);
      render();
      
      if (sessionSaved) {
        const dur = formatDurationLong(sessionHours * 60);
        showSessionSummary(g.name, dur, `${g.hours}h total`);
      }
    }
  });
  window.api.onTrackingStarted(({ gameId }) => {
    liveTracking[String(gameId)] = 0;
    updateTrackingBadge(String(gameId), 0);
    const g = games.find(x => String(x.id) === String(gameId));
    if (g) toast(`Tracking started: ${g.name}`);
  });
  window.api.onTrackingDetected(({ gameId, gameName }) => {
    toast(`Now tracking: ${gameName}`);
    render();
  });

  window.api.onLaunchError(({ gameId, error }) => {
    const g = games.find(x => String(x.id) === String(gameId));
    const name = g ? g.name : 'Game';
    toast(`⚠ ${name}: ${error.split('\n')[0]}`, 'error');
  });

  // Start tracking for games already running when app opens
  const runningIds = await window.api.scanRunning(games);
  games.filter(g => g.exePath && g.status === 'Playing').forEach(g => {
    window.api.trackingStart(g.id, g.exePath);
  });
  if (runningIds.length) toast(`Tracking ${runningIds.length} already-running game${runningIds.length > 1 ? 's' : ''}`);

  // Data path in settings
  const dp = await window.api.getDataPath();
  document.getElementById('settings-data-path').textContent = dp;

  // Load PC specs (from cached profile to save time)
  aiProfile = await window.api.aiLoadProfile();
  if (aiProfile && aiProfile.pcSpecs) {
    pcSpecs = aiProfile.pcSpecs;
  } else {
    pcSpecs = await window.api.aiDetectSpecs();
    if (!aiProfile) aiProfile = { preferences: { likedGenres: [], dislikedGenres: [], dislikedGames: [], recommendedBefore: [] }, chatHistory: [], pcSpecs: null };
    aiProfile.pcSpecs = pcSpecs;
    await window.api.aiSaveProfile(aiProfile);
  }

  render();
}

// Library Grid Rendering
function render() {
  const q = document.getElementById('search').value.toLowerCase().trim();
  const sortVal = document.getElementById('sort-select').value;

  let filtered = games.filter(g => {
    if (g.status === 'Want') return false; // wishlist games never show in main grid
    if (activeFilter !== 'All' && g.status !== activeFilter) return false;
    if (q) {
      const hay = [g.name, g.source || '', g.notes || ''].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  filtered = [...filtered].sort((a, b) => {
    if (sortVal === 'name')   return a.name.localeCompare(b.name);
    if (sortVal === 'hours')  return (b.hours || 0) - (a.hours || 0);
    if (sortVal === 'status') return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    return (b.added || 0) - (a.added || 0);
  });

  // Counts
  const counts = { All: games.filter(g => g.status !== 'Want').length };
  STATUS_ORDER.forEach(s => { counts[s] = games.filter(g => g.status === s).length; });
  counts.Want = games.filter(g => g.status === 'Want').length;
  document.getElementById('count-all').textContent      = counts.All;
  document.getElementById('count-playing').textContent  = counts.Playing;
  document.getElementById('count-finished').textContent = counts.Finished;
  document.getElementById('count-dropped').textContent  = counts.Dropped;
  document.getElementById('count-want').textContent     = counts.Want;

  // Stats
  const totalHours = games.filter(g => g.status !== 'Want').reduce((s, g) => s + (g.hours || 0), 0);
  const playable = games.filter(g => g.status !== 'Want').length;
  const completion = playable ? Math.round((counts.Finished / playable) * 100) : 0;
  document.getElementById('stat-total').textContent      = playable;
  document.getElementById('stat-hours').textContent      = totalHours % 1 === 0 ? totalHours + 'h' : totalHours.toFixed(1) + 'h';
  document.getElementById('stat-completion').textContent = completion + '%';

  const totalNonWant = games.filter(g => g.status !== 'Want').length;
  document.getElementById('page-count').textContent =
    filtered.length !== totalNonWant ? `${filtered.length} of ${totalNonWant}` : `${totalNonWant} games`;

  const grid = document.getElementById('game-grid');
  const emptyState = document.getElementById('empty-state');

  if (filtered.length === 0) {
    grid.innerHTML = '';
    grid.style.display = 'none';
    emptyState.style.display = 'flex';
    document.getElementById('empty-sub').textContent = games.length === 0
      ? 'Use the detect buttons or add manually' : 'No games match your search';
    document.getElementById('empty-add-btn').style.display = games.length === 0 ? 'block' : 'none';
  } else {
    emptyState.style.display = 'none';
    grid.style.display = 'grid';
    grid.innerHTML = filtered.map((g, i) => buildCard(g, i)).join('');

    grid.querySelectorAll('.game-card').forEach(card => {
      const id = card.dataset.id;
      // Left-click → game detail page (unless clicking play button)
      card.addEventListener('click', e => {
        if (!e.target.closest('.card-play')) openGamePage(id);
      });
      // Right-click → context menu
      card.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, id);
      });
      // Play/Stop button
      card.querySelector('.card-play')?.addEventListener('click', e => {
        e.stopPropagation();
        const isRunning = liveTracking[id] != null;
        if (isRunning) stopGame(id);
        else launchGame(id);
      });
    });
  }
}

function buildCard(g, index = 0) {
  const sid = String(g.id);
  const tracking = liveTracking[sid];
  const canLaunch = !!(g.exePath || g.steamAppId);

  const isRunning = liveTracking[sid] != null;
  const runningIndicator = isRunning
    ? `<div class="running-indicator"><span class="running-dot"></span>Running</div>` : '';

  const coverHtml = g.coverUrl
    ? `<img class="card-cover" src="${esc(g.coverUrl)}" loading="lazy" onerror="this.outerHTML='<div class=\\'card-cover-placeholder\\'>🎮</div>'" />`
    : `<div class="card-cover-placeholder">🎮</div>`;

  const launchBtn = canLaunch
    ? `<button class="card-btn launch ${isRunning ? 'is-running' : ''}" title="${isRunning ? 'Running' : 'Launch'}">${isRunning ? '■' : '▶'}</button>` : '';

  const hoursDisplay = (() => {
    const base = g.hours || 0;
    if (tracking != null) {
      const total = base + tracking / 60;
      return `<span class="tracking-badge"><span class="tracking-dot"></span>${total.toFixed(1)}h</span>`;
    }
    return base ? `<span class="card-hours">${base % 1 === 0 ? base : base.toFixed(1)}h</span>` : '';
  })();

  const source = g.source ? `<span class="card-dot">·</span><span class="card-source">${esc(g.source)}</span>` : '';

  const ratingBadge = g.rating
    ? `<div class="card-rating ${g.rating <= 3 ? 'score-low' : g.rating <= 5 ? 'score-mid' : g.rating <= 8 ? 'score-high' : 'score-top'}">${g.rating}/10</div>`
    : '';

  // Big play/stop button
  let playBtn = '';
  if (canLaunch) {
    if (isRunning) {
      playBtn = `<button class="card-play running"><span class="cp-default"><span class="running-dot"></span> Running</span><span class="cp-hover">Stop</span></button>`;
    } else {
      playBtn = `<button class="card-play"><span class="cp-default">▶</span><span class="cp-hover">▶ Play</span></button>`;
    }
  }

  // Stagger animation up to max 500ms (so large grids don't take forever)
  const animDelay = Math.min(index * 0.03, 0.5);

  return `
    <div class="game-card ${g.status}" data-id="${sid}" style="animation-delay: ${animDelay}s">
      ${coverHtml}
      ${ratingBadge}
      ${playBtn}
      <div class="card-body">
        <div class="card-top">
          <div class="card-name">${esc(g.name)}</div>
        </div>
        <div class="card-meta">
          <span class="status-badge ${g.status}">${g.status}</span>
          ${hoursDisplay}${source}
        </div>
      </div>
    </div>`;
}

function updateTrackingBadge(gameId, sessionMins) {
  const card = document.querySelector(`.game-card[data-id="${gameId}"]`);
  if (!card) return;
  const g = games.find(x => String(x.id) === gameId);
  if (!g) return;

  // Update hours badge
  const meta = card.querySelector('.card-meta');
  if (meta) {
    const existing = meta.querySelector('.tracking-badge');
    const timerText = formatDurationHMS(sessionMins);
    const badge = `<span class="tracking-badge"><span class="tracking-dot"></span>${timerText}</span>`;
    if (existing) {
      existing.outerHTML = badge;
    } else {
      const hoursEl = meta.querySelector('.card-hours');
      if (hoursEl) hoursEl.outerHTML = badge;
      else meta.insertAdjacentHTML('beforeend', badge);
    }
  }

  // Update play button to running state
  const playBtn = card.querySelector('.card-play');
  if (playBtn && !playBtn.classList.contains('running')) {
    playBtn.classList.add('running');
    playBtn.innerHTML = '<span class="cp-default"><span class="running-dot"></span> Running</span><span class="cp-hover">Stop</span>';
  }
}

// Session duration formatting
function formatDurationLong(mins) {
  if (mins < 1) return '<1m';
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatDurationHMS(mins) {
  const h = Math.floor(mins / 60);
  const m = Math.floor(mins % 60);
  const s = Math.floor((mins * 60) % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function showSessionSummary(gameName, duration, totalTime) {
  // Remove any existing summary
  document.getElementById('session-summary-toast')?.remove();
  
  const el = document.createElement('div');
  el.id = 'session-summary-toast';
  el.className = 'session-summary-toast';
  el.innerHTML = `
    <div class="sst-header">
      <span class="sst-icon">✦</span>
      <span class="sst-title">Session Complete</span>
      <button class="sst-close" onclick="this.closest('.session-summary-toast').remove()">✕</button>
    </div>
    <div class="sst-game">${esc(gameName)}</div>
    <div class="sst-stats sst-stats-2">
      <div class="sst-stat"><span class="sst-val">${duration}</span><span class="sst-label">Duration</span></div>
      <div class="sst-stat"><span class="sst-val">${totalTime}</span><span class="sst-label">Total</span></div>
    </div>`;
  document.body.appendChild(el);
  
  // Auto dismiss after 6 seconds
  setTimeout(() => {
    if (el.parentNode) {
      el.style.animation = 'sstSlideOut 0.3s ease forwards';
      setTimeout(() => el.remove(), 350);
    }
  }, 6000);
}

// Auto-detect
async function runDetect(type) {
  const btn = document.getElementById('open-import-sources');
  const labels = { steam: 'Steam', epic: 'Epic Games', folder: 'Folder', disk: 'All Drives', smart: 'AI Smart Scan' };
  toast(`Scanning for ${labels[type] || type} games...`);
  if (btn) btn.classList.add('loading');
  try {
    let detected = [];
    if (type === 'steam')  detected = await window.api.detectSteam();
    if (type === 'epic')   detected = await window.api.detectEpic();
    if (type === 'folder') detected = await window.api.detectFolder();
    if (type === 'disk')   detected = await window.api.detectDisk();

    if (btn) btn.classList.remove('loading');

    if (!detected || !detected.length) { toast('No games found'); return; }
    openImport(detected, type);
  } catch (e) {
    if (btn) btn.classList.remove('loading');
    toast('Detection failed');
  }
}

async function runSmartScan() {
  if (!config.aiKey) {
    toast('AI Smart Scan requires an API Key — configure in Settings > Integrations', 'error');
    openSettings('integrations');
    return;
  }
  const btn = document.getElementById('open-import-sources');
  toast('Starting AI Smart Scan...');
  if (btn) btn.classList.add('loading');
  try {
    const detected = await window.api.smartScan();
    if (btn) btn.classList.remove('loading');
    if (!detected || !detected.length) { toast('No games found'); return; }
    openImport(detected, 'smart');
  } catch (e) {
    if (btn) btn.classList.remove('loading');
    toast('Smart scan failed: ' + (e.message || 'Unknown error'));
  }
}

// Import Modal
function openImport(candidates, type) {
  importCandidates = candidates;
  selectedImports = new Set();

  const existingNames = new Set(games.map(g => g.name.toLowerCase()));
  const newOnes = candidates.filter(c => !existingNames.has(c.name.toLowerCase()));

  const labels = { steam: 'Steam', epic: 'Epic Games', folder: 'Folder', disk: 'All Drives', smart: 'AI Smart Scan' };
  document.getElementById('import-title').textContent = `Import from ${labels[type] || type}`;
  document.getElementById('import-info').textContent =
    `${candidates.length} found · ${newOnes.length} new · ${candidates.length - newOnes.length} already in library`;

  // Pre-select new ones
  newOnes.forEach(c => selectedImports.add(candidates.indexOf(c)));

  const list = document.getElementById('import-list');
  list.innerHTML = candidates.map((c, i) => {
    const already = existingNames.has(c.name.toLowerCase());
    const selected = selectedImports.has(i);
    return `
      <div class="import-row ${selected ? 'selected' : ''} ${already ? 'already' : ''}" data-idx="${i}">
        <div class="import-row-check">${selected ? '✓' : ''}</div>
        <span class="import-row-name">${esc(c.name)}</span>
        ${already ? '<span class="import-row-badge">In library</span>' : ''}
      </div>`;
  }).join('');

  list.querySelectorAll('.import-row').forEach(item => {
    item.onclick = () => {
      const idx = Number(item.dataset.idx);
      if (selectedImports.has(idx)) {
        selectedImports.delete(idx);
        item.classList.remove('selected');
        item.querySelector('.import-row-check').textContent = '';
      } else {
        selectedImports.add(idx);
        item.classList.add('selected');
        item.querySelector('.import-row-check').textContent = '✓';
      }
    };
  });

  document.getElementById('import-overlay').style.display = 'flex';
}

function closeImport() { document.getElementById('import-overlay').style.display = 'none'; }

function selectAllImports() {
  // Select only new (non-already) items
  document.querySelectorAll('.import-row:not(.already)').forEach(item => {
    const idx = Number(item.dataset.idx);
    selectedImports.add(idx);
    item.classList.add('selected');
    const check = item.querySelector('.import-row-check');
    if (check) check.textContent = '✓';
  });
}

async function confirmImport() {
  const toAdd = [...selectedImports].map(i => ({
    ...importCandidates[i],
    id: Date.now() + Math.floor(Math.random() * 100000),
    added: Date.now(),
  }));
  games.push(...toAdd);
  await window.api.saveGames(games);

  // Start tracking for playing games with exe
  toAdd.filter(g => g.exePath && g.status === 'Playing').forEach(g => {
    window.api.trackingStart(g.id, g.exePath);
  });

  closeImport();
  render();
  toast(`Imported ${toAdd.length} game${toAdd.length !== 1 ? 's' : ''}`);
}

// Add / Edit Modal
function openAdd() {
  editingId = null;
  document.getElementById('modal-title').textContent = 'Add Game';
  document.getElementById('field-name').value   = '';
  document.getElementById('field-status').value = 'Playing';
  document.getElementById('field-hours').value  = '';
  document.getElementById('field-source').value = '';
  document.getElementById('field-exe').value    = '';
  document.getElementById('field-notes').value  = '';
  document.getElementById('field-cover').value  = '';
  document.getElementById('sgdb-search').value  = '';
  document.getElementById('sgdb-results').style.display = 'none';
  setCoverPreview('');
  document.getElementById('field-name').classList.remove('error');
  document.getElementById('modal-overlay').style.display = 'flex';
  setTimeout(() => document.getElementById('sgdb-search').focus(), 50);
}

function openEdit(id) {
  const g = games.find(x => String(x.id) === String(id));
  if (!g) return;
  editingId = id;
  document.getElementById('modal-title').textContent  = 'Edit Game';
  document.getElementById('field-name').value   = g.name;
  document.getElementById('field-status').value = g.status;
  document.getElementById('field-hours').value  = g.hours || '';
  document.getElementById('field-source').value = g.source || '';
  document.getElementById('field-exe').value    = g.exePath || '';
  document.getElementById('field-notes').value  = g.notes || '';
  document.getElementById('field-cover').value  = g.coverUrl || '';
  document.getElementById('sgdb-search').value  = '';
  document.getElementById('sgdb-results').style.display = 'none';
  setCoverPreview(g.coverUrl || '');
  document.getElementById('field-name').classList.remove('error');
  document.getElementById('modal-overlay').style.display = 'flex';
  setTimeout(() => document.getElementById('field-name').focus(), 50);
}

function closeModal() {
  document.getElementById('modal-overlay').style.display = 'none';
  document.getElementById('sgdb-results').style.display = 'none';
  editingId = null;
}

async function saveGame() {
  const name = document.getElementById('field-name').value.trim();
  if (!name) { document.getElementById('field-name').classList.add('error'); document.getElementById('field-name').focus(); return; }

  const hours  = parseFloat(document.getElementById('field-hours').value) || 0;
  const exePath = document.getElementById('field-exe').value.trim();
  const wasExe = editingId ? (games.find(g => String(g.id) === String(editingId))?.exePath || '') : '';

  if (editingId !== null) {
    const idx = games.findIndex(g => String(g.id) === String(editingId));
    if (idx !== -1) {
      const old = games[idx];
      games[idx] = { ...old, name, status: document.getElementById('field-status').value, hours, source: document.getElementById('field-source').value.trim(), exePath, notes: document.getElementById('field-notes').value.trim(), coverUrl: document.getElementById('field-cover').value || old.coverUrl || '' };
      // Restart tracking if exe changed
      if (exePath && exePath !== wasExe) {
        window.api.trackingStop(editingId);
        if (games[idx].status === 'Playing') window.api.trackingStart(editingId, exePath);
      }
    }
  } else {
    const newGame = { id: crypto.randomUUID(), name, status: document.getElementById('field-status').value, hours, source: document.getElementById('field-source').value.trim(), exePath, notes: document.getElementById('field-notes').value.trim(), coverUrl: document.getElementById('field-cover').value || '', added: Date.now() };
    games.push(newGame);
    if (exePath && newGame.status === 'Playing') window.api.trackingStart(newGame.id, exePath);
  }

  await window.api.saveGames(games);
  closeModal();
  render();
}

// SteamGridDB search
function onSGDBInput() {
  clearTimeout(searchTimer);
  const q = document.getElementById('sgdb-search').value.trim();
  const results = document.getElementById('sgdb-results');
  const spinner = document.getElementById('sgdb-spinner');

  if (!q) { results.style.display = 'none'; spinner.style.display = 'none'; return; }

  if (!config.sgdbKey) {
    results.innerHTML = `<div class="sgdb-no-key">SteamGridDB key required for cover search.<br><button onclick="window.openSettings('integrations')" style="margin-top:8px;background:var(--accent);color:#fff;border:none;padding:5px 12px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;">Add API Key in Settings ↗</button></div>`;
    results.style.display = 'block'; return;
  }

  spinner.style.display = 'block';
  results.style.display = 'none';
  searchTimer = setTimeout(() => searchSGDB(q), 450);
}

async function searchSGDB(q) {
  const spinner = document.getElementById('sgdb-spinner');
  const results = document.getElementById('sgdb-results');
  try {
    const data = await window.api.sgdbSearch(q);
    spinner.style.display = 'none';

    if (data === null) {
      results.innerHTML = `<div class="sgdb-no-key">⚙ Add your SteamGridDB API key in Settings</div>`;
      results.style.display = 'block';
      return;
    }
    if (!data.length) {
      results.innerHTML = `<div class="sgdb-no-key">No results for "${esc(q)}"</div>`;
      results.style.display = 'block';
      return;
    }

    results.innerHTML = data.map(r => {
      const year = r.releaseDate ? new Date(r.releaseDate * 1000).getFullYear() : '';
      return `<div class="sgdb-item" data-name="${esc(r.name)}" data-cover="${esc(r.coverUrl || '')}">
        ${r.coverUrl ? `<img class="sgdb-item-cover" src="${esc(r.coverUrl)}" loading="lazy" onerror="this.style.display='none'" />` : `<div class="sgdb-item-cover"></div>`}
        <span class="sgdb-item-name">${esc(r.name)}</span>
        ${year ? `<span class="sgdb-item-year">${year}</span>` : ''}
      </div>`;
    }).join('');

    results.querySelectorAll('.sgdb-item').forEach(item => {
      item.onclick = () => {
        document.getElementById('field-name').value  = item.dataset.name;
        document.getElementById('field-cover').value = item.dataset.cover;
        setCoverPreview(item.dataset.cover);
        results.style.display = 'none';
        document.getElementById('sgdb-search').value = '';
      };
    });

    results.style.display = 'block';
  } catch (e) {
    spinner.style.display = 'none';
    results.innerHTML = `<div class="sgdb-no-key">Search error — check your API key in Settings</div>`;
    results.style.display = 'block';
  }
}

function setCoverPreview(url) {
  const preview = document.getElementById('cover-preview');
  if (url) {
    preview.innerHTML = `<img src="${esc(url)}" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.innerHTML='<span class=\\'cover-placeholder\\'>No cover</span>'" />`;
  } else {
    preview.innerHTML = `<span class="cover-placeholder">No cover</span>`;
  }
}

// Executable File Picker
async function pickExe() {
  const p = await window.api.pickExe();
  if (p) document.getElementById('field-exe').value = p;
}

// Game launcher
function launchGame(id) {
  const g = games.find(x => String(x.id) === String(id));
  if (!g) return;
  if (g.exePath || g.steamAppId) {
    window.api.launchGame(g.exePath || '', g.steamAppId || '', g.id);
    toast(`Launching ${g.name}...`);
  }
}

async function stopGame(id) {
  const g = games.find(x => String(x.id) === String(id));
  if (!g) return;
  try {
    await window.api.killGame(g.id, g.exePath, g.installDir || '');
    toast(`Stopped ${g.name}`);
  } catch (e) {
    toast('Failed to stop game');
  }
}

let currentGamePageId = null;

function openGamePage(id) {
  const g = games.find(x => String(x.id) === String(id));
  if (!g) return;
  currentGamePageId = id;

  // Cover
  const coverEl = document.getElementById('gp-cover');
  const bgEl = document.getElementById('gp-bg');
  if (g.coverUrl) {
    coverEl.innerHTML = `<img src="${esc(g.coverUrl)}" onerror="this.outerHTML='<div class=\\'cover-empty\\'>🎮</div>'" />`;
  } else {
    coverEl.innerHTML = '<div class="cover-empty">🎮</div>';
  }

  // Background — use cached hero, or fetch from SteamGridDB
  if (g.heroUrl) {
    bgEl.innerHTML = `<img src="${esc(g.heroUrl)}" />`;
  } else if (g.coverUrl) {
    bgEl.innerHTML = `<img src="${esc(g.coverUrl)}" />`;
  } else {
    bgEl.innerHTML = '';
  }
  // Fetch hero banner async if not cached
  if (!g.heroUrl && config.sgdbKey) {
    window.api.sgdbHero(g.name).then(heroUrl => {
      if (heroUrl) {
        g.heroUrl = heroUrl;
        window.api.saveGames(games);
        if (String(currentGamePageId) === String(id)) {
          bgEl.innerHTML = `<img src="${esc(heroUrl)}" />`;
        }
      }
    });
  }

  // Info
  document.getElementById('gp-title').textContent = g.name;
  const statusEl = document.getElementById('gp-status');
  statusEl.textContent = g.status;
  statusEl.className = `status-badge ${g.status}`;
  const hours = g.hours || 0;
  document.getElementById('gp-hours').textContent = hours ? `${hours % 1 === 0 ? hours : hours.toFixed(1)} hours played` : '';
  document.getElementById('gp-source').textContent = g.source || '';
  document.getElementById('gp-notes').textContent = g.notes || '';

  // Launch button
  const launchBtn = document.getElementById('gp-launch');
  const canLaunch = !!(g.exePath || g.steamAppId);
  launchBtn.style.display = canLaunch ? '' : 'none';

  // Rating
  updateRatingDisplay(g.rating || 0);
  cancelRatingInput();

  // Specs
  const specsGrid = document.getElementById('gp-specs-grid');
  if (pcSpecs) {
    const gpuText = pcSpecs.allGpus?.length
      ? pcSpecs.allGpus.map(g => `${g.name} (${g.vram})`).join(', ')
      : pcSpecs.gpu || 'Unknown';
    specsGrid.innerHTML = `
      <div class="gp-spec-item"><strong>CPU</strong> ${esc(pcSpecs.cpu || 'Unknown')}</div>
      <div class="gp-spec-item"><strong>GPU</strong> ${esc(gpuText)}</div>
      <div class="gp-spec-item"><strong>RAM</strong> ${esc(pcSpecs.ram || 'Unknown')}</div>
      <div class="gp-spec-item"><strong>OS</strong> ${esc(pcSpecs.os || 'Unknown')}</div>`;
    document.getElementById('gp-specs').style.display = '';
  } else {
    document.getElementById('gp-specs').style.display = 'none';
  }

  // Performance analysis — auto-generate if not cached
  const perfEl = document.getElementById('gp-perf');
  if (g.perfAnalysis) {
    renderPerfAnalysis(perfEl, g.perfAnalysis);
  } else if (config.aiKey && pcSpecs) {
    generatePerfAnalysis(id);
  } else if (!config.aiKey) {
    perfEl.innerHTML = `
      <div class="ai-setup-guide" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;background:rgba(88,101,242,0.06);border:1px solid rgba(88,101,242,0.2);border-radius:var(--radius-md);margin-top:4px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:20px;">⚡</span>
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text-primary);">AI Key Required for FPS Analysis</div>
            <div style="font-size:11.5px;color:var(--text-muted);margin-top:2px;">Configure OpenAI, Claude, Gemini, or DeepSeek to see estimated FPS on your PC.</div>
          </div>
        </div>
        <button onclick="window.openSettings('integrations')" style="background:var(--accent);color:#fff;border:none;padding:7px 14px;border-radius:var(--radius-sm);font-family:'Inter',sans-serif;font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap;transition:background .15s;">Set Up in Settings ↗</button>
      </div>`;
  } else if (!pcSpecs) {
    perfEl.innerHTML = '<span style="color:var(--text-muted)">Specs not detected — restart the app to detect your hardware</span>';
  }

  // Session History
  renderSessionHistory(g);

  document.getElementById('game-page').style.display = '';
}

function renderSessionHistory(g) {
  const section = document.getElementById('gp-sessions');
  const sessions = g.sessions || [];
  
  if (sessions.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  
  // Stats
  const totalHrs = sessions.reduce((s, ses) => s + ses.duration, 0);
  const avgMins = (totalHrs * 60) / sessions.length;
  const longestMins = Math.max(...sessions.map(s => s.duration * 60));
  
  // Daily breakdown for today/this week
  const now = Date.now();
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const weekStart = new Date(todayStart); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  
  const todayHrs = sessions.filter(s => s.start >= todayStart.getTime()).reduce((a, s) => a + s.duration, 0);
  const weekHrs = sessions.filter(s => s.start >= weekStart.getTime()).reduce((a, s) => a + s.duration, 0);
  
  document.getElementById('gp-sessions-stats').innerHTML = `
    <div class="gp-ss-card">
      <div class="gp-ss-val">${formatDurationLong(totalHrs * 60)}</div>
      <div class="gp-ss-label">Total Time</div>
    </div>
    <div class="gp-ss-card">
      <div class="gp-ss-val">${sessions.length}</div>
      <div class="gp-ss-label">Sessions</div>
    </div>
    <div class="gp-ss-card">
      <div class="gp-ss-val">${formatDurationLong(avgMins)}</div>
      <div class="gp-ss-label">Average</div>
    </div>
    <div class="gp-ss-card">
      <div class="gp-ss-val">${formatDurationLong(longestMins)}</div>
      <div class="gp-ss-label">Longest</div>
    </div>
    <div class="gp-ss-card">
      <div class="gp-ss-val">${formatDurationLong(todayHrs * 60)}</div>
      <div class="gp-ss-label">Today</div>
    </div>
    <div class="gp-ss-card">
      <div class="gp-ss-val">${formatDurationLong(weekHrs * 60)}</div>
      <div class="gp-ss-label">This Week</div>
    </div>`;

  // 30-day chart
  const chartEl = document.getElementById('gp-sessions-chart');
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(todayStart);
    d.setDate(d.getDate() - i);
    const dayStart = d.getTime();
    const dayEnd = dayStart + 86400000;
    const dayHrs = sessions.filter(s => s.start >= dayStart && s.start < dayEnd).reduce((a, s) => a + s.duration, 0);
    days.push({ date: d, hours: dayHrs });
  }
  const maxDay = Math.max(...days.map(d => d.hours), 0.1);
  
  chartEl.innerHTML = days.map(d => {
    const pct = Math.max((d.hours / maxDay) * 100, d.hours > 0 ? 4 : 0);
    const dateStr = d.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const tipText = d.hours > 0 ? `${dateStr}: ${formatDurationLong(d.hours * 60)}` : `${dateStr}: —`;
    return `<div class="gp-sc-bar" title="${tipText}" style="height:${pct}%"></div>`;
  }).join('');

  // Session list (most recent first)
  const sorted = [...sessions].sort((a, b) => b.start - a.start);
  const listEl = document.getElementById('gp-sessions-list');
  const show = sorted.slice(0, 10);
  
  listEl.innerHTML = `
    <div class="gp-sl-header">Recent Sessions</div>
    ${show.map(s => {
      const d = new Date(s.start);
      const dateStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const dur = formatDurationLong(s.duration * 60);
      return `
        <div class="gp-sl-row">
          <div class="gp-sl-date">${dateStr} <span class="gp-sl-time">· ${timeStr}</span></div>
          <div class="gp-sl-dur">${dur}</div>
        </div>`;
    }).join('')}
    ${sorted.length > 10 ? `<div class="gp-sl-more">+ ${sorted.length - 10} more sessions</div>` : ''}`;
}

function closeGamePage() {
  document.getElementById('game-page').style.display = 'none';
  currentGamePageId = null;
}

function updateRatingDisplay(rating) {
  const btn = document.getElementById('gp-rate-btn');
  btn.className = 'gp-rate-btn';
  if (rating) {
    btn.textContent = `${rating}/10`;
    btn.classList.add('has-rating');
    if (rating <= 3) btn.classList.add('score-low');
    else if (rating <= 5) btn.classList.add('score-mid');
    else if (rating <= 7) btn.classList.add('score-ok');
    else if (rating <= 9) btn.classList.add('score-high');
    else btn.classList.add('score-top');
  } else {
    btn.textContent = 'Rate this game';
  }
}

function saveRatingFromInput() {
  const raw = parseFloat(document.getElementById('gp-rate-input').value);
  const rating = isNaN(raw) ? 0 : Math.round(Math.min(10, Math.max(0, raw)) * 10) / 10; // clamp 0-10, 1 decimal
  setGameRating(currentGamePageId, rating);
  cancelRatingInput();
}

function cancelRatingInput() {
  document.getElementById('gp-rate-btn').style.display = '';
  document.getElementById('gp-rate-input-wrap').style.display = 'none';
}

async function setGameRating(id, rating) {
  const g = games.find(x => String(x.id) === String(id));
  if (!g) return;
  g.rating = rating || 0;
  await window.api.saveGames(games);
  updateRatingDisplay(g.rating);
  render();
}

function renderPerfAnalysis(el, perf) {
  const verdictClass = perf.verdict === 'can_run' ? 'can-run' : perf.verdict === 'struggle' ? 'struggle' : 'cant-run';
  const verdictText = perf.verdict === 'can_run' ? '✓ Can Run' : perf.verdict === 'struggle' ? '⚠ Will Struggle' : '✕ Cannot Run';
  const fpsClass = (fps) => fps >= 55 ? 'fps-high' : fps >= 30 ? 'fps-mid' : 'fps-low';

  el.innerHTML = `
    <div class="gp-perf-verdict ${verdictClass}">${verdictText}</div>
    <div class="gp-perf-grid">
      <div class="gp-perf-row"><div class="gp-perf-label">Min CPU</div><div class="gp-perf-value">${esc(perf.req_cpu || '—')}</div></div>
      <div class="gp-perf-row"><div class="gp-perf-label">Min GPU</div><div class="gp-perf-value">${esc(perf.req_gpu || '—')}</div></div>
      <div class="gp-perf-row"><div class="gp-perf-label">Min RAM</div><div class="gp-perf-value">${esc(perf.req_ram || '—')}</div></div>
      <div class="gp-perf-row"><div class="gp-perf-label">Storage</div><div class="gp-perf-value">${esc(perf.req_storage || '—')}</div></div>
    </div>
    <div class="gp-perf-settings">
      ${(perf.tiers || []).map(t => `
        <div class="gp-perf-tier">
          <div class="gp-perf-tier-name">${esc(t.name)}</div>
          <div class="gp-perf-tier-fps ${fpsClass(t.fps)}">~${t.fps} FPS</div>
          <div class="gp-perf-tier-res">${esc(t.resolution)} · ${esc(t.settings)}</div>
        </div>`).join('')}
    </div>
    <div style="font-size: 11px; color: var(--text-muted); margin-top: 12px; font-style: italic; opacity: 0.8;">
      * AI analysis can make mistakes. Always verify hardware requirements yourself.
    </div>`;
}

async function generatePerfAnalysis(id) {
  const g = games.find(x => String(x.id) === String(id));
  if (!g) return;
  if (!config.aiKey) {
    toast('Add your AI Provider API key in Settings to analyze performance', 'error');
    openSettings('integrations');
    return;
  }
  if (!pcSpecs) return;

  const perfEl = document.getElementById('gp-perf');
  const refreshBtn = document.getElementById('gp-summary-refresh');
  perfEl.innerHTML = '<span class="loading">Analyzing performance...</span>';
  perfEl.classList.add('loading');
  refreshBtn.classList.add('spinning');

  const gpuText = pcSpecs.allGpus?.length
    ? pcSpecs.allGpus.map(g => `${g.name} (${g.vram})`).join(', ')
    : pcSpecs.gpu || 'Unknown';

  try {
    const result = await window.api.aiChat({
      message: `Analyze the performance of the video game "${g.name}" on this PC:
CPU: ${pcSpecs.cpu}
GPU: ${gpuText}
RAM: ${pcSpecs.ram}
OS: ${pcSpecs.os}

Reply ONLY with a valid JSON object (no markdown, no backticks) in this exact format:
{
  "verdict": "can_run" or "struggle" or "cant_run",
  "req_cpu": "minimum CPU needed",
  "req_gpu": "minimum GPU needed",
  "req_ram": "minimum RAM needed",
  "req_storage": "required disk space",
  "tiers": [
    {"name": "Low", "resolution": "1080p", "settings": "Low", "fps": 90},
    {"name": "Medium", "resolution": "1080p", "settings": "Medium", "fps": 60},
    {"name": "Ultra", "resolution": "1440p", "settings": "Ultra", "fps": 35}
  ]
}
Estimate FPS realistically based on this exact hardware. Be accurate.`,
      history: [],
      games: [],
      specs: pcSpecs,
      profile: null,
    });

    if (result && result.reply) {
      // Extract JSON from response (handle potential markdown wrapping)
      let jsonStr = result.reply.trim();
      if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const perf = JSON.parse(jsonStr);
      g.perfAnalysis = perf;
      await window.api.saveGames(games);
      if (String(currentGamePageId) === String(id)) renderPerfAnalysis(perfEl, perf);
    } else {
      if (String(currentGamePageId) === String(id)) perfEl.innerHTML = `<span style="color:var(--text-muted)">${result?.error || 'Failed. Try ↻'}</span>`;
    }
  } catch (e) {
    if (String(currentGamePageId) === String(id)) perfEl.innerHTML = '<span style="color:var(--text-muted)">Error analyzing. Try ↻ to retry.</span>';
  }
  if (String(currentGamePageId) === String(id)) {
    perfEl.classList.remove('loading');
    refreshBtn.classList.remove('spinning');
  }
}

// Context Menu Handlers
let ctxGameId = null;

function showContextMenu(x, y, id) {
  ctxGameId = id;
  const menu = document.getElementById('ctx-menu');
  const g = games.find(x => String(x.id) === String(id));
  // Show/hide launch based on whether game has exe
  document.getElementById('ctx-launch').style.display = (g && (g.exePath || g.steamAppId)) ? '' : 'none';
  menu.style.left = Math.min(x, window.innerWidth - 180) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 200) + 'px';
  menu.style.display = '';
}

function hideContextMenu() {
  document.getElementById('ctx-menu').style.display = 'none';
  ctxGameId = null;
}

// Delete
function promptDelete(id) {
  const g = games.find(x => String(x.id) === String(id));
  if (!g) return;
  deleteTargetId = id;
  document.getElementById('confirm-sub').textContent = `"${g.name}" will be removed.`;
  document.getElementById('confirm-overlay').style.display = 'flex';
}

async function confirmDelete() {
  if (deleteTargetId === null) return;
  window.api.trackingStop(deleteTargetId);
  games = games.filter(g => String(g.id) !== String(deleteTargetId));
  deleteTargetId = null;
  document.getElementById('confirm-overlay').style.display = 'none';
  await window.api.saveGames(games);
  render();
}

// Custom Theme
function applyCustomTheme(colors) {
  const bg = colors ? colors.bg : document.getElementById('custom-bg').value;
  const sidebar = colors ? colors.sidebar : document.getElementById('custom-sidebar').value;
  const card = colors ? colors.card : document.getElementById('custom-card').value;
  const accent = colors ? colors.accent : document.getElementById('custom-accent').value;
  const text = colors ? colors.text : document.getElementById('custom-text').value;
  const border = colors && colors.border ? colors.border : (document.getElementById('custom-border') ? document.getElementById('custom-border').value : '#1e2130');
  const glow = colors && colors.glow !== undefined ? colors.glow : (document.getElementById('custom-glow') ? document.getElementById('custom-glow').value : 50);
  const radius = colors && colors.radius !== undefined ? colors.radius : (document.getElementById('custom-radius') ? document.getElementById('custom-radius').value : 14);

  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.setProperty('--bg-base', bg);
  document.documentElement.style.setProperty('--bg-sidebar', hexToRgba(sidebar, 0.65));
  document.documentElement.style.setProperty('--bg-card', card);
  document.documentElement.style.setProperty('--bg-card-hover', lightenHex(card, 10));
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--accent-hover', lightenHex(accent, -15));
  document.documentElement.style.setProperty('--text-primary', text);
  document.documentElement.style.setProperty('--border', hexToRgba(border, 0.5));
  document.documentElement.style.setProperty('--border-hover', border);
  document.documentElement.style.setProperty('--radius-lg', `${radius}px`);

  // We handle glow intensity using a CSS variable but currently the card uses box-shadow directly.
  // We can inject a style tag for the hover shadow to respect the glow intensity.
  let styleTag = document.getElementById('custom-theme-styles');
  if (!styleTag) {
    styleTag = document.createElement('style');
    styleTag.id = 'custom-theme-styles';
    document.head.appendChild(styleTag);
  }
  const glowOpacity = glow / 100;
  styleTag.innerHTML = `
    .game-card:hover { 
      border-color: ${hexToRgba(accent, Math.min(1, glowOpacity + 0.2))} !important;
      box-shadow: 0 20px 40px rgba(0,0,0,0.5), 0 0 30px ${hexToRgba(accent, glowOpacity)} !important; 
    }
  `;

  // Update the custom theme preview swatch
  const preview = document.getElementById('custom-theme-preview');
  if (preview) preview.style.background = `linear-gradient(135deg, ${bg}, ${card}, ${accent})`;
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function lightenHex(hex, amount) {
  let r = parseInt(hex.slice(1, 3), 16) + amount;
  let g = parseInt(hex.slice(3, 5), 16) + amount;
  let b = parseInt(hex.slice(5, 7), 16) + amount;
  r = Math.max(0, Math.min(255, r));
  g = Math.max(0, Math.min(255, g));
  b = Math.max(0, Math.min(255, b));
  return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}

async function openSettings(targetTab = 'general') {
  window.openSettings = openSettings;
  // Switch to requested tab
  document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.settings-pane').forEach(p => p.classList.remove('active'));
  const activeTabBtn = document.querySelector(`.settings-tab[data-tab="${targetTab}"]`) || document.querySelector('.settings-tab[data-tab="general"]');
  const activePane = document.querySelector(`.settings-pane[data-pane="${targetTab}"]`) || document.querySelector('.settings-pane[data-pane="general"]');
  if (activeTabBtn) activeTabBtn.classList.add('active');
  if (activePane) activePane.classList.add('active');

  document.getElementById('settings-sgdb').value = config.sgdbKey || '';
  document.getElementById('settings-overlay-hotkey').value = config.overlayHotkey || 'Shift+Alt+G';
  
  document.getElementById('settings-ai-enabled').checked = !!config.aiEnabled;
  updateAIProviderDisplay();
  const startupOn = await window.api.getStartup();
  document.getElementById('settings-startup').checked = startupOn;

  // Restore theme picker state
  document.querySelectorAll('#theme-picker .theme-card').forEach(c => {
    c.classList.toggle('active', c.dataset.theme === (config.theme || 'default'));
  });
  if (config.theme === 'custom') {
    document.getElementById('custom-theme-builder').style.display = 'block';
    if (config.customTheme) {
      document.getElementById('custom-bg').value = config.customTheme.bg || '#0f1014';
      document.getElementById('custom-bg-hex').value = config.customTheme.bg || '#0f1014';
      document.getElementById('custom-sidebar').value = config.customTheme.sidebar || '#13151a';
      document.getElementById('custom-sidebar-hex').value = config.customTheme.sidebar || '#13151a';
      document.getElementById('custom-card').value = config.customTheme.card || '#1a1d24';
      document.getElementById('custom-card-hex').value = config.customTheme.card || '#1a1d24';
      document.getElementById('custom-accent').value = config.customTheme.accent || '#5865f2';
      document.getElementById('custom-accent-hex').value = config.customTheme.accent || '#5865f2';
      document.getElementById('custom-text').value = config.customTheme.text || '#e8eaf0';
      document.getElementById('custom-text-hex').value = config.customTheme.text || '#e8eaf0';
      document.getElementById('custom-border').value = config.customTheme.border || '#1e2130';
      document.getElementById('custom-border-hex').value = config.customTheme.border || '#1e2130';
      document.getElementById('custom-glow').value = config.customTheme.glow !== undefined ? config.customTheme.glow : 50;
      document.getElementById('glow-value').textContent = document.getElementById('custom-glow').value + '%';
      document.getElementById('custom-radius').value = config.customTheme.radius !== undefined ? config.customTheme.radius : 14;
      document.getElementById('radius-value').textContent = document.getElementById('custom-radius').value + 'px';
    }
  } else {
    document.getElementById('custom-theme-builder').style.display = 'none';
  }

  // Restore grid/layout states
  document.querySelectorAll('#layout-picker .layout-option').forEach(b => {
    b.classList.toggle('active', b.dataset.layout === (config.layout || 'poster'));
  });
  
  const gridCols = config.gridColumns || 8;
  document.getElementById('grid-size-slider').value = gridCols;
  document.getElementById('grid-size-value').textContent = gridCols === 8 ? '8 Columns (Default)' : `${gridCols} Columns`;
  
  document.getElementById('settings-noise').checked = config.noise !== false;
  document.getElementById('settings-animations').checked = config.animations !== false;
  document.getElementById('settings-auto-update').checked = config.autoCheckUpdates !== false;
  
  if (window.api && window.api.getAppVersion) {
    window.api.getAppVersion().then(v => {
      if (v) document.getElementById('settings-app-version').textContent = 'Version ' + v;
    });
  }

  document.getElementById('settings-overlay').style.display = 'flex';
  document.getElementById('hotkey-listener-msg').style.display = 'none';
  isCapturingHotkey = false;
}
function closeSettings() { 
  document.getElementById('settings-overlay').style.display = 'none'; 
  isCapturingHotkey = false;
}
async function saveSettings() {
  config.sgdbKey = document.getElementById('settings-sgdb').value.trim();
  config.overlayHotkey = document.getElementById('settings-overlay-hotkey').value;
  
  const oldAiEnabled = config.aiEnabled;
  config.aiEnabled = document.getElementById('settings-ai-enabled').checked;
  if (config.aiEnabled !== oldAiEnabled) {
    document.getElementById('open-ai-chat').style.display = config.aiEnabled ? 'flex' : 'none';
  }

  // Save custom theme colors if custom is selected
  if (config.theme === 'custom') {
    config.customTheme = {
      bg: document.getElementById('custom-bg').value,
      sidebar: document.getElementById('custom-sidebar').value,
      card: document.getElementById('custom-card').value,
      accent: document.getElementById('custom-accent').value,
      text: document.getElementById('custom-text').value,
      border: document.getElementById('custom-border').value,
      glow: document.getElementById('custom-glow').value,
      radius: document.getElementById('custom-radius').value
    };
  }
  
  const gridColsVal = parseInt(document.getElementById('grid-size-slider').value, 10) || 8;
  config.gridColumns = gridColsVal;
  document.documentElement.style.setProperty('--grid-columns', gridColsVal);
  config.noise = document.getElementById('settings-noise').checked;
  config.animations = document.getElementById('settings-animations').checked;
  config.autoCheckUpdates = document.getElementById('settings-auto-update').checked;
  
  await window.api.saveConfig(config);
  await window.api.setStartup(document.getElementById('settings-startup').checked);
  // Send the new hotkeys to main process to re-register
  window.api.updateOverlayHotkey(config.overlayHotkey);
  closeSettings();
  toast('Settings saved');
}

// AI Settings Logic
function updateAIProviderDisplay() {
  const display = document.getElementById('settings-ai-provider-display');
  if (config.aiProvider) {
    const names = { openai: 'OpenAI', anthropic: 'Anthropic (Claude)', deepseek: 'DeepSeek', google: 'Google (Gemini)', custom: 'Other / Custom Endpoint' };
    display.value = names[config.aiProvider] || config.aiProvider;
  } else {
    display.value = 'Not configured';
  }
}

let tempAIProvider = null;

document.getElementById('settings-ai-enabled').addEventListener('change', (e) => {
  if (e.target.checked && !config.aiProvider) {
    document.getElementById('ai-provider-modal').style.display = 'flex';
  }
});

document.getElementById('ai-change-provider').onclick = (e) => {
  e.preventDefault();
  document.getElementById('ai-provider-modal').style.display = 'flex';
};

document.getElementById('ai-provider-close').onclick = () => {
  document.getElementById('ai-provider-modal').style.display = 'none';
  if (!config.aiProvider) document.getElementById('settings-ai-enabled').checked = false;
};

document.querySelectorAll('.ai-provider-item').forEach(el => {
  el.onclick = () => {
    tempAIProvider = el.getAttribute('data-provider');
    document.getElementById('ai-provider-modal').style.display = 'none';
    
    document.getElementById('ai-key-confirm-msg').style.display = (config.aiProvider && config.aiProvider !== tempAIProvider) ? 'block' : 'none';
    document.getElementById('ai-custom-fields').style.display = (tempAIProvider === 'custom') ? 'flex' : 'none';
    
    const links = {
      openai: 'https://platform.openai.com/api-keys',
      anthropic: 'https://console.anthropic.com/settings/keys',
      deepseek: 'https://platform.deepseek.com/api_keys',
      google: 'https://aistudio.google.com/app/apikey',
      custom: '#'
    };
    const linkEl = document.getElementById('ai-key-link');
    linkEl.href = links[tempAIProvider];
    linkEl.style.display = (tempAIProvider === 'custom') ? 'none' : 'block';
    
    document.getElementById('ai-key-error').style.display = 'none';
    document.getElementById('ai-key-input').value = (config.aiProvider === tempAIProvider) ? config.aiKey : '';
    document.getElementById('ai-custom-endpoint').value = config.aiCustomEndpoint || '';
    document.getElementById('ai-custom-model').value = config.aiCustomModel || '';
    
    document.getElementById('ai-key-modal').style.display = 'flex';
  };
});

document.getElementById('ai-key-cancel').onclick = () => {
  document.getElementById('ai-key-modal').style.display = 'none';
  if (!config.aiProvider) document.getElementById('settings-ai-enabled').checked = false;
};
document.getElementById('ai-key-close').onclick = document.getElementById('ai-key-cancel').onclick;

document.getElementById('ai-key-save').onclick = async () => {
  const key = document.getElementById('ai-key-input').value.trim();
  const endpoint = document.getElementById('ai-custom-endpoint').value.trim();
  const modelName = document.getElementById('ai-custom-model').value.trim();
  
  const errorEl = document.getElementById('ai-key-error');
  
  if (!key && tempAIProvider !== 'custom') { errorEl.textContent = 'API Key is required'; errorEl.style.display = 'block'; return; }
  if (tempAIProvider === 'custom' && !endpoint) { errorEl.textContent = 'Endpoint URL is required'; errorEl.style.display = 'block'; return; }
  
  const saveBtn = document.getElementById('ai-key-save');
  saveBtn.textContent = 'Validating...';
  saveBtn.disabled = true;
  
  const res = await window.api.aiValidateKey({ provider: tempAIProvider, key, endpoint, modelName });
  
  saveBtn.textContent = 'Save & Validate';
  saveBtn.disabled = false;
  
  if (!res.valid) {
    errorEl.textContent = res.error || 'Invalid API Key / Endpoint';
    errorEl.style.display = 'block';
  } else {
    config.aiProvider = tempAIProvider;
    config.aiKey = key;
    config.aiCustomEndpoint = endpoint;
    config.aiCustomModel = modelName;
    config.aiEnabled = true;
    
    document.getElementById('settings-ai-enabled').checked = true;
    updateAIProviderDisplay();
    
    document.getElementById('ai-key-modal').style.display = 'none';
    toast('API Key saved and validated');
    
    // Actually save to disk and update UI
    window.api.saveConfig(config);
    document.getElementById('open-ai-chat').style.display = 'flex';
  }
};

// Hotkey Capture
let isCapturingHotkey = false;

document.getElementById('btn-assign-hotkey').onclick = () => {
  isCapturingHotkey = true;
  document.getElementById('hotkey-listener-msg').style.display = 'block';
  document.getElementById('settings-overlay-hotkey').value = 'Listening...';
};
document.getElementById('btn-reset-hotkey').onclick = () => {
  isCapturingHotkey = false;
  document.getElementById('hotkey-listener-msg').style.display = 'none';
  document.getElementById('settings-overlay-hotkey').value = 'Shift+Alt+G';
};

document.addEventListener('keydown', (e) => {
  // Overlay hotkey detection (works when main window is focused)
  if (!isCapturingHotkey) {
    const modifiers = [];
    if (e.ctrlKey) modifiers.push('Ctrl');
    if (e.shiftKey) modifiers.push('Shift');
    if (e.altKey) modifiers.push('Alt');
    if (e.metaKey) modifiers.push('Super');
    if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
      const pressed = [...modifiers, e.key.toUpperCase()].join('+').toUpperCase();
      const target = (config.overlayHotkey || 'Shift+Alt+G').toUpperCase();
      if (pressed === target) {
        e.preventDefault();
        window.api.toggleOverlay();
        return;
      }
    }
    return;
  }
  
  e.preventDefault();
  
  // Ignore bare modifier keys
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
  
  const modifiers = [];
  if (e.ctrlKey) modifiers.push('Ctrl');
  if (e.shiftKey) modifiers.push('Shift');
  if (e.altKey) modifiers.push('Alt');
  if (e.metaKey) modifiers.push('Super');
  
  let key = e.key.toUpperCase();
  if (key === ' ') key = 'Space';
  
  const hotkey = [...modifiers, key].join('+');
  document.getElementById('settings-overlay-hotkey').value = hotkey;
  
  isCapturingHotkey = false;
  document.getElementById('hotkey-listener-msg').style.display = 'none';
});

// Wishlist
let wishlistSearchTimer = null;

function openWishlist() {
  document.getElementById('wishlist-name').value = '';
  document.getElementById('wishlist-search').value = '';
  document.getElementById('wishlist-cover').value = '';
  document.getElementById('wishlist-results').style.display = 'none';
  document.getElementById('wishlist-spinner').style.display = 'none';
  renderWishlistGames();
  document.getElementById('wishlist-overlay').style.display = 'flex';
  setTimeout(() => document.getElementById('wishlist-search').focus(), 50);
}

function closeWishlist() { document.getElementById('wishlist-overlay').style.display = 'none'; }

// Media Library
window.deleteMediaFile = async (index) => {
  const file = window.currentMedia[index];
  if (!file) return;
  if (confirm('Are you sure you want to delete this media file?')) {
    const success = await window.api.deleteMedia(file.path);
    if (success) openMediaLibrary();
  }
};

window.openMediaFolder = (index) => {
  const file = window.currentMedia[index];
  if (file) window.api.showMediaInFolder(file.path);
};

window.openLightbox = (index, isVideo) => {
  const file = window.currentMedia[index];
  if (!file) return;
  const url = `file://${file.path.replace(/\\/g, '/')}`;
  const overlay = document.getElementById('lightbox-overlay');
  const content = document.getElementById('lightbox-content');
  if (isVideo) {
    content.innerHTML = `<video class="lightbox-anim-content" src="${url}" style="max-width:100%; max-height:100%; border-radius:8px; box-shadow: 0 10px 40px rgba(0,0,0,0.5);" controls autoplay></video>`;
  } else {
    content.innerHTML = `<img class="lightbox-anim-content" src="${url}" style="max-width:100%; max-height:100%; border-radius:8px; box-shadow: 0 10px 40px rgba(0,0,0,0.5);" />`;
  }
  overlay.className = 'lightbox-anim-bg';
  overlay.style.display = 'flex';
};

document.getElementById('lightbox-close').onclick = () => {
  const overlay = document.getElementById('lightbox-overlay');
  overlay.style.display = 'none';
  overlay.className = '';
  document.getElementById('lightbox-content').innerHTML = ''; // stop video
};

async function openMediaLibrary() {
  document.getElementById('media-overlay').style.display = 'flex';
  const grid = document.getElementById('media-grid');
  grid.innerHTML = '<div style="color:var(--text-muted)">Loading media...</div>';
  
  if (window.api.getAllMedia) {
    const allMedia = await window.api.getAllMedia();
    window.currentMedia = allMedia;
    
    if (!allMedia || allMedia.length === 0) {
      grid.innerHTML = '<div style="color:var(--text-muted); grid-column: 1 / -1; text-align: center; padding: 40px 0;">No media captured yet.<br>Press your Overlay Hotkey in-game to start capturing!</div>';
      return;
    }
    
    grid.innerHTML = allMedia.map((f, index) => {
      const isVid = f.name.endsWith('.webm');
      // Encode path securely for src attribute
      const url = `file://${f.path.replace(/\\/g, '/')}`;
      
      const mediaHtml = isVid 
        ? `<video src="${url}" style="width:100%; height:120px; object-fit:cover; border-radius: 8px; background:#000; cursor: pointer;" onclick="window.openLightbox(${index}, true)"></video>`
        : `<img src="${url}" style="width:100%; height:120px; object-fit:cover; border-radius: 8px; cursor: pointer; background:#000;" onclick="window.openLightbox(${index}, false)" />`;
        
      return `
        <div style="background: rgba(255,255,255,0.05); padding: 10px; border-radius: 12px; display: flex; flex-direction: column; gap: 8px;">
          ${mediaHtml}
          <div style="font-size: 11px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${f.name}">${f.name}</div>
          <div style="display: flex; gap: 8px; margin-top: auto;">
            <button onclick="window.openMediaFolder(${index})" style="flex:1; background:rgba(255,255,255,0.1); border:none; padding:4px; border-radius:4px; color:#fff; cursor:pointer; font-size:11px;">📁 Folder</button>
            <button onclick="window.deleteMediaFile(${index})" style="flex:1; background:rgba(255,51,102,0.15); border:none; padding:4px; border-radius:4px; color:#ff3366; cursor:pointer; font-size:11px; display:flex; align-items:center; justify-content:center; gap:4px;">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
              Delete
            </button>
          </div>
        </div>
      `;
    }).join('');
  }
}
function closeMediaLibrary() { document.getElementById('media-overlay').style.display = 'none'; }

// Activity Dashboard
function openActivityDashboard() {
  document.getElementById('activity-overlay').style.display = 'flex';
  renderActivityDashboard();
}
function closeActivityDashboard() { document.getElementById('activity-overlay').style.display = 'none'; }

function renderActivityDashboard() {
  // Gather all sessions across all games
  const allSessions = [];
  games.forEach(g => {
    (g.sessions || []).forEach(s => {
      allSessions.push({ ...s, gameName: g.name, gameId: g.id });
    });
  });
  allSessions.sort((a, b) => b.start - a.start);
  
  const now = Date.now();
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const weekStart = new Date(todayStart); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const monthStart = new Date(todayStart); monthStart.setDate(1);
  
  // Period cards
  const todaySessions = allSessions.filter(s => s.start >= todayStart.getTime());
  const weekSessions = allSessions.filter(s => s.start >= weekStart.getTime());
  const monthSessions = allSessions.filter(s => s.start >= monthStart.getTime());
  
  const sumDur = arr => arr.reduce((a, s) => a + s.duration, 0);
  const avgSession = allSessions.length ? (sumDur(allSessions) * 60) / allSessions.length : 0;
  const longestSession = allSessions.length ? Math.max(...allSessions.map(s => s.duration)) * 60 : 0;
  
  // Daily average: total hours / number of unique days played
  const uniqueDays = new Set(allSessions.map(s => new Date(s.start).toDateString())).size;
  const dailyAvg = uniqueDays ? (sumDur(allSessions) * 60) / uniqueDays : 0;
  
  document.getElementById('activity-periods').innerHTML = `
    <div class="act-period-card">
      <div class="act-period-val">${formatDurationLong(sumDur(todaySessions) * 60)}</div>
      <div class="act-period-sub">${todaySessions.length} session${todaySessions.length !== 1 ? 's' : ''}</div>
      <div class="act-period-label">Today</div>
    </div>
    <div class="act-period-card">
      <div class="act-period-val">${formatDurationLong(sumDur(weekSessions) * 60)}</div>
      <div class="act-period-sub">${weekSessions.length} session${weekSessions.length !== 1 ? 's' : ''}</div>
      <div class="act-period-label">This Week</div>
    </div>
    <div class="act-period-card">
      <div class="act-period-val">${formatDurationLong(sumDur(monthSessions) * 60)}</div>
      <div class="act-period-sub">${monthSessions.length} session${monthSessions.length !== 1 ? 's' : ''}</div>
      <div class="act-period-label">This Month</div>
    </div>
    <div class="act-period-card">
      <div class="act-period-val">${formatDurationLong(sumDur(allSessions) * 60)}</div>
      <div class="act-period-sub">${allSessions.length} session${allSessions.length !== 1 ? 's' : ''}</div>
      <div class="act-period-label">All Time</div>
    </div>
    <div class="act-period-card">
      <div class="act-period-val">${formatDurationLong(avgSession)}</div>
      <div class="act-period-sub">${formatDurationLong(dailyAvg)}/day</div>
      <div class="act-period-label">Avg Session</div>
    </div>
    <div class="act-period-card">
      <div class="act-period-val">${formatDurationLong(longestSession)}</div>
      <div class="act-period-sub">${uniqueDays} day${uniqueDays !== 1 ? 's' : ''} played</div>
      <div class="act-period-label">Longest</div>
    </div>`;
  
  // Weekly heatmap (Mon-Sun)
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weeklyEl = document.getElementById('activity-weekly');
  const weekDays = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    const dayStart = d.getTime();
    const dayEnd = dayStart + 86400000;
    const dayHrs = allSessions.filter(s => s.start >= dayStart && s.start < dayEnd).reduce((a, s) => a + s.duration, 0);
    weekDays.push({ name: dayNames[d.getDay()], hours: dayHrs, isToday: d.toDateString() === new Date().toDateString() });
  }
  const maxWeekDay = Math.max(...weekDays.map(d => d.hours), 0.1);
  
  weeklyEl.innerHTML = weekDays.map(d => {
    const pct = Math.max((d.hours / maxWeekDay) * 100, d.hours > 0 ? 6 : 0);
    const durText = d.hours > 0 ? formatDurationLong(d.hours * 60) : '—';
    return `
      <div class="act-week-row ${d.isToday ? 'act-today' : ''}">
        <span class="act-week-day">${d.name}</span>
        <div class="act-week-bar-wrap"><div class="act-week-bar" style="width:${pct}%"></div></div>
        <span class="act-week-dur">${durText}</span>
      </div>`;
  }).join('');
  
  // Most played leaderboard
  const topEl = document.getElementById('activity-top');
  const gameHours = {};
  allSessions.forEach(s => {
    gameHours[s.gameName] = (gameHours[s.gameName] || 0) + s.duration;
  });
  const sorted = Object.entries(gameHours).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxHrs = sorted.length ? sorted[0][1] : 1;
  
  if (sorted.length === 0) {
    topEl.innerHTML = '<div style="color:var(--text-muted);padding:12px;">No sessions recorded yet.</div>';
  } else {
    topEl.innerHTML = sorted.map(([name, hrs], i) => {
      const pct = (hrs / maxHrs) * 100;
      return `
        <div class="act-top-row">
          <span class="act-top-rank">${i + 1}</span>
          <span class="act-top-name">${esc(name)}</span>
          <div class="act-top-bar-wrap"><div class="act-top-bar" style="width:${pct}%"></div></div>
          <span class="act-top-hrs">${formatDurationLong(hrs * 60)}</span>
        </div>`;
    }).join('');
  }
  
  // Recent sessions
  const recentEl = document.getElementById('activity-recent');
  const recent = allSessions.slice(0, 15);
  if (recent.length === 0) {
    recentEl.innerHTML = '<div style="color:var(--text-muted);padding:12px;">No sessions recorded yet. Launch a game to start tracking!</div>';
  } else {
    recentEl.innerHTML = recent.map(s => {
      const d = new Date(s.start);
      const dateStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      return `
        <div class="act-recent-row">
          <div class="act-recent-game">${esc(s.gameName)}</div>
          <div class="act-recent-date">${dateStr} · ${timeStr}</div>
          <div class="act-recent-dur">${formatDurationLong(s.duration * 60)}</div>
        </div>`;
    }).join('');
  }
}

function renderWishlistGames() {
  const wishlist = games.filter(g => g.status === 'Want');
  const label = document.getElementById('wishlist-count-label');
  label.textContent = wishlist.length ? `${wishlist.length} game${wishlist.length > 1 ? 's' : ''}` : '';

  const list = document.getElementById('wishlist-game-list');
  if (!wishlist.length) {
    list.innerHTML = `<div class="wishlist-empty">Nothing here yet — search above to add games</div>`;
    return;
  }
  list.innerHTML = wishlist.map(g => `
    <div class="wishlist-card" data-id="${g.id}">
      ${g.coverUrl
        ? `<img class="wishlist-card-cover" src="${esc(g.coverUrl)}" loading="lazy" onerror="this.outerHTML='<div class=\\'wishlist-card-placeholder\\'>🎮</div>'" />`
        : `<div class="wishlist-card-placeholder">🎮</div>`}
      <div class="wishlist-card-body">
        <div class="wishlist-card-name">${esc(g.name)}</div>
      </div>
      <button class="wishlist-card-del" data-id="${g.id}" title="Remove">✕</button>
    </div>`).join('');

  list.querySelectorAll('.wishlist-card').forEach(card => {
    card.addEventListener('click', e => {
      if (!e.target.closest('.wishlist-card-del')) openEdit(card.dataset.id);
    });
  });
  list.querySelectorAll('.wishlist-card-del').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); removeFromWishlist(btn.dataset.id); });
  });
}

async function removeFromWishlist(id) {
  games = games.filter(g => String(g.id) !== String(id));
  await window.api.saveGames(games);
  renderWishlistGames();
  render();
}

function onWishlistSearch() {
  clearTimeout(wishlistSearchTimer);
  const q = document.getElementById('wishlist-search').value.trim();
  const results = document.getElementById('wishlist-results');
  const spinner = document.getElementById('wishlist-spinner');
  if (!q) { results.style.display = 'none'; spinner.style.display = 'none'; return; }
  if (!config.sgdbKey) {
    results.innerHTML = `<div class="sgdb-no-key">SteamGridDB key required for search.<br><button onclick="window.openSettings('integrations')" style="margin-top:8px;background:var(--accent);color:#fff;border:none;padding:5px 12px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;">Add API Key in Settings ↗</button></div>`;
    results.style.display = 'block'; return;
  }
  spinner.style.display = 'block';
  wishlistSearchTimer = setTimeout(async () => {
    try {
      const data = await window.api.sgdbSearch(q);
      spinner.style.display = 'none';
      if (!data || !data.length) {
        results.innerHTML = `<div class="sgdb-no-key">No results</div>`;
        results.style.display = 'block'; return;
      }
      results.innerHTML = data.map(r => `
        <div class="sgdb-item" data-name="${esc(r.name)}" data-cover="${esc(r.coverUrl||'')}">
          ${r.coverUrl ? `<img class="sgdb-item-cover" src="${esc(r.coverUrl)}" loading="lazy" />` : `<div class="sgdb-item-cover"></div>`}
          <span class="sgdb-item-name">${esc(r.name)}</span>
        </div>`).join('');
      results.querySelectorAll('.sgdb-item').forEach(item => {
        item.onclick = () => {
          document.getElementById('wishlist-name').value = item.dataset.name;
          document.getElementById('wishlist-cover').value = item.dataset.cover;
          document.getElementById('wishlist-search').value = '';
          results.style.display = 'none';
        };
      });
      results.style.display = 'block';
    } catch (e) {
      spinner.style.display = 'none';
      results.innerHTML = `<div class="sgdb-no-key">Search failed</div>`;
      results.style.display = 'block';
    }
  }, 400);
}

async function saveWishlist() {
  const name = document.getElementById('wishlist-name').value.trim();
  if (!name) { document.getElementById('wishlist-name').classList.add('error'); document.getElementById('wishlist-name').focus(); return; }
  const cover = document.getElementById('wishlist-cover').value || '';
  // Check if already in wishlist
  if (games.some(g => g.status === 'Want' && g.name.toLowerCase() === name.toLowerCase())) {
    toast(`"${name}" is already in your wishlist`); return;
  }
  games.push({ id: Date.now(), name, status: 'Want', hours: 0, source: '', exePath: '', notes: '', coverUrl: cover, added: Date.now() });
  await window.api.saveGames(games);
  document.getElementById('wishlist-name').value = '';
  document.getElementById('wishlist-cover').value = '';
  renderWishlistGames();
  render();
  toast(`Added "${name}" to wishlist`);
}

// Utilities
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

let toastTimer;
function toast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.display = 'block';
  el.classList.remove('toast-error');
  if (type === 'error') {
    el.classList.add('toast-error');
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; el.classList.remove('toast-error'); }, type === 'error' ? 5000 : 3000);
}

// AI Game Advisor
async function openAIChat() {
  const panel = document.getElementById('ai-panel');
  // Toggle if already open
  if (panel.classList.contains('open')) { panel.classList.remove('open'); return; }
  panel.classList.add('open');

  // Load profile if not loaded
  if (!aiProfile) {
    aiProfile = await window.api.aiLoadProfile();
  }

  // Detect specs if not done
  if (!pcSpecs) {
    document.getElementById('ai-specs-badge').textContent = 'Detecting specs...';
    pcSpecs = await window.api.aiDetectSpecs();
    aiProfile.pcSpecs = pcSpecs;
    await window.api.aiSaveProfile(aiProfile);
  }

  // Update specs badge + tooltip
  if (pcSpecs && pcSpecs.gpu !== 'Unknown') {
    const shortGpu = pcSpecs.gpu.replace('NVIDIA ', '').replace('GeForce ', '').replace('AMD ', '');
    document.getElementById('ai-specs-badge').textContent = `${shortGpu} · ${pcSpecs.ram} RAM`;

    // Build tooltip with all specs
    const tooltip = document.getElementById('ai-specs-tooltip');
    let tooltipHtml = '<div class="spec-title">⚙ Your PC Specs</div>';
    tooltipHtml += `<div class="spec-row"><span class="spec-label">CPU</span><span class="spec-value">${esc(pcSpecs.cpu)}</span></div>`;
    if (pcSpecs.allGpus && pcSpecs.allGpus.length > 0) {
      pcSpecs.allGpus.forEach((g, i) => {
        const label = pcSpecs.allGpus.length > 1 ? `GPU ${i + 1}` : 'GPU';
        tooltipHtml += `<div class="spec-row"><span class="spec-label">${label}</span><span class="spec-value">${esc(g.name)}<br><span style="color:var(--text-muted)">${esc(g.vram)} VRAM</span></span></div>`;
      });
    } else {
      tooltipHtml += `<div class="spec-row"><span class="spec-label">GPU</span><span class="spec-value">${esc(pcSpecs.gpu)}<br><span style="color:var(--text-muted)">${esc(pcSpecs.vram)} VRAM</span></span></div>`;
    }
    tooltipHtml += `<div class="spec-row"><span class="spec-label">RAM</span><span class="spec-value">${esc(pcSpecs.ram)}</span></div>`;
    tooltipHtml += `<div class="spec-row"><span class="spec-label">OS</span><span class="spec-value">${esc(pcSpecs.os)}</span></div>`;
    tooltip.innerHTML = tooltipHtml;
  } else {
    document.getElementById('ai-specs-badge').textContent = 'Specs unknown';
  }

  // Restore chat history
  if (aiProfile.chatHistory && aiProfile.chatHistory.length > 0) {
    renderAIChatHistory();
  }

  setTimeout(() => document.getElementById('ai-input').focus(), 300);
}

function closeAIChat() {
  document.getElementById('ai-panel').classList.remove('open');
}

async function clearAIChatHistory() {
  if (!aiProfile || !aiProfile.chatHistory || aiProfile.chatHistory.length === 0) return;
  if (confirm('Are you sure you want to clear your AI chat history?')) {
    aiProfile.chatHistory = [];
    await window.api.aiSaveProfile(aiProfile);
    document.getElementById('ai-messages').innerHTML = `
      <div class="ai-welcome">
        <div class="ai-welcome-icon">✦</div>
        <div class="ai-welcome-title">History Cleared</div>
        <div class="ai-welcome-sub">How can I help you today?</div>
      </div>
    `;
    toast('Chat history cleared');
  }
}

function renderAIChatHistory() {
  const container = document.getElementById('ai-messages');
  container.innerHTML = '';

  if (!config.aiKey) {
    container.innerHTML = `
      <div class="ai-setup-card" style="background:linear-gradient(135deg,rgba(88,101,242,0.12),rgba(168,85,247,0.08));border:1px solid rgba(88,101,242,0.25);border-radius:var(--radius-md);padding:20px 16px;margin:16px;text-align:center;">
        <div style="font-size:28px;margin-bottom:8px;">✦</div>
        <div style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:15px;color:var(--text-primary);margin-bottom:4px;">Set Up Your AI Key</div>
        <div style="font-size:12px;color:var(--text-secondary);line-height:1.45;margin-bottom:14px;">Connect OpenAI, Claude, Gemini, or DeepSeek in Settings to enable recommendations and FPS analysis.</div>
        <button onclick="window.openSettings('integrations')" style="background:linear-gradient(135deg,var(--accent),#7c8aff);color:#fff;border:none;padding:8px 16px;border-radius:var(--radius-sm);font-family:'Inter',sans-serif;font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(88,101,242,0.3);transition:transform .15s;">Configure in Settings ↗</button>
      </div>`;
    return;
  }

  if (aiProfile.chatHistory && aiProfile.chatHistory.length > 0) {
    aiProfile.chatHistory.forEach(msg => {
      appendAIMessage(msg.role, msg.text, false);
    });
  } else {
    container.innerHTML = `
      <div class="ai-welcome">
        <div class="ai-welcome-icon">✦</div>
        <div class="ai-welcome-title">Hey, gamer!</div>
        <div class="ai-welcome-sub">I know your PC specs and your library. Ask me for personalized game recommendations with FPS estimates!</div>
      </div>`;
  }

  scrollAIToBottom();
}

function appendAIMessage(role, text, animate = true, typewriter = false) {
  const container = document.getElementById('ai-messages');

  // Remove welcome screen on first message
  const welcome = container.querySelector('.ai-welcome');
  if (welcome) welcome.remove();

  const div = document.createElement('div');
  div.className = `ai-msg ${role}`;

  if (role === 'ai' && typewriter) {
    // Typewriter: start with just the label, then stream words in
    div.innerHTML = `<div class="ai-msg-label">✦ GameVault AI</div><span class="ai-msg-text"></span>`;
    container.appendChild(div);
    scrollAIToBottom();
    typewriterEffect(div.querySelector('.ai-msg-text'), text);
    return div;
  } else if (role === 'ai') {
    const formatted = formatAIText(text);
    div.innerHTML = `<div class="ai-msg-label">✦ GameVault AI</div>${formatted}`;
  } else if (role === 'error') {
    div.textContent = text;
  } else {
    div.textContent = text;
  }

  if (!animate) div.style.animation = 'none';
  container.appendChild(div);
  scrollAIToBottom();
  return div;
}

function typewriterEffect(el, text) {
  const formatted = formatAIText(text);
  // Split into small chunks (by HTML tags and words)
  // We'll reveal word-by-word but preserve HTML tags
  const words = [];
  let current = '';
  let inTag = false;
  for (let i = 0; i < formatted.length; i++) {
    const ch = formatted[i];
    if (ch === '<') { inTag = true; current += ch; continue; }
    if (ch === '>') { inTag = false; current += ch; continue; }
    if (inTag) { current += ch; continue; }
    current += ch;
    if (ch === ' ' || ch === '\n') {
      words.push(current);
      current = '';
    }
  }
  if (current) words.push(current);

  let idx = 0;
  let revealed = '';
  const interval = setInterval(() => {
    if (idx >= words.length) {
      clearInterval(interval);
      return;
    }
    // Reveal 2 words at a time for natural speed
    const chunk = words.slice(idx, idx + 2).join('');
    revealed += chunk;
    el.innerHTML = revealed;
    idx += 2;
    scrollAIToBottom();
  }, 30);
}

function formatAIText(text) {
  // Convert **bold** to <strong>
  let html = esc(text);
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Convert *italic* to <em>
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Convert newlines to <br>
  html = html.replace(/\n/g, '<br>');
  // Highlight FPS estimates
  html = html.replace(/(⚡[^<]*(?:FPS|fps)[^<]*)/g, '<span style="color:#a855f7;font-weight:600">$1</span>');
  return html;
}

function showTypingIndicator() {
  const container = document.getElementById('ai-messages');
  const typing = document.createElement('div');
  typing.className = 'ai-typing';
  typing.id = 'ai-typing-indicator';
  typing.innerHTML = '<span class="ai-typing-dot"></span><span class="ai-typing-dot"></span><span class="ai-typing-dot"></span>';
  container.appendChild(typing);
  scrollAIToBottom();
}

function removeTypingIndicator() {
  const el = document.getElementById('ai-typing-indicator');
  if (el) el.remove();
}

function scrollAIToBottom() {
  const container = document.getElementById('ai-messages');
  setTimeout(() => { container.scrollTop = container.scrollHeight; }, 50);
}

async function sendAIMessage() {
  if (aiSending) return;
  const input = document.getElementById('ai-input');
  const message = input.value.trim();
  if (!message) return;

  if (!config.aiKey) {
    toast('Add your AI Provider API key in Settings > Integrations first', 'error');
    openSettings('integrations');
    return;
  }

  input.value = '';
  aiSending = true;
  document.getElementById('ai-send').disabled = true;

  // Add user message
  appendAIMessage('user', message);
  if (!aiProfile) aiProfile = { preferences: { likedGenres: [], dislikedGenres: [], dislikedGames: [], recommendedBefore: [] }, chatHistory: [], pcSpecs: null };
  aiProfile.chatHistory.push({ role: 'user', text: message, ts: Date.now() });

  // Show typing indicator
  showTypingIndicator();

  try {
    const result = await window.api.aiChat({
      message,
      history: aiProfile.chatHistory.slice(-20), // Last 20 messages for context
      specs: pcSpecs,
      games,
      profile: aiProfile,
    });

    removeTypingIndicator();

    if (result.error) {
      appendAIMessage('error', result.error);
    } else {
      const replyStr = result.reply || '(No response)';
      appendAIMessage('ai', replyStr, true, true); // typewriter = true
      aiProfile.chatHistory.push({ role: 'ai', text: replyStr, ts: Date.now() });

      // Learn preferences from the conversation
      learnFromConversation(message, replyStr);
    }

    // Save profile (keep last 50 messages to avoid huge files)
    if (aiProfile.chatHistory.length > 50) {
      aiProfile.chatHistory = aiProfile.chatHistory.slice(-50);
    }
    await window.api.aiSaveProfile(aiProfile);

  } catch (e) {
    removeTypingIndicator();
    appendAIMessage('error', 'Failed to connect to AI. Check your internet and API key.');
  }

  aiSending = false;
  document.getElementById('ai-send').disabled = false;
  document.getElementById('ai-input').focus();
}

function learnFromConversation(userMsg, aiResponse) {
  if (!aiProfile.preferences) {
    aiProfile.preferences = { likedGenres: [], dislikedGenres: [], dislikedGames: [], recommendedBefore: [] };
  }
  const prefs = aiProfile.preferences;
  const msgLower = userMsg.toLowerCase();

  // Detect genre dislikes
  const dislikePatterns = /(?:hate|don'?t like|dislike|not into|can'?t stand|bored of|tired of)\s+(.+?)(?:\.|$|,|!)/i;
  const dislikeMatch = msgLower.match(dislikePatterns);
  if (dislikeMatch) {
    const genre = dislikeMatch[1].trim();
    if (!prefs.dislikedGenres.includes(genre)) {
      prefs.dislikedGenres.push(genre);
    }
  }

  // Detect genre likes
  const likePatterns = /(?:love|really like|enjoy|into|fan of|addicted to|obsessed with)\s+(.+?)(?:\.|$|,|!)/i;
  const likeMatch = msgLower.match(likePatterns);
  if (likeMatch) {
    const genre = likeMatch[1].trim();
    if (!prefs.likedGenres.includes(genre)) {
      prefs.likedGenres.push(genre);
    }
  }

  // Track recommended games from AI response to avoid repeats
  // Look for game names that appear with bold formatting or in a recommendation context
  const boldMatches = aiResponse.match(/\*\*(.+?)\*\*/g);
  if (boldMatches) {
    boldMatches.forEach(m => {
      const name = m.replace(/\*\*/g, '').trim();
      // Only add if it looks like a game name (not too long, not a generic phrase)
      if (name.length > 2 && name.length < 60 && !prefs.recommendedBefore.includes(name)) {
        prefs.recommendedBefore.push(name);
      }
    });
  }

  // Keep recommendedBefore list manageable
  if (prefs.recommendedBefore.length > 100) {
    prefs.recommendedBefore = prefs.recommendedBefore.slice(-100);
  }
}

// In-App Updater System
let currentAvailableUpdate = null;
let isManualUpdateCheck = false;

function initAppUpdater() {
  if (!window.api || !window.api.onUpdateAvailable) return;

  const updateModal = document.getElementById('update-modal');
  const checkBtn = document.getElementById('settings-btn-check-update');
  const spinner = document.getElementById('update-check-spinner');
  const btnText = document.getElementById('update-check-btn-text');
  const statusEl = document.getElementById('settings-update-status');

  // GitHub repo external links
  const repoLink = document.getElementById('link-github-repo');
  if (repoLink) repoLink.onclick = (e) => { e.preventDefault(); window.api.openExternal('https://github.com/itzSornet/Gamevault'); };

  const relLink = document.getElementById('link-github-releases');
  if (relLink) relLink.onclick = (e) => { e.preventDefault(); window.api.openExternal('https://github.com/itzSornet/Gamevault/releases'); };

  // Check for updates button in Settings
  if (checkBtn) {
    checkBtn.onclick = () => {
      isManualUpdateCheck = true;
      spinner.style.display = 'inline-block';
      btnText.textContent = 'Checking...';
      statusEl.textContent = 'Contacting GitHub releases...';
      window.api.checkForUpdates(true);
    };
  }

  // Update Modal Actions
  document.getElementById('update-modal-close').onclick = () => {
    updateModal.style.display = 'none';
  };

  document.getElementById('update-later-btn').onclick = async () => {
    if (currentAvailableUpdate) {
      await window.api.snoozeUpdate(currentAvailableUpdate.version, 24);
    }
    updateModal.style.display = 'none';
    toast('Update reminder snoozed for 24 hours');
  };

  document.getElementById('update-skip-btn').onclick = async () => {
    if (currentAvailableUpdate) {
      await window.api.skipUpdate(currentAvailableUpdate.version);
    }
    updateModal.style.display = 'none';
    toast(`Version ${currentAvailableUpdate?.version || ''} will be skipped`);
  };

  document.getElementById('update-now-btn').onclick = () => {
    document.getElementById('update-now-btn').disabled = true;
    document.getElementById('update-now-btn').textContent = 'Starting download...';
    document.getElementById('update-progress-wrap').style.display = 'flex';
    window.api.downloadUpdate();
  };

  document.getElementById('update-restart-btn').onclick = () => {
    window.api.installUpdate();
  };

  document.getElementById('update-install-later-btn').onclick = () => {
    updateModal.style.display = 'none';
    toast('Update will install automatically when GameVault is closed');
  };

  // IPC Event Listeners
  window.api.onUpdateChecking(() => {
    if (spinner) spinner.style.display = 'inline-block';
    if (btnText) btnText.textContent = 'Checking...';
    if (statusEl) statusEl.textContent = 'Checking for new releases...';
  });

  window.api.onUpdateAvailable((info) => {
    currentAvailableUpdate = info;
    if (spinner) spinner.style.display = 'none';
    if (btnText) btnText.textContent = 'Check Now';
    if (statusEl) statusEl.innerHTML = `<span style="color:#10b981;font-weight:600;">Update v${esc(info.version)} available!</span>`;

    // Populate and open update modal
    document.getElementById('update-modal-title').textContent = info.releaseName || `GameVault v${info.version}`;
    document.getElementById('update-current-ver').textContent = info.currentVersion ? `v${info.currentVersion}` : 'v1.0.0';
    document.getElementById('update-new-ver').textContent = `v${info.version}`;
    
    if (info.releaseDate) {
      try {
        const d = new Date(info.releaseDate);
        document.getElementById('update-rel-date').textContent = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      } catch (e) {
        document.getElementById('update-rel-date').textContent = '';
      }
    } else {
      document.getElementById('update-rel-date').textContent = '';
    }

    // Format Release Notes (simple markdown clean up)
    const notesEl = document.getElementById('update-notes-content');
    if (info.releaseNotes && info.releaseNotes.trim()) {
      let notesHtml = esc(info.releaseNotes)
        .replace(/^### (.*$)/gim, '<strong style="display:block;margin-top:6px;color:#fff;">$1</strong>')
        .replace(/^## (.*$)/gim, '<strong style="display:block;margin-top:8px;color:#fff;">$1</strong>')
        .replace(/^# (.*$)/gim, '<strong style="display:block;margin-top:10px;color:#fff;">$1</strong>')
        .replace(/^\* (.*$)/gim, '• $1')
        .replace(/^- (.*$)/gim, '• $1');
      notesEl.innerHTML = notesHtml;
    } else {
      notesEl.innerHTML = '<span style="color:var(--text-muted)">Performance enhancements, bug fixes, and general improvements.</span>';
    }

    // Reset view states
    document.getElementById('update-progress-wrap').style.display = 'none';
    document.getElementById('update-ready-wrap').style.display = 'none';
    document.getElementById('update-actions-default').style.display = 'flex';
    document.getElementById('update-actions-ready').style.display = 'none';
    document.getElementById('update-now-btn').disabled = false;
    document.getElementById('update-now-btn').textContent = 'Update Now ⬇';

    updateModal.style.display = 'flex';
  });

  window.api.onUpdateNotAvailable((info) => {
    if (spinner) spinner.style.display = 'none';
    if (btnText) btnText.textContent = 'Check Now';
    if (statusEl) statusEl.textContent = `You are on the latest version (v${info.version || '1.0.0'}).`;
    if (isManualUpdateCheck) {
      toast('You are already using the latest version of GameVault');
      isManualUpdateCheck = false;
    }
  });

  window.api.onUpdateProgress((prog) => {
    document.getElementById('update-progress-wrap').style.display = 'flex';
    document.getElementById('update-progress-percent').textContent = `${prog.percent}%`;
    document.getElementById('update-progress-bar-fill').style.width = `${prog.percent}%`;
    
    const speedMB = (prog.bytesPerSecond / (1024 * 1024)).toFixed(1);
    document.getElementById('update-progress-speed').textContent = `${speedMB} MB/s`;

    const transferredMB = (prog.transferred / (1024 * 1024)).toFixed(1);
    const totalMB = (prog.total / (1024 * 1024)).toFixed(1);
    document.getElementById('update-progress-size').textContent = `${transferredMB} MB / ${totalMB} MB`;
  });

  window.api.onUpdateDownloaded((info) => {
    document.getElementById('update-progress-wrap').style.display = 'none';
    document.getElementById('update-ready-wrap').style.display = 'flex';
    document.getElementById('update-actions-default').style.display = 'none';
    document.getElementById('update-actions-ready').style.display = 'flex';
    toast('Update downloaded! Ready to install.');
  });

  window.api.onUpdateError((err) => {
    if (spinner) spinner.style.display = 'none';
    if (btnText) btnText.textContent = 'Check Now';
    if (statusEl) statusEl.textContent = 'Update check failed. Check internet connection.';
    if (isManualUpdateCheck) {
      toast(err.message || 'Failed to check for updates', 'error');
      isManualUpdateCheck = false;
    }
  });

  // Automatic check on boot after 3 seconds
  if (config.autoCheckUpdates !== false) {
    setTimeout(() => {
      window.api.checkForUpdates(false);
    }, 3000);
  }
}

// Application Entrypoint
boot();
