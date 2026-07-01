const fs = require('fs');
const path = require('path');

const logDir = path.join(process.cwd(), 'logs');
const logFile = path.join(logDir, 'app.log');

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({
      serializationError: error.message,
    });
  }
}

function write(level, message, meta = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  };

  const line = safeJson(entry);

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }

  fs.mkdir(logDir, { recursive: true }, (mkdirError) => {
    if (mkdirError) {
      return;
    }

    fs.appendFile(logFile, `${line}\n`, () => {});
  });
}

module.exports = {
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
};
