'use strict';

function serializeError(error) {
  if (!error) return undefined;
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code,
  };
}

function write(level, message, fields = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  if (entry.error instanceof Error) entry.error = serializeError(entry.error);
  const output = JSON.stringify(entry);
  if (level === 'error') console.error(output);
  else if (level === 'warn') console.warn(output);
  else console.log(output);
}

function requestLogger(req, res, next) {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    write(res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info', 'http_request', {
      requestId: req.id,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      authenticated: Boolean(req.session && req.session.userPhone),
      activeAccount: Boolean(req.activeAccount),
    });
  });
  next();
}

module.exports = {
  error(message, fields) { write('error', message, fields); },
  info(message, fields) { write('info', message, fields); },
  requestLogger,
  warn(message, fields) { write('warn', message, fields); },
};
