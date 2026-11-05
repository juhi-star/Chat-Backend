import { Pool } from 'pg';
import { config } from './config';

export const pool = new Pool({ connectionString: config.databaseUrl });

// Idle clients can be dropped by PostgreSQL or the network. Without a listener,
// Node treats the pool's 'error' event as unhandled and exits the process.
pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error', err);
});
