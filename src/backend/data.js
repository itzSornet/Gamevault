const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const DATA_PATH = path.join(app.getPath('userData'), 'games.json');
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const AI_PROFILE_PATH = path.join(app.getPath('userData'), 'ai-profile.json');

// Storage and persistence
function loadGames() {
  try { if (fs.existsSync(DATA_PATH)) return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8')); }
  catch (e) {}
  return [];
}
function saveGames(games) {
  const tmpPath = DATA_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(games, null, 2), 'utf-8');
  fs.renameSync(tmpPath, DATA_PATH);
}

async function cacheImage(url, prefix) {
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) return url;
  
  const cacheDir = path.join(path.dirname(DATA_PATH), 'artworks_cache');
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  
  let ext = '.jpg';
  try { ext = path.extname(new URL(url).pathname) || '.jpg'; } catch(e){}
  const filename = `${prefix}_${crypto.createHash('md5').update(url).digest('hex')}${ext}`;
  const filePath = path.join(cacheDir, filename);
  
  if (fs.existsSync(filePath)) return `file://${filePath.replace(/\\/g, '/')}`;
  
  try {
    const buffer = await new Promise((resolve, reject) => {
      const proto = url.startsWith('https') ? require('https') : require('http');
      proto.get(url, { headers: { 'User-Agent': 'GameVault/1.0' } }, res => {
        if (res.statusCode !== 200) return reject(new Error(`Status: ${res.statusCode}`));
        const data = [];
        res.on('data', chunk => data.push(chunk));
        res.on('end', () => resolve(Buffer.concat(data)));
      }).on('error', reject);
    });
    fs.writeFileSync(filePath, buffer);
    return `file://${filePath.replace(/\\/g, '/')}`;
  } catch (e) {
    console.warn('Failed to cache image:', url, e.message);
    return url;
  }
}

async function cacheGameImages(games) {
  for (const g of games) {
    if (g.coverUrl && (g.coverUrl.startsWith('http://') || g.coverUrl.startsWith('https://'))) {
      g.coverUrl = await cacheImage(g.coverUrl, `cover_${g.id}`);
    }
    if (g.heroUrl && (g.heroUrl.startsWith('http://') || g.heroUrl.startsWith('https://'))) {
      g.heroUrl = await cacheImage(g.heroUrl, `hero_${g.id}`);
    }
  }
}

function loadConfig() {
  const defaults = { 
    sgdbKey: '', 
    deepseekKey: '', 
    overlayHotkey: 'Shift+Alt+G',
    aiEnabled: false,
    aiProvider: null,
    aiKey: '',
    aiCustomEndpoint: '',
    aiCustomModel: ''
  };
  try { 
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      return { ...defaults, ...cfg };
    }
  } catch (e) {}
  return defaults;
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

function aiLoadProfile() {
  try { if (fs.existsSync(AI_PROFILE_PATH)) return JSON.parse(fs.readFileSync(AI_PROFILE_PATH, 'utf-8')); }
  catch (e) {}
  return { preferences: { likedGenres: [], dislikedGenres: [], dislikedGames: [], recommendedBefore: [] }, chatHistory: [], pcSpecs: null };
}

function aiSaveProfile(profile, win, overlayWin) {
  fs.writeFileSync(AI_PROFILE_PATH, JSON.stringify(profile, null, 2), 'utf-8');
  if (win) win.webContents.send('ai:profile-updated', profile);
  if (overlayWin) overlayWin.webContents.send('ai:profile-updated', profile);
}

module.exports = { DATA_PATH, CONFIG_PATH, AI_PROFILE_PATH, loadGames, saveGames, cacheImage, cacheGameImages, loadConfig, saveConfig, aiLoadProfile, aiSaveProfile };
