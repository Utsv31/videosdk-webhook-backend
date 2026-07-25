const fs = require('fs');
const path = require('path');

const DEFAULT_SECRET_DIR = '/etc/secrets';

function normalizeFileNames(defaultFileNames) {
  return defaultFileNames
    .filter(Boolean)
    .flatMap((fileName) => {
      if (path.isAbsolute(fileName)) {
        return [fileName];
      }

      return [
        path.join(DEFAULT_SECRET_DIR, fileName),
        path.join(process.cwd(), fileName),
      ];
    });
}

function readSecret(name, options = {}) {
  const {
    defaultFileNames = [],
    trim = true,
  } = options;

  if (process.env[name]) {
    return trim ? process.env[name].trim() : process.env[name];
  }

  const explicitFile = process.env[`${name}_FILE`];
  const candidates = normalizeFileNames([
    explicitFile,
    ...defaultFileNames,
  ]);

  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) {
      continue;
    }

    const value = fs.readFileSync(candidate, 'utf8');
    return trim ? value.trim() : value;
  }

  return null;
}

function requireSecret(name, options = {}) {
  const value = readSecret(name, options);

  if (!value) {
    throw new Error(`${name} is not configured`);
  }

  return value;
}

module.exports = {
  readSecret,
  requireSecret,
};
