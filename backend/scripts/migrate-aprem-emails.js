import { pathToFileURL } from 'node:url';

export function planEmailMigration(users) {
  const changes = users.filter((user) => user.email.endsWith('@egem.morelos'))
    .map((user) => ({ id: user.id, before: user.email, after: user.email.slice(0, -'@egem.morelos'.length) + '@aprem.morelos' }));
  const normalized = new Map();
  for (const user of users) {
    const key = user.email.toLowerCase();
    normalized.set(key, [...(normalized.get(key) || []), user.id]);
  }
  const targets = new Set();
  let collisions = 0;
  for (const change of changes) {
    const target = change.after.toLowerCase();
    if (normalized.has(target) || targets.has(target)) collisions += 1;
    targets.add(target);
  }
  return { changes, collisions };
}

export async function migrateEmails(prisma, { apply = false } = {}) {
  return prisma.$transaction(async (tx) => {
    // Prevent concurrent account creation/update between preflight and updates.
    if (apply) await tx.$executeRawUnsafe('LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE');
    const users = await tx.user.findMany({ select: { id: true, email: true } });
    const { changes, collisions } = planEmailMigration(users);
    const report = { candidates: changes.length, collisions, updated: 0, mode: apply ? 'apply' : 'dry-run' };
    if (collisions) {
      if (apply) throw new Error('COLLISIONS_DETECTED');
      return report;
    }
    if (apply) for (const change of changes) {
      await tx.user.update({ where: { id: change.id }, data: { email: change.after } });
      await tx.auditLog.create({ data: {
        entityType: 'User', entityId: change.id, action: 'USER_UPDATED',
        description: 'Migración de correo APREM.',
        metadata: { migration: 'aprem-email-v1', previousEmail: change.before, newEmail: change.after },
      } });
      report.updated += 1;
    }
    return report;
  }, { isolationLevel: 'Serializable', timeout: 60000 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--apply', '--dry-run'].includes(arg)) || args.length > 1) {
    console.error('Uso: node scripts/migrate-aprem-emails.js [--dry-run|--apply]');
    process.exitCode = 1;
  } else {
    // Load the same backend .env as the application, independent of shell cwd.
    const dotenv = await import('dotenv');
    dotenv.config({ path: new URL('../.env', import.meta.url) });
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    try {
      const report = await migrateEmails(prisma, { apply: args.includes('--apply') });
      console.log(JSON.stringify(report));
      if (report.collisions) process.exitCode = 2;
    } catch {
      // Do not print Prisma errors: they may include account data or connection details.
      console.error('Migración cancelada sin cambios. Verifica conexión, permisos y colisiones mediante --dry-run.');
      process.exitCode = 1;
    } finally { await prisma.$disconnect(); }
  }
}
