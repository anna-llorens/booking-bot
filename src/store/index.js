// store — Where businesses, customers, appointments, conversations and messages are kept.
//
// Today there is one implementation, SQLite (src/store/sqlite-store.js). Anything that implements the
// same async methods (see README.md in this folder) can replace it, e.g. a Postgres store, without
// touching the bot. Tests use createStore(':memory:').
const path = require('path');
const { SqliteStore } = require('./sqlite-store');

const DEFAULT_FILE = path.join(__dirname, '..', '..', 'private-data', 'booking-bot.db'); // git-ignored

function createStore(file = process.env.BOOKING_DB || DEFAULT_FILE) {
  return new SqliteStore(file);
}

module.exports = { createStore, DEFAULT_FILE };
