import { readFileSync } from 'fs';
import { join } from 'path';
import { pool } from './db';

async function main(): Promise<void> {
  await pool.query(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  console.log('Migration complete');
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
