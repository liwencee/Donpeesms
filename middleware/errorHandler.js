/**
 * Global error handler — last in middleware chain
 */
const logger = require('../utils/logger');
const ApiError = require('../utils/apiError');

const handleCastError = (err) =>
  new ApiError(400, `Invalid ${err.path}: ${err.value}`);

const handleDuplicateKey = (err) => {
  const field = Object.keys(err.keyValue)[0];
  return new ApiError(409, `${field} already exists`);
};

const handleValidationError = (err) => {
  const messages = Object.values(err.errors).map(e => e.message);
  return new ApiError(400, `Validation failed: ${messages.join(', ')}`);
};

const errorHandler = (err, req, res, next) => {
  let error = err;

  // Mongoose errors
  if (err.name === 'CastError')         error = handleCastError(err);
  else if (err.code === 11000)          error = handleDuplicateKey(err);
  else if (err.name === 'ValidationError') error = handleValidationError(err);
  else if (err.name === 'JsonWebTokenError') error = new ApiError(401, 'Invalid token');
  else if (err.name === 'TokenExpiredError') error = new ApiError(401, 'Token expired');
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
