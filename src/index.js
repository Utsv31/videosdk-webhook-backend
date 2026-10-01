require('dotenv').config();

const app = require('./app');
const { startRetryWorker } = require('./workers/retryWorker');
const { startOutboundCallWorker } = require('./workers/outboundCallWorker');
const logger = require('./utils/logger');

const port = process.env.PORT || 3000;

app.listen(port, () => {
  logger.info('VideoSDK webhook backend started', {
    port,
    nodeEnv: process.env.NODE_ENV || 'development',
  });

  startRetryWorker();
  startOutboundCallWorker();
});
