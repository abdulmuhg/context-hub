import { runAdmin } from './admin.js';
import { openDb } from './db.js';

const db = openDb(process.env.DATABASE_PATH ?? './data/hub.sqlite');
runAdmin(process.argv.slice(2), { db, out: (l) => console.log(l), err: (l) => console.error(l) }).then((code) => {
  db.close();
  process.exit(code);
});
