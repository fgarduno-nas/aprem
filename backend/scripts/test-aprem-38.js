import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { guardedMigrate, MigrationStopped } from '../../ops/aprem-migrate-38.mjs';

const url = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), 'Local PostgreSQL only');
const name = `aprem_guard_${crypto.randomBytes(8).toString('hex')}`;
const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
const admin = new PrismaClient({ datasourceUrl: adminUrl.href });
let created = false; let db; let authDb;
try {
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`); created = true;
  url.pathname = `/${name}`;
  Object.assign(process.env, { DATABASE_URL: url.href, NODE_ENV: 'test', MAX_UPLOAD_SIZE_MB: '50',
    JWT_SECRET: 'isolated-aprem-guard-secret', DEFAULT_ADMIN_EMAIL: 'fixture@example.invalid',
    DEFAULT_ADMIN_PASSWORD: 'SyntheticOnly123!', DEFAULT_ADMIN_NAME: 'Fixture' });
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: new URL('..', import.meta.url), env: process.env, stdio: 'pipe',
  });
  db = new PrismaClient({ datasourceUrl: url.href });
  const roles = [];
  for (const code of ['ADMIN', 'DATA_PROVIDER', 'PUBLIC_USER']) roles.push(await db.role.create({ data: { code, name: code } }));
  const hash = await bcrypt.hash('SyntheticOnly123!', 10);
  const users = [];
  for (let i = 0; i < 38; i++) users.push(await db.user.create({ data: {
    email: `fixture${i}@egem.morelos`, name: `Synthetic ${i}`, passwordHash: hash,
    roleId: roles[i % 3].id, isActive: i % 3 !== 2, municipality: i % 2 ? 'Synthetic' : null,
    deletedAt: i === 37 ? new Date('2026-01-01') : null,
  } }));
  const owner = users[0];
  await db.auditLog.create({ data: { actorId: owner.id, entityType: 'User', entityId: owner.id, action: 'USER_CREATED', description: 'Synthetic existing history' } });
  const layer = await db.layer.create({ data: { title: 'Synthetic', slug: 'synthetic', createdById: owner.id, division: 'vulnerability', status: 'published' } });
  await db.approvalHistory.create({ data: { layerId: layer.id, actorId: owner.id, fromStatus: 'approved', toStatus: 'published' } });
  const validBackup = async () => ({ expiresAt: Date.now() + 3600000 });
  const snapshot = () => db.user.findMany({ orderBy: { id: 'asc' } });
  const oldCount = () => db.user.count({ where: { email: { endsWith: '@egem.morelos' } } });

  await db.user.update({ where: { id: owner.id }, data: { email: 'changed@example.invalid' } });
  const changedBefore = await snapshot();
  await assert.rejects(guardedMigrate(db, validBackup), error => error instanceof MigrationStopped && error.counts.candidatas === 37);
  assert.deepEqual(await snapshot(), changedBefore);
  await db.user.update({ where: { id: owner.id }, data: { email: owner.email } });

  const collision = await db.user.create({ data: { email: 'fixture0@aprem.morelos', name: 'Synthetic collision', passwordHash: hash, roleId: roles[0].id } });
  await assert.rejects(guardedMigrate(db, validBackup), error => error instanceof MigrationStopped && error.counts.colisiones === 1);
  assert.equal(await oldCount(), 38);
  await db.user.delete({ where: { id: collision.id } });

  await assert.rejects(guardedMigrate(db, async () => false), error => error instanceof MigrationStopped && error.reason === 'RESPALDO_NO_VIGENTE_O_NO_VERIFICADO');
  await assert.rejects(guardedMigrate(db, async () => ({ expiresAt: Date.now() - 1 })), MigrationStopped);
  assert.equal(await oldCount(), 38);

  const before = await snapshot();
  await db.$executeRawUnsafe(`ALTER TABLE "AuditLog" ADD CONSTRAINT "aprem_guard_reject" CHECK (description <> 'Migración de correo APREM.')`);
  await assert.rejects(guardedMigrate(db, validBackup));
  assert.deepEqual(await snapshot(), before);
  assert.equal(await oldCount(), 38);
  await db.$executeRawUnsafe('ALTER TABLE "AuditLog" DROP CONSTRAINT "aprem_guard_reject"');

  const result = await guardedMigrate(db, validBackup);
  assert.equal(result.actualizadas, 38);
  assert.equal(result.restantes_sufijo_anterior, 0);
  const after = await snapshot();
  assert.deepEqual(after, before.map(user => ({ ...user, email: user.email.replace(/@egem\.morelos$/, '@aprem.morelos') })));
  assert.equal(await db.auditLog.count({ where: { description: 'Migración de correo APREM.' } }), 38);
  assert.equal(await db.auditLog.count({ where: { actorId: owner.id, description: 'Synthetic existing history' } }), 1);
  assert.equal(await db.layer.count({ where: { createdById: owner.id } }), 1);
  assert.equal(await db.approvalHistory.count({ where: { actorId: owner.id } }), 1);
  await assert.rejects(guardedMigrate(db, validBackup), error => error instanceof MigrationStopped && error.counts.candidatas === 0);
  assert.equal(await db.auditLog.count({ where: { description: 'Migración de correo APREM.' } }), 38);

  const { prisma } = await import('../src/config/database.js'); authDb = prisma;
  const { loginUser } = await import('../src/modules/auth/auth.service.js');
  const login = await loginUser({ email: 'fixture0@aprem.morelos', password: 'SyntheticOnly123!', req: { ip: '127.0.0.1', get: () => undefined } });
  assert.equal(login.user.id, owner.id); assert.equal(login.user.role, 'ADMIN');
  console.log('PASS: 38/0 guard, expired/missing backup guard, collision guard, full rollback on audit failure, email-only update, preserved timestamps/hash/roles/state/history, actual login and repeat-run stop');
} catch {
  console.error('Isolated guarded migration validation failed'); process.exitCode = 1;
} finally {
  await authDb?.$disconnect(); await db?.$disconnect();
  if (created) await admin.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.$disconnect();
}
