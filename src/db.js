'use strict';

const config = require('./config');

const driver = config.db.driver === 'mysql'
  ? require('./drivers/mysql')
  : require('./drivers/sqlite');

module.exports = driver;
