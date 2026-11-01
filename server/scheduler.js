const cron = require('node-cron');
const { fetchAll } = require('./fetcher');
const { runCollisionDetectionBackground } = require('./collision');

// Every 6 hours: refresh TLEs from all sources
cron.schedule('0 */6 * * *', async () => {
  console.log('[scheduler] TLE refresh triggered');
  await fetchAll();
});

// Every 4 hours (offset by 30 min to let TLE fetch settle): run collision detection
cron.schedule('30 */4 * * *', async () => {
  console.log('[scheduler] Collision detection triggered');
  await runCollisionDetectionBackground();
});

console.log('[scheduler] Jobs registered (TLE every 6h, collisions every 4h).');

/**
 * Run the startup sequence: fetch TLEs immediately, then kick off collision
 * detection after a short delay so the DB is populated before screening.
 */
async function runStartup() {
  console.log('[scheduler] Running startup fetch…');
  try {
    await fetchAll();
  } catch (err) {
    console.error('[scheduler] Startup TLE fetch failed:', err.message);
  }

  // Delay collision detection so SQLite writes from fetchAll are fully committed
  setTimeout(async () => {
    console.log('[scheduler] Running startup collision detection…');
    await runCollisionDetectionBackground();
  }, 5_000);
}

module.exports = { runStartup };
