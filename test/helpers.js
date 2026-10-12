const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DRY_RUN = 'true';
process.env.STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agalio-test-'));
process.env.TELEGRAM_BOT_TOKEN = 't';
process.env.TELEGRAM_CHAT_ID = '42';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_KEY = '';

/** A DexScreener-shaped market for a SOL-quoted pair; override anything. */
function mkt(over = {}) {
  return {
    priceNative: 0.00001, ageSec: 12 * 86400, liquidityUsd: 40000, volume1h: 9000, volume6h: 30000,
    priceChange5m: 2, priceChange1h: 5, priceChange6h: 8, priceChange24h: 10, buys1h: 30, sells1h: 20, marketCapUsd: 1e6, ...over,
  };
}
module.exports = { mkt };
