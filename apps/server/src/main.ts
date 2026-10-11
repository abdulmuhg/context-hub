import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { openDb } from './db.js';
import { createHandler } from './http.js';
import { handleMcp } from './mcp.js';

const path = process.env.DATABASE_PATH ?? './data/hub.sqlite';
const port = Number(process.env.PORT ?? 3000);

mkdirSync(dirname(path), { recursive: true });
const db = openDb(path);
const server = createServer(createHandler({ db, mcp: handleMcp(db) }));

server.listen(port, () => console.log(`context-hub listening on :${port}, database ${path}`));

const stop = (): void => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  server.closeAllConnections();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
