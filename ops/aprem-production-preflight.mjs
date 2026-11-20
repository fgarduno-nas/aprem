import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

// Standalone console tool. No mode updates application data or accounts.
const backend = '/opt/egem-visor-morelos/backend';
const backupRoot = '/var/backups/aprem';
const mode = process.argv[2];
const report = { respaldo: 'NO_VERIFICADO', candidatas: null, colisiones: null };
let client;
const quiet = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  if (result.error || result.status !== 0) throw new Error('COMMAND_FAILED');
  return result.stdout?.toString() || '';
};
const sha256 = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(file).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
});
function runtimeEnvironment() {
  const require = createRequire(path.join(backend, 'package.json'));
  const dotenv = require('dotenv');
  const pm2Home = process.env.PM2_HOME || path.join(process.env.HOME, '.pm2');
  const daemonPid = Number(fs.readFileSync(path.join(pm2Home, 'pm2.pid'), 'utf8').trim());
  if (!Number.isInteger(daemonPid) || daemonPid < 2) throw new Error('PM2_NOT_RUNNING');
  process.kill(daemonPid, 0); // Never let a read-only inspection start another daemon.
  const processes = JSON.parse(quiet('pm2', ['jlist']));
  const selected = processes.filter(item => item.pm2_env?.status === 'online' &&
    path.resolve(item.pm2_env.pm_exec_path || '') === path.join(backend, 'src/server.js'));
  if (selected.length !== 1 || !selected[0].pid) throw new Error('RUNTIME_AMBIGUOUS');
  const item = selected[0];
  const procEnv = Object.fromEntries(fs.readFileSync(`/proc/${item.pid}/environ`, 'utf8').split('\0').filter(Boolean).map(line => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
  }));
  const envSource = fs.readFileSync(path.join(backend, 'src/config/env.js'), 'utf8');
  if (!envSource.includes('../../.env') || !envSource.includes('dotenv.config')) throw new Error('UNSUPPORTED_ENV_LOADER');
  const values = { ...dotenv.parse(fs.readFileSync(path.join(backend, '.env'))), ...procEnv };
  const url = new URL(values.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('UNSUPPORTED_DATABASE');
  const { PrismaClient } = require('@prisma/client');
  return { url, PrismaClient };
}
async function verifiedBackup(identity) {
  if (!fs.existsSync(backupRoot)) return false;
  for (const directory of fs.readdirSync(backupRoot)) {
    if (!/^backup-[a-f0-9]{24}$/.test(directory)) continue;
    const manifestPath = path.join(backupRoot, directory, 'verified.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const age = Date.now() - Date.parse(manifest.createdAt);
      if (manifest.identity !== identity || age < 0 || age > 24 * 3600 * 1000 || !manifest.restoreVerified) continue;
      const dump = path.join(backupRoot, directory, 'database.dump');
      if (await sha256(dump) !== manifest.sha256) continue;
      quiet('pg_restore', ['--list', dump]);
      return true;
    } catch { /* An unverified or stale file is never accepted. */ }
  }
  return false;
}
function hasRecentUnverifiedArchive() {
  const pending = ['/var/backups', '/root/backups', '/opt/egem-visor-morelos/backups'].map(directory => ({ directory, depth: 0 }));
  let visited = 0;
  while (pending.length && visited < 2000) {
    const { directory, depth } = pending.pop();
    let entries; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++visited > 2000) return false;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 4) pending.push({ directory: file, depth: depth + 1 });
      if (!entry.isFile() || !/\.(dump|backup|sql|sql\.gz)$/i.test(entry.name)) continue;
      try { const stat = fs.statSync(file); if (stat.size > 0 && Date.now() - stat.mtimeMs >= 0 && Date.now() - stat.mtimeMs < 86400000) return true; } catch {}
    }
  }
  return false;
}
async function makeBackup(url, identity) {
  const directory = path.join(backupRoot, `backup-${crypto.randomBytes(12).toString('hex')}`);
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(directory, { mode: 0o700 });
  const dump = path.join(directory, 'database.dump');
  const childEnv = {
    PATH: process.env.PATH, LANG: 'C', HOME: process.env.HOME,
    PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGCONNECT_TIMEOUT: '15', PGAPPNAME: 'aprem-backup',
  };
  if (url.searchParams.has('sslmode')) childEnv.PGSSLMODE = url.searchParams.get('sslmode');
  const output = fs.openSync(dump, 'wx', 0o600);
  try { quiet('pg_dump', ['--format=custom', '--no-password'], { env: childEnv, stdio: ['ignore', output, 'pipe'] }); }
  finally { fs.closeSync(output); }
  quiet('pg_restore', ['--list', dump]);
  // Restore only to a new, randomly named local database, never the production target.
  const temporary = `aprem_restorecheck_${crypto.randomBytes(12).toString('hex')}`;
  if (!/^aprem_restorecheck_[a-f0-9]{24}$/.test(temporary) || temporary === childEnv.PGDATABASE) throw new Error('UNSAFE_RESTORE_TARGET');
  let created = false;
  try {
    quiet('runuser', ['-u', 'postgres', '--', 'createdb', '--template=template0', temporary]);
    created = true;
    const input = fs.openSync(dump, 'r');
    try { quiet('runuser', ['-u', 'postgres', '--', 'pg_restore', '--dbname', temporary, '--no-owner', '--no-privileges', '--exit-on-error'], { stdio: [input, 'pipe', 'pipe'] }); }
    finally { fs.closeSync(input); }
    // Confirm the restored account table can be read; do not print its contents.
    quiet('runuser', ['-u', 'postgres', '--', 'psql', '--dbname', temporary, '--no-psqlrc', '--tuples-only', '--command', 'SELECT count(*) FROM "User";']);
  } finally {
    if (created) quiet('runuser', ['-u', 'postgres', '--', 'dropdb', temporary]);
  }
  fs.writeFileSync(path.join(directory, 'verified.json'), JSON.stringify({
    identity, createdAt: new Date().toISOString(), sha256: await sha256(dump), restoreVerified: true,
  }), { flag: 'wx', mode: 0o600 });
}
try {
  if (!['inspect', 'backup', 'simulate'].includes(mode) || process.argv.length !== 3) throw new Error('INVALID_MODE');
  const { url, PrismaClient } = runtimeEnvironment();
  client = new PrismaClient({ datasourceUrl: url.href, log: [] });
  const database = await client.$queryRawUnsafe('SELECT current_database() AS name');
  if (database[0]?.name !== decodeURIComponent(url.pathname.slice(1))) throw new Error('DATABASE_MISMATCH');
  const identity = crypto.createHash('sha256').update(`${url.hostname}:${url.port || '5432'}/${database[0].name}`).digest('hex');
  let verified = await verifiedBackup(identity);
  if (mode === 'backup' && !verified) {
    const size = await client.$queryRawUnsafe('SELECT pg_database_size(current_database()) AS bytes');
    const bytes = BigInt(size[0].bytes);
    const dataDirectory = quiet('runuser', ['-u', 'postgres', '--', 'psql', '--dbname', 'postgres', '--no-psqlrc', '--tuples-only', '--no-align', '--command', 'SHOW data_directory;']).trim();
    const free = directory => { const stat = fs.statfsSync(directory, { bigint: true }); return stat.bavail * stat.bsize; };
    const backupParent = fs.existsSync(backupRoot) ? backupRoot : '/var/backups';
    const sameDisk = fs.statSync(backupParent).dev === fs.statSync(dataDirectory).dev;
    const headroom = 512n * 1024n * 1024n;
    if (free(backupParent) < bytes * (sameDisk ? 3n : 2n) + headroom || free(dataDirectory) < bytes * 2n + headroom) throw new Error('INSUFFICIENT_SPACE');
    await makeBackup(url, identity); verified = await verifiedBackup(identity);
  }
  report.respaldo = verified ? 'VERIFICADO_MENOS_24H' : hasRecentUnverifiedArchive() ? 'RESPALDO_RECIENTE_SIN_VERIFICAR' : 'SIN_RESPALDO_RECIENTE_VERIFICADO';
  if (mode === 'simulate') {
    const users = await client.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return tx.user.findMany({ select: { email: true } });
    }, { isolationLevel: 'RepeatableRead' });
    const existing = new Set(users.map(user => user.email.toLowerCase()));
    const targets = new Set();
    report.candidatas = 0; report.colisiones = 0;
    for (const user of users) if (user.email.endsWith('@egem.morelos')) {
      report.candidatas++;
      const target = (user.email.slice(0, -'@egem.morelos'.length) + '@aprem.morelos').toLowerCase();
      if (existing.has(target) || targets.has(target)) report.colisiones++;
      targets.add(target);
    }
  }
} catch {
  report.respaldo = 'NO_VERIFICADO_ERROR_DE_COMPROBACION';
  report.candidatas = null; report.colisiones = null; process.exitCode = 1;
} finally {
  try { await client?.$disconnect(); } catch { process.exitCode = 1; }
  console.log(JSON.stringify(report));
}
