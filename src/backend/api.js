const https = require('https');
const { loadConfig } = require('./data.js');

// SteamGridDB API client
function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const opts = { headers: { ...headers, 'User-Agent': 'GameVault/1.0' } };
    https.get(url, opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON')); }
      });
    }).on('error', reject);
  });
}

async function searchSteamGridDB(query, apiKey) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  const searchData = await httpsGet(
    `https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(query)}`,
    headers
  );
  if (!searchData.success || !searchData.data || !searchData.data.length) return [];

  const top = searchData.data.slice(0, 8);
  const results = await Promise.all(top.map(async game => {
    try {
      const gridData = await httpsGet(
        `https://www.steamgriddb.com/api/v2/grids/game/${game.id}?dimensions=600x900&limit=1`,
        headers
      );
      const coverUrl = gridData.success && gridData.data && gridData.data.length
        ? gridData.data[0].url : '';
      return { name: game.name, releaseDate: game.release_date, coverUrl };
    } catch (e) {
      return { name: game.name, releaseDate: game.release_date, coverUrl: '' };
    }
  }));
  return results;
}


module.exports = { httpsGet, searchSteamGridDB };
