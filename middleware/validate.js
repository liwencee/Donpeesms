/**
 * Validation middleware — wraps express-validator
 */
const { validationResult } = require('express-validator');
const ApiError = require('../utils/apiError');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();

  const messages = errors.array().map(e => `${e.path}: ${e.msg}`);
  throw new ApiError(400, messages.join(' | '));
};

module.exports = validate;
