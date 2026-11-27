const https = require('https');

// GET a URL and parse the reply as JSON (Steam store lookups).
function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
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

module.exports = { httpsGet };
