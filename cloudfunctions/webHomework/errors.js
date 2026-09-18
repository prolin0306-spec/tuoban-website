'use strict';
class AppError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new AppError(code, message); };
module.exports = { AppError, fail };
