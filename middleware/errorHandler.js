/**
 * Global error handler — last in middleware chain
 */
const logger = require('../utils/logger');
const ApiError = require('../utils/apiError');

// Postgres / PostgREST error codes. supabase-js surfaces both kinds of
// error with a `.code`: raw SQLSTATE for constraint violations that
// happen in the database, and PGRST* for PostgREST's own errors.
// Without this mapping a duplicate category or provider name came back
// as a generic 500 — reported as our fault and unactionable for the caller.
const PG_ERROR_CODES = new Set(['23505', '23503', '23514', 'PGRST116']);

const handlePostgresError = (err) => {
  switch (err.code) {
    case '23505': {
      // details looks like: Key (name)=(Prepaid) already exists.
      const field = /Key \(([^)]+)\)=/.exec(err.details || '');
      return new ApiError(409, field ? `${field[1]} already exists` : 'That record already exists');
    }
    case '23503':
      return new ApiError(400, 'Referenced record does not exist');
    case '23514':
      return new ApiError(400, 'Value rejected by a database constraint');
    default: // PGRST116 — no rows where exactly one was expected
      return new ApiError(404, 'Resource not found');
  }
};

const errorHandler = (err, req, res, next) => {
  let error = err;

  if (err.name === 'JsonWebTokenError') error = new ApiError(401, 'Invalid token');
  else if (err.name === 'TokenExpiredError') error = new ApiError(401, 'Token expired');
  else if (err.code && PG_ERROR_CODES.has(err.code)) error = handlePostgresError(err);
  // Malformed JSON body: express.json() throws a SyntaxError with
  // type 'entity.parse.failed'. This is a CLIENT mistake — it was
  // falling through to a generic 500, which both misreports the fault
  // and pollutes error logs with fake "server errors" that mask real ones.
  else if (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err)) {
    error = new ApiError(400, 'Malformed JSON in request body');
  }
  // Body larger than the configured limit — also a client error.
  else if (err.type === 'entity.too.large') {
    error = new ApiError(413, 'Request body too large');
  }

  if (!(error instanceof ApiError)) {
    error = new ApiError(500, 'Internal server error', false);
  }

  // Log
  if (error.statusCode >= 500) {
    logger.error('Server error:', {
      message: err.message,
      stack: err.stack,
      url: req.originalUrl,
      method: req.method,
      ip: req.ip,
      userId: req.userId
    });
  } else {
    logger.warn(`${error.statusCode} ${req.method} ${req.originalUrl}: ${error.message}`);
  }

  res.status(error.statusCode).json({
    success: false,
    status: error.status,
    message: error.message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};

const notFound = (req, res, next) =>
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));

module.exports = { errorHandler, notFound };
