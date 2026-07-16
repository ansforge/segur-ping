'use strict';
// Exit code 0 when the current minute is a "publish tick" (top of the hour and
// hour divisible by publishEveryHours), otherwise exit 1. Used by the Jenkins
// `when` condition so the single minute-cron job publishes only every N hours.

const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf8'));
const tz = config.timezone || 'UTC';
const everyH = config.publishEveryHours || 2;

const parts = new Intl.DateTimeFormat('en-GB', {
  timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
}).formatToParts(new Date()).reduce((a, p) => (a[p.type] = p.value, a), {});

const hour = parseInt(parts.hour === '24' ? '0' : parts.hour, 10);
const minute = parseInt(parts.minute, 10);

const isTick = minute === 0 && hour % everyH === 0;
process.exit(isTick ? 0 : 1);
