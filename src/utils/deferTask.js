const { waitUntil } = require('@vercel/functions');

function deferTask(task) {
  if (process.env.VERCEL) {
    waitUntil(Promise.resolve().then(task));
    return;
  }

  setImmediate(task);
}

module.exports = deferTask;
