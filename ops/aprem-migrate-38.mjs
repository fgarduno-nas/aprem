import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const backend = '/opt/egem-visor-morelos/backend';
const backupRoot = '/var/backups/aprem';
const EXPECTED_CANDIDATES = 38;
const OLD_SUFFIX = '@egem.morelos';
const NEW_SUFFIX = '@aprem.morelos';
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
      if (manifest.identity !== identity || !Number.isFinite(age) || age < 0 || age > 24 * 3600 * 1000 || !manifest.restoreVerified) continue;
      const dump = path.join(backupRoot, directory, 'database.dump');
      if (await sha256(dump) !== manifest.sha256) continue;
      quiet('pg_restore', ['--list', dump]);
      return { expiresAt: Date.parse(manifest.createdAt) + 24 * 3600 * 1000 };
    } catch { /* An unverified or stale file is never accepted. */ }
  }
  return false;
}

export class MigrationStopped extends Error {
  constructor(reason, counts = {}) { super(reason); this.reason = reason; this.counts = counts; }
}

export function planGuardedMigration(users) {
  const candidates = users.filter(user => user.email.endsWith(OLD_SUFFIX));
  const existing = new Set(users.map(user => user.email.toLowerCase()));
  const targets = new Set();
  let collisions = 0;
  const changes = candidates.map(user => {
    const email = user.email.slice(0, -OLD_SUFFIX.length) + NEW_SUFFIX;
    const normalized = email.toLowerCase();
    if (existing.has(normalized) || targets.has(normalized)) collisions++;
    targets.add(normalized);
    return { id: user.id, previousEmail: user.email, email };
  });
  return { changes, candidatas: candidates.length, colisiones: collisions };
}

export async function guardedMigrate(prisma, verifyBackup) {
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '10s'");
    // Serialize all account writes with the count check and update.
    await tx.$executeRawUnsafe('LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE');
    const before = await tx.user.findMany();
    const plan = planGuardedMigration(before);
    const counts = { candidatas: plan.candidatas, colisiones: plan.colisiones };
    if (plan.candidatas !== EXPECTED_CANDIDATES || plan.colisiones !== 0) {
      throw new MigrationStopped('CONTEOS_DISTINTOS_DE_38_Y_0', counts);
    }
    if (plan.changes.some(change => change.previousEmail !== change.previousEmail.toLowerCase())) {
      throw new MigrationStopped('CUENTAS_REQUIEREN_REVISION_DE_ACCESO', counts);
    }
    const backup = await verifyBackup();
    if (!backup || !Number.isFinite(backup.expiresAt) || Date.now() >= backup.expiresAt) {
      throw new MigrationStopped('RESPALDO_NO_VIGENTE_O_NO_VERIFICADO', counts);
    }
    let updated = 0;
    for (const change of plan.changes) {
      // Raw, parameterized SQL changes only email, including preservation of updatedAt.
      const affected = await tx.$executeRaw`UPDATE "User" SET "email" = ${change.email}
        WHERE "id" = ${change.id} AND "email" = ${change.previousEmail}`;
      if (affected !== 1) throw new Error('UPDATE_COUNT_MISMATCH');
      updated += affected;
      await tx.auditLog.create({ data: {
        entityType: 'User', entityId: change.id, action: 'USER_UPDATED',
        description: 'Migración de correo APREM.',
        metadata: { migration: 'aprem-email-v1', batch: 'aprem-38-guarded-v1',
          previousEmail: change.previousEmail, newEmail: change.email },
      } });
    }
    const after = await tx.user.findMany();
    const afterById = new Map(after.map(user => [user.id, user]));
    const changedById = new Map(plan.changes.map(change => [change.id, change.email]));
    const remaining = after.filter(user => user.email.endsWith(OLD_SUFFIX)).length;
    if (updated !== EXPECTED_CANDIDATES || remaining !== 0 || after.length !== before.length) {
      throw new Error('POSTCHECK_COUNT_MISMATCH');
    }
    for (const user of before) {
      const expected = changedById.has(user.id) ? { ...user, email: changedById.get(user.id) } : user;
      if (!isDeepStrictEqual(afterById.get(user.id), expected)) throw new Error('USER_FIELDS_CHANGED');
    }
    if (Date.now() >= backup.expiresAt) throw new Error('BACKUP_EXPIRED_DURING_TRANSACTION');
    return { estado: 'APLICADA', respaldo: 'VERIFICADO_MENOS_24H', ...counts,
      actualizadas: updated, restantes_sufijo_anterior: remaining };
  }, { isolationLevel: 'Serializable', timeout: 180000, maxWait: 10000 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let prisma;
  let committed;
  let output;
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--apply-38') {
      throw new MigrationStopped('MODO_NO_AUTORIZADO');
    }
    const { url, PrismaClient } = runtimeEnvironment();
    prisma = new PrismaClient({ datasourceUrl: url.href, log: [] });
    const database = await prisma.$queryRawUnsafe('SELECT current_database() AS name');
    if (database[0]?.name !== decodeURIComponent(url.pathname.slice(1))) {
      throw new MigrationStopped('BASE_NO_COINCIDE');
    }
    const identity = crypto.createHash('sha256')
      .update(`${url.hostname}:${url.port || '5432'}/${database[0].name}`).digest('hex');
    committed = await guardedMigrate(prisma, () => verifiedBackup(identity));
    // Fresh check after the transaction has committed, to reveal concurrent new accounts.
    const users = await prisma.user.findMany({ select: { email: true } });
    const remaining = users.filter(user => user.email.endsWith(OLD_SUFFIX)).length;
    output = { ...committed, restantes_sufijo_anterior: remaining };
    if (remaining !== 0) { output.estado = 'APLICADA_REVISAR_REMANENTES'; process.exitCode = 2; }
  } catch (error) {
    if (committed) {
      output = { ...committed, estado: 'APLICADA_COMPROBACION_POSTERIOR_PENDIENTE', restantes_sufijo_anterior: null };
    } else if (error instanceof MigrationStopped) {
      output = { estado: 'DETENIDA_SIN_CAMBIOS', motivo: error.reason,
        candidatas: error.counts.candidatas ?? null, colisiones: error.counts.colisiones ?? null,
        actualizadas: 0, restantes_sufijo_anterior: error.counts.candidatas ?? null };
    } else {
      // A transport failure at COMMIT can leave the outcome unknown. Never claim zero
      // updates or automatically retry in that situation; expose no raw Prisma errors.
      output = { estado: 'RESULTADO_NO_CONFIRMADO_NO_REPETIR',
        actualizadas: null, restantes_sufijo_anterior: null };
    }
    process.exitCode = 1;
  } finally {
    try { await prisma?.$disconnect(); } catch { process.exitCode = 1; }
    console.log(JSON.stringify(output));
  }
}
