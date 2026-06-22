const { migrate, pool } = require('../db');

migrate()
  .then(() => {
    console.log('Database migrations completed.');
    return pool.end();
  })
  .catch(async (error) => {
    console.error(error);
    await pool.end().catch(() => {});
    process.exit(1);
  });
