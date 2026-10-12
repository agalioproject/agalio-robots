process.env.HELIUS_API_KEY = process.env.HELIUS_API_KEY || 'test';
process.env.DRY_RUN = 'true';
process.env.LEARNING_FILE = require('path').join(require('os').tmpdir(), `learn-${process.pid}.json`);
