import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const backend = '/opt/egem-visor-morelos/backend';
const backupRoot = '/var/backups/aprem';
const DIRECTOR = 'DATA_PROVIDER';
const MAX_RECEIPT_AGE = 24 * 3600 * 1000;
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
  const processStat = fs.readFileSync(`/proc/${item.pid}/stat`, 'utf8');
  const startTicks = Number(processStat.slice(processStat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]);
  const bootSeconds = Number(fs.readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)$/m)?.[1]);
  const ticksPerSecond = Number(quiet('getconf', ['CLK_TCK']).trim());
  const startedAt = (bootSeconds + startTicks / ticksPerSecond) * 1000;
  if (!Number.isFinite(startedAt) || !ticksPerSecond) throw new Error('RUNTIME_START_UNKNOWN');
  // dotenv modifies process.env after exec; /proc/environ alone cannot prove that
  // an edited .env still describes the running service. Refuse that ambiguity.
  for (const filename of ['.env', 'src/config/env.js', 'src/shared/utils/password.js',
    'src/shared/constants/roles.js', 'src/modules/users/users.schemas.js']) {
    if (fs.statSync(path.join(backend, filename)).mtimeMs > startedAt) stop('CONFIGURACION_MODIFICADA_DESDE_ARRANQUE_REVISAR');
  }
  const procEnv = Object.fromEntries(fs.readFileSync(`/proc/${item.pid}/environ`, 'utf8').split('\0').filter(Boolean).map(line => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
  }));
  const envSource = fs.readFileSync(path.join(backend, 'src/config/env.js'), 'utf8');
  if (!envSource.includes('../../.env') || !envSource.includes('dotenv.config')) throw new Error('UNSUPPORTED_ENV_LOADER');
  const values = { ...dotenv.parse(fs.readFileSync(path.join(backend, '.env'))), ...procEnv };
  const url = new URL(values.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('UNSUPPORTED_DATABASE');
  const { PrismaClient } = require('@prisma/client');
  return { url, PrismaClient, values };
}
async function verifiedBackup(identity) {
  if (!fs.existsSync(backupRoot)) return false;
  for (const directory of fs.readdirSync(backupRoot)) {
    if (!/^backup-[a-f0-9]{24}$/.test(directory)) continue;
    const manifestPath = path.join(backupRoot, directory, 'verified.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const age = Date.now() - Date.parse(manifest.createdAt);
      if (manifest.identity !== identity || !Number.isFinite(age) || age < 0 || age > 24 * 3600 * 1000 || !manifest.restoreVerified) continue;
      const dump = path.join(backupRoot, directory, 'database.dump');
      if (await sha256(dump) !== manifest.sha256) continue;
      quiet('pg_restore', ['--list', dump]);
      return { expiresAt: Date.parse(manifest.createdAt) + 24 * 3600 * 1000 };
    } catch { /* An unverified or stale file is never accepted. */ }
  }
  return false;
}

export class RotationStopped extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
const stop = reason => { throw new RotationStopped(reason); };
const stamp = (user, key) => crypto.createHmac('sha256', Buffer.from(key, 'hex'))
  .update(JSON.stringify([user.id, user.roleId, user.role.code, user.isActive, user.deletedAt, user.passwordHash])).digest('hex');
const fingerprints = (users, key) => users.map(user => ({ id: user.id, stamp: stamp(user, key) })).sort((a, b) => a.id.localeCompare(b.id));
function checkReceipt(receipt, identity, phase) {
  const age = Date.now() - Date.parse(receipt.createdAt);
  if (receipt.version !== 1 || receipt.phase !== phase || receipt.identity !== identity ||
      !Number.isFinite(age) || age < 0 || age > MAX_RECEIPT_AGE ||
      !/^[a-f0-9]{64}$/.test(receipt.key) || !Array.isArray(receipt.candidates)) stop('REQUIERE_NUEVA_SIMULACION');
}
export async function classifyDirectors(users, previous, library) {
  if (!previous) stop('ENTRADA_VACIA');
  const directors = users.filter(user => user.role.code === DIRECTOR);
  const candidates = [];
  for (const user of directors) if (await library.verifyPassword(previous, user.passwordHash)) candidates.push(user);
  return { candidates, counts: {
    directores_activos: directors.filter(user => user.isActive).length,
    directores_inactivos: directors.filter(user => !user.isActive).length,
    con_anterior: candidates.length,
    con_otra: directors.length - candidates.length,
    eliminados_incluidos: directors.filter(user => user.deletedAt !== null).length,
  } };
}
export async function simulateRotation(prisma, identity, previous, library) {
  const users = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    return tx.user.findMany({ include: { role: true } });
  }, { isolationLevel: 'RepeatableRead' });
  const { candidates, counts } = await classifyDirectors(users, previous, library);
  const key = crypto.randomBytes(32).toString('hex');
  return { summary: { estado: 'SIMULACION', ...counts }, receipt: {
    version: 1, phase: 'simulated', identity, createdAt: new Date().toISOString(),
    key, batch: crypto.randomUUID(), candidates: fingerprints(candidates, key),
  } };
}
export async function rotatePasswords(prisma, identity, receipt, previous, next, library, verifyBackup, rollback = false) {
  checkReceipt(receipt, identity, rollback ? 'applied' : 'simulated');
  if (!next || !library.validPassword(next) || previous === next) stop('NUEVA_NO_VALIDA_O_IGUAL');
  if (!receipt.candidates.length) stop('SIN_CANDIDATAS');
  const prepared = new Map();
  // Generate a fresh bcrypt salt for every account, outside the write lock.
  for (const candidate of receipt.candidates) prepared.set(candidate.id, await library.hashPassword(next));
  if (new Set(prepared.values()).size !== prepared.size) stop('HASHES_NO_INDEPENDIENTES');
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '10s'");
    await tx.$executeRawUnsafe('LOCK TABLE "Role" IN SHARE MODE');
    await tx.$executeRawUnsafe('LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE');
    checkReceipt(receipt, identity, rollback ? 'applied' : 'simulated');
    const before = await tx.user.findMany({ include: { role: true } });
    const classified = await classifyDirectors(before, previous, library);
    let candidates;
    if (rollback) {
      const ids = new Set(receipt.candidates.map(item => item.id));
      candidates = classified.candidates.filter(user => ids.has(user.id));
      if (!isDeepStrictEqual(fingerprints(candidates, receipt.key), receipt.after)) stop('CAMBIOS_POSTERIORES_NO_REVERTIR');
    } else {
      candidates = classified.candidates;
      if (!isDeepStrictEqual(fingerprints(candidates, receipt.key), receipt.candidates)) stop('CAMBIO_DE_CANDIDATAS_REQUIERE_SIMULACION');
    }
    const backup = await verifyBackup();
    if (!backup || !Number.isFinite(backup.expiresAt) || Date.now() >= backup.expiresAt) stop('RESPALDO_NO_VIGENTE_O_NO_VERIFICADO');
    // Reject bcrypt-equivalent input, including truncation-equivalent passwords.
    for (const user of candidates) if (await library.verifyPassword(next, user.passwordHash)) stop('NUEVA_EQUIVALENTE_A_LA_ANTERIOR');
    for (const user of candidates) {
      const affected = await tx.$executeRaw`UPDATE "User" SET "passwordHash" = ${prepared.get(user.id)}
        WHERE "id" = ${user.id} AND "roleId" = ${user.roleId} AND "passwordHash" = ${user.passwordHash}`;
      if (affected !== 1) throw new Error('WRITE_GUARD_FAILED');
      await tx.auditLog.create({ data: library.buildAuditRecord({
        entityType: 'User', entityId: user.id, action: 'USER_UPDATED',
        description: rollback ? 'Reversión de contraseña de Director APREM.' : 'Contraseña de Director restablecida por transición APREM.',
        metadata: { passwordResetByAdmin: true, operation: rollback ? 'aprem-director-rollback-v1' : 'aprem-director-password-v1', batch: receipt.batch },
      }) });
    }
    const after = await tx.user.findMany({ include: { role: true } });
    const afterById = new Map(after.map(user => [user.id, user]));
    const changedIds = new Set(candidates.map(user => user.id));
    if (before.length !== after.length) throw new Error('ROW_COUNT_CHANGED');
    for (const user of before) {
      const expected = changedIds.has(user.id) ? { ...user, passwordHash: prepared.get(user.id) } : user;
      if (!isDeepStrictEqual(afterById.get(user.id), expected)) throw new Error('OTHER_FIELDS_CHANGED');
    }
    for (const user of candidates) {
      const current = afterById.get(user.id);
      if (!(await library.verifyPassword(next, current.passwordHash)) || await library.verifyPassword(previous, current.passwordHash)) throw new Error('PASSWORD_POSTCHECK_FAILED');
    }
    if (Date.now() >= backup.expiresAt) throw new Error('BACKUP_EXPIRED');
    const updatedReceipt = { ...receipt, phase: rollback ? 'rolled-back' : 'applied',
      appliedAt: new Date().toISOString(), after: fingerprints(candidates.map(user => afterById.get(user.id)), receipt.key) };
    return { receipt: updatedReceipt, summary: {
      estado: rollback ? 'REVERTIDA' : 'APLICADA', respaldo: 'VERIFICADO_MENOS_24H',
      ...classified.counts,
      con_anterior: classified.counts.con_anterior - candidates.length,
      con_otra: classified.counts.con_otra + candidates.length,
      actualizadas: candidates.length, candidatas_del_lote_con_anterior: 0,
    } };
  }, { isolationLevel: 'Serializable', timeout: 300000, maxWait: 10000 });
}

function privateFile(filename) {
  const directory = fs.lstatSync(path.dirname(filename));
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) || directory.uid !== process.geteuid()) stop('DIRECTORIO_NO_PRIVADO');
  if (fs.existsSync(filename)) {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.geteuid()) stop('RECIBO_NO_PRIVADO');
  }
}
function saveReceipt(filename, receipt) {
  privateFile(filename);
  const temporary = filename + '.' + crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, filename);
}
function hiddenInput(label) {
  // Secrets travel on a private IPC descriptor, never stdout, argv, env or disk.
  const code = `import os,sys,getpass,signal
for sig in (signal.SIGTERM,signal.SIGHUP):
 signal.signal(sig,lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
try:
 with open('/dev/tty','w') as terminal:
  if not terminal.isatty(): raise RuntimeError()
  value=getpass.getpass(sys.argv[1],stream=terminal)
  os.write(3,value.encode('utf-8'))
except BaseException:
 sys.exit(1)
`;
  const result = spawnSync('python3', ['-c', code, label], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'], maxBuffer: 65536 });
  if (result.error || result.status !== 0 || !result.output[3]) stop('ENTRADA_OCULTA_CANCELADA');
  const value = result.output[3].toString('utf8'); result.output[3].fill(0);
  if (!value) stop('ENTRADA_VACIA');
  return value;
}
async function runConsole() {
  let prisma; let locked; let statePath; let committed; let output; let attemptedWrite = false;
  try {
    const [mode, filename, authorization] = process.argv.slice(2);
    if (!['simulate', 'apply', 'rollback'].includes(mode) || !filename ||
        (mode === 'simulate' ? process.argv.length !== 4 : process.argv.length !== 5 || authorization !== '--confirmed')) stop('MODO_NO_AUTORIZADO');
    statePath = path.resolve(filename); privateFile(statePath);
    locked = fs.openSync(statePath + '.lock', 'wx', 0o600);
    const { url, PrismaClient, values } = runtimeEnvironment();
    for (const name of Object.keys(process.env)) if (!(name in values)) delete process.env[name];
    Object.assign(process.env, values);
    for (const name of ["DEBUG", "NODE_DEBUG", "NODE_OPTIONS", "RUST_LOG", "PRISMA_LOG_LEVEL"]) delete process.env[name];
    // These are the installed backend's own verifier, hash function and validation.
    const passwords = await import(pathToFileURL(path.join(backend, 'src/shared/utils/password.js')).href);
    const schemas = await import(pathToFileURL(path.join(backend, 'src/modules/users/users.schemas.js')).href);
    const roles = await import(pathToFileURL(path.join(backend, 'src/shared/constants/roles.js')).href);
    if (roles.ROLE_CODES.DATA_PROVIDER !== DIRECTOR) stop('ROL_NO_CONFIRMADO');
    const audit = await import(new URL('./aprem-audit-record.mjs', import.meta.url));
    const library = { ...passwords, buildAuditRecord: audit.buildAuditRecord,
      validPassword: value => schemas.resetPasswordSchema.shape.body.shape.password.safeParse(value).success && Buffer.byteLength(value, 'utf8') <= 72 };
    prisma = new PrismaClient({ datasourceUrl: url.href, log: [] });
    const db = await prisma.$queryRawUnsafe('SELECT current_database() AS name');
    if (db[0]?.name !== decodeURIComponent(url.pathname.slice(1))) stop('BASE_NO_CONFIRMADA');
    const identity = crypto.createHash('sha256').update(`${url.hostname}:${url.port || '5432'}/${db[0].name}`).digest('hex');
    if (mode === 'simulate') {
      if (fs.existsSync(statePath) && JSON.parse(fs.readFileSync(statePath, 'utf8')).phase === 'applied') stop('CONSERVAR_RECIBO_APLICADO_USAR_OTRO_DIRECTORIO');
      const previous = hiddenInput('Contraseña anterior de EGEM (oculta): ');
      const simulation = await simulateRotation(prisma, identity, previous, library);
      saveReceipt(statePath, simulation.receipt); output = simulation.summary;
    } else {
      const receipt = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      checkReceipt(receipt, identity, mode === 'apply' ? 'simulated' : 'applied');
      if (!receipt.candidates.length) stop('SIN_CANDIDATAS');
      if (!(await verifiedBackup(identity))) stop('RESPALDO_NO_VIGENTE_O_NO_VERIFICADO');
      const previous = hiddenInput(mode === 'apply' ? 'Contraseña anterior de EGEM (oculta): ' : 'Contraseña APREM aplicada (oculta): ');
      const next = hiddenInput(mode === 'apply' ? 'Nueva contraseña APREM (oculta): ' : 'Contraseña anterior a restaurar (oculta): ');
      const repeat = hiddenInput('Repita la contraseña de destino (oculta): ');
      if (next !== repeat) stop('CONFIRMACION_NO_COINCIDE');
      attemptedWrite = true;
      committed = await rotatePasswords(prisma, identity, receipt, previous, next, library, () => verifiedBackup(identity), mode === 'rollback');
      saveReceipt(statePath, committed.receipt); output = committed.summary;
    }
  } catch (error) {
    process.exitCode = 1;
    output = committed ? { ...committed.summary, estado: 'APLICADA_RECIBO_PENDIENTE_NO_REPETIR' } :
      error instanceof RotationStopped ? { estado: 'DETENIDA_SIN_CAMBIOS', motivo: error.reason, actualizadas: 0 } :
        !attemptedWrite ? { estado: 'DETENIDA_SIN_CAMBIOS', motivo: 'NO_SE_PUDO_CONFIRMAR_ENTORNO_O_ENTRADA', actualizadas: 0 } :
          { estado: 'RESULTADO_NO_CONFIRMADO_NO_REPETIR', actualizadas: null };
  } finally {
    try { await prisma?.$disconnect(); } catch { process.exitCode = 1; }
    if (locked !== undefined) {
      try { fs.closeSync(locked); fs.unlinkSync(statePath + '.lock'); }
      catch { process.exitCode = 1; output = { ...output, estado: committed ? 'APLICADA_CIERRE_PENDIENTE_NO_REPETIR' : 'DETENIDA_CIERRE_PENDIENTE' }; }
    }
    console.log(JSON.stringify(output));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runConsole();
