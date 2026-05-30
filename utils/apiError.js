/**
 * Operational error class — distinguishes expected errors from programmer bugs
 */
class ApiError extends Error {
  constructor(statusCode, message, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(msg = 'Bad request')      { return new ApiError(400, msg); }
  static unauthorized(msg = 'Unauthorized')    { return new ApiError(401, msg); }
  static forbidden(msg = 'Forbidden')          { return new ApiError(403, msg); }
  static notFound(msg = 'Not found')           { return new ApiError(404, msg); }
  static conflict(msg = 'Conflict')            { return new ApiError(409, msg); }
  static tooMany(msg = 'Too many requests')    { return new ApiError(429, msg); }
  static internal(msg = 'Internal server error'){ return new ApiError(500, msg, false); }
}

module.exports = ApiError;
