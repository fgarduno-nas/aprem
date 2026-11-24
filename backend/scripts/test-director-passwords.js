import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { buildAuditRecord } from '../src/shared/services/audit-record.js';
import { simulateRotation, rotatePasswords, RotationStopped } from '../../ops/director-passwords.mjs';

const url = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), 'Only isolated local PostgreSQL');
const databaseName = `aprem_password_test_${crypto.randomBytes(8).toString('hex')}`;
const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
const admin = new PrismaClient({ datasourceUrl: adminUrl.href });
let created = false; let db; let authDb;
try {
  await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`); created = true;
  url.pathname = `/${databaseName}`;
  Object.assign(process.env, { DATABASE_URL: url.href, NODE_ENV: 'test', MAX_UPLOAD_SIZE_MB: '50', BCRYPT_SALT_ROUNDS: '10',
    JWT_SECRET: crypto.randomBytes(32).toString('hex'), DEFAULT_ADMIN_EMAIL: ['fixture', '@', 'example.invalid'].join(''),
    DEFAULT_ADMIN_PASSWORD: crypto.randomBytes(24).toString('base64url'), DEFAULT_ADMIN_NAME: 'Fixture' });
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { cwd: new URL('..', import.meta.url), env: process.env, stdio: 'pipe' });
  db = new PrismaClient({ datasourceUrl: url.href, log: [] });
  const { hashPassword, verifyPassword } = await import('../src/shared/utils/password.js');
  const { resetPasswordSchema } = await import('../src/modules/users/users.schemas.js');
  const library = { hashPassword, verifyPassword, buildAuditRecord,
    validPassword: value => resetPasswordSchema.shape.body.shape.password.safeParse(value).success && Buffer.byteLength(value, 'utf8') <= 72 };
  const previous = crypto.randomBytes(24).toString('base64url');
  const next = crypto.randomBytes(24).toString('base64url');
  const personal = crypto.randomBytes(24).toString('base64url');
  const identity = crypto.randomUUID();
  const validBackup = async () => ({ expiresAt: Date.now() + 3600000 });
  const roles = {};
  for (const code of ['DATA_PROVIDER', 'ADMIN', 'PUBLIC_USER']) roles[code] = await db.role.create({ data: { code, name: code } });
  const users = [];
  const fixtures = [
    ['DATA_PROVIDER', true, previous], ['DATA_PROVIDER', false, previous],
    ['DATA_PROVIDER', true, personal], ['DATA_PROVIDER', false, personal],
    ['DATA_PROVIDER', false, previous], ['ADMIN', true, previous], ['PUBLIC_USER', true, previous],
  ];
  for (let index = 0; index < fixtures.length; index++) {
    const [role, isActive, password] = fixtures[index];
    users.push(await db.user.create({ data: {
      email: ['fixture', index, '@', 'example.invalid'].join(''), name: 'Synthetic',
      passwordHash: await hashPassword(password), roleId: roles[role].id, isActive,
      deletedAt: index === 4 ? new Date('2026-01-01') : null,
    } }));
  }
  const originalAudit = await db.auditLog.create({ data: buildAuditRecord({ entityType: 'User', entityId: users[0].id, actorId: users[0].id, action: 'USER_CREATED', description: 'Synthetic history' }) });
  const layer = await db.layer.create({ data: { title: 'Synthetic', slug: 'synthetic', division: 'vulnerability', createdById: users[0].id } });
  await db.approvalHistory.create({ data: { layerId: layer.id, actorId: users[0].id, fromStatus: 'draft', toStatus: 'published' } });
  const snapshot = () => db.user.findMany({ orderBy: { id: 'asc' } });
  const before = await snapshot();
  const simulated = await simulateRotation(db, identity, previous, library);
  assert.deepEqual(simulated.summary, { estado: 'SIMULACION', directores_activos: 2, directores_inactivos: 3, con_anterior: 3, con_otra: 2, eliminados_incluidos: 1 });
  assert.deepEqual(await snapshot(), before);
  const stored = JSON.stringify(simulated.receipt);
  for (const sensitive of [previous, next, personal, ...before.map(user => user.passwordHash), ...before.map(user => user.email)]) assert.ok(!stored.includes(sensitive));

  const restore = async () => {
    for (const user of users) await db.$executeRaw`UPDATE "User" SET "passwordHash" = ${user.passwordHash}, "roleId" = ${user.roleId}, "isActive" = ${user.isActive} WHERE "id" = ${user.id}`;
  };
  await db.$executeRaw`UPDATE "User" SET "passwordHash" = ${await hashPassword(previous)} WHERE "id" = ${users[0].id}`;
  await assert.rejects(rotatePasswords(db, identity, simulated.receipt, previous, next, library, validBackup), error => error instanceof RotationStopped && error.reason === 'CAMBIO_DE_CANDIDATAS_REQUIERE_SIMULACION');
  await restore();
  await db.$executeRaw`UPDATE "User" SET "passwordHash" = ${await hashPassword(personal)} WHERE "id" = ${users[0].id}`;
  await db.$executeRaw`UPDATE "User" SET "passwordHash" = ${await hashPassword(previous)} WHERE "id" = ${users[2].id}`;
  await assert.rejects(rotatePasswords(db, identity, simulated.receipt, previous, next, library, validBackup), RotationStopped);
  await restore();
  await db.$executeRaw`UPDATE "User" SET "roleId" = ${roles.ADMIN.id} WHERE "id" = ${users[0].id}`;
  await assert.rejects(rotatePasswords(db, identity, simulated.receipt, previous, next, library, validBackup), RotationStopped);
  await restore();
  await assert.rejects(rotatePasswords(db, identity, simulated.receipt, previous, next, library, async () => false), RotationStopped);
  await assert.rejects(rotatePasswords(db, identity, { ...simulated.receipt, createdAt: new Date(Date.now() - 90000000).toISOString() }, previous, next, library, validBackup), RotationStopped);
  await assert.rejects(rotatePasswords(db, identity, simulated.receipt, previous, previous, library, validBackup), RotationStopped);
  await assert.rejects(rotatePasswords(db, identity, simulated.receipt, previous, next, library, async () => ({ expiresAt: Date.now() - 1 })), RotationStopped);
  assert.deepEqual(await snapshot(), before);

  await db.$executeRawUnsafe(`ALTER TABLE "AuditLog" ADD CONSTRAINT "director_test_reject" CHECK ((metadata->>'operation') IS DISTINCT FROM 'aprem-director-password-v1')`);
  await assert.rejects(rotatePasswords(db, identity, simulated.receipt, previous, next, library, validBackup));
  assert.deepEqual(await snapshot(), before);
  await db.$executeRawUnsafe('ALTER TABLE "AuditLog" DROP CONSTRAINT "director_test_reject"');

  const { signAccessToken, verifyAccessToken } = await import('../src/shared/utils/jwt.js');
  const token = signAccessToken({ sub: users[0].id, role: 'DATA_PROVIDER' });
  const applied = await rotatePasswords(db, identity, simulated.receipt, previous, next, library, validBackup);
  assert.equal(applied.summary.actualizadas, 3);
  const after = await snapshot();
  const ids = new Set(simulated.receipt.candidates.map(item => item.id));
  const independent = after.filter(user => ids.has(user.id)).map(user => user.passwordHash);
  assert.equal(new Set(independent).size, 3);
  for (const user of after) {
    const original = before.find(item => item.id === user.id);
    assert.deepEqual({ ...user, passwordHash: original.passwordHash }, original);
    if (ids.has(user.id)) { assert.ok(await verifyPassword(next, user.passwordHash)); assert.ok(!(await verifyPassword(previous, user.passwordHash))); }
    else assert.equal(user.passwordHash, original.passwordHash);
  }
  assert.deepEqual(await db.auditLog.findUnique({ where: { id: originalAudit.id } }), originalAudit);
  assert.equal(await db.layer.count({ where: { createdById: users[0].id } }), 1);
  assert.equal(await db.approvalHistory.count({ where: { actorId: users[0].id } }), 1);
  assert.equal(await db.auditLog.count({ where: { description: 'Contraseña de Director restablecida por transición APREM.' } }), 3);
  const auditText = JSON.stringify(await db.auditLog.findMany());
  for (const secret of [previous, next, personal, ...before.map(user => user.passwordHash), ...before.map(user => user.email)]) assert.ok(!auditText.includes(secret));
  assert.equal(verifyAccessToken(token).sub, users[0].id);
  await assert.rejects(rotatePasswords(db, identity, simulated.receipt, previous, next, library, validBackup), RotationStopped);

  const { prisma } = await import('../src/config/database.js'); authDb = prisma;
  const { loginUser } = await import('../src/modules/auth/auth.service.js');
  const request = { ip: '127.0.0.1', get: () => undefined };
  assert.equal((await loginUser({ email: users[0].email, password: next, req: request })).user.role, 'DATA_PROVIDER');
  await assert.rejects(loginUser({ email: users[0].email, password: previous, req: request }));
  assert.equal((await loginUser({ email: users[2].email, password: personal, req: request })).user.id, users[2].id);
  await assert.rejects(loginUser({ email: users[1].email, password: next, req: request }));

  const current = await db.user.findUnique({ where: { id: users[0].id } });
  await db.$executeRaw`UPDATE "User" SET "passwordHash" = ${await hashPassword(personal)} WHERE "id" = ${users[0].id}`;
  await assert.rejects(rotatePasswords(db, identity, applied.receipt, next, previous, library, validBackup, true), RotationStopped);
  await db.$executeRaw`UPDATE "User" SET "passwordHash" = ${current.passwordHash} WHERE "id" = ${users[0].id}`;
  const reverted = await rotatePasswords(db, identity, applied.receipt, next, previous, library, validBackup, true);
  assert.equal(reverted.summary.actualizadas, 3);
  for (const user of await snapshot()) {
    const original = before.find(item => item.id === user.id);
    if (ids.has(user.id)) { assert.ok(await verifyPassword(previous, user.passwordHash)); assert.ok(!(await verifyPassword(next, user.passwordHash))); }
    else assert.equal(user.passwordHash, original.passwordHash);
  }
  const fresh = await simulateRotation(db, identity, previous, library);
  let entered; const enteredPromise = new Promise(resolve => { entered = resolve; });
  let release; const hold = new Promise(resolve => { release = resolve; });
  const rotation = rotatePasswords(db, identity, fresh.receipt, previous, next, library, async () => { entered(); await hold; return validBackup(); });
  await enteredPromise;
  let writerFinished = false;
  const personalHash = await hashPassword(personal);
  const writer = db.user.update({ where: { id: users[0].id }, data: { passwordHash: personalHash } }).then(() => { writerFinished = true; });
  try { await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(writerFinished, false); }
  finally { release(); }
  await rotation; await writer;
  assert.equal((await db.user.findUnique({ where: { id: users[0].id } })).passwordHash, personalHash);
  console.log('PASS: read-only counts, independent salts, customized/Admin/Visitor untouched, inactive/deleted states, candidate/hash/role drift guards, backup/expiry guards, atomic rollback on audit failure, real login, existing JWT, guarded reversal, concurrent reset serialized');
} catch {
  console.error('Isolated director-password validation failed'); process.exitCode = 1;
} finally {
  await authDb?.$disconnect(); await db?.$disconnect();
  if (created) await admin.$executeRawUnsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.$disconnect();
}
