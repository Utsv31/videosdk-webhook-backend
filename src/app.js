const express = require('express');
const webhookRouter = require('./routes/webhook');
const jobsRouter = require('./routes/jobs');
const logger = require('./utils/logger');

const app = express();

app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  },
}));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

app.use('/webhook', webhookRouter);
app.use('/jobs', jobsRouter);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
  });
});

app.use((err, req, res, next) => {
  logger.error('Unhandled Express error', {
    message: err.message,
    stack: err.stack,
  });

  if (res.headersSent) {
    return next(err);
  }

  return res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
});

module.exports = app;
