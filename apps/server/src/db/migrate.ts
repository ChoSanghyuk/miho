import { dbPath } from '../config.js';
import { openDb } from './index.js';

openDb(dbPath).$client.close();
console.log(`Migrated ${dbPath}`);
