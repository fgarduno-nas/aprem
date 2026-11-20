import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import { migrateEmails } from './migrate-aprem-emails.js';
dotenv.config({path:new URL('../.env',import.meta.url)});
const url = new URL(process.env.DATABASE_URL);
assert.ok(['localhost','127.0.0.1'].includes(url.hostname),'Only isolated local PostgreSQL is allowed');
const databaseName = `aprem_validation_${Date.now()}`;
const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
const admin = new PrismaClient({datasourceUrl:adminUrl.href});
let created = false; let db;
try {
  await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`); created = true;
  url.pathname = `/${databaseName}`;
  process.env.DATABASE_URL = url.href;
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'isolated-aprem-validation-secret';
  process.env.DEFAULT_ADMIN_EMAIL = 'validation@example.invalid';
  process.env.DEFAULT_ADMIN_PASSWORD = 'ValidationOnly123!';
  process.env.DEFAULT_ADMIN_NAME = 'Validation';
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js','migrate','deploy'], {cwd:new URL('..',import.meta.url),env:process.env,stdio:'pipe'});
  db = new PrismaClient({datasourceUrl:url.href});
  const {hashPassword} = await import('../src/shared/utils/password.js');
  const {loginUser} = await import('../src/modules/auth/auth.service.js');
  const {prisma} = await import('../src/config/database.js');
  try {
    const role = await db.role.create({data:{code:'ADMIN',name:'Validation'}});
    const hash = await hashPassword('IsolatedPassword123!');
    const user = await db.user.create({data:{name:'Synthetic',email:'synthetic@egem.morelos',passwordHash:hash,roleId:role.id}});
    await db.auditLog.create({data:{actorId:user.id,entityType:'User',entityId:user.id,action:'USER_CREATED',description:'Synthetic history'}});
    const layer = await db.layer.create({data:{title:'Synthetic',slug:'synthetic',createdById:user.id,status:'published'}});
    await db.approvalHistory.create({data:{layerId:layer.id,actorId:user.id,fromStatus:'approved',toStatus:'published'}});
    const before = await db.user.findUnique({where:{id:user.id}});
    assert.equal((await migrateEmails(db)).candidates,1);
    assert.equal((await db.user.findUnique({where:{id:user.id}})).email,user.email);
    assert.equal((await migrateEmails(db,{apply:true})).updated,1);
    const after = await db.user.findUnique({where:{id:user.id}});
    for (const key of ['id','passwordHash','roleId','isActive','createdAt','lastLoginAt','deletedAt','municipality']) assert.deepEqual(after[key],before[key]);
    const result = await loginUser({email:'synthetic@aprem.morelos',password:'IsolatedPassword123!',req:{ip:"127.0.0.1",get:()=>undefined}});
    assert.equal(result.user.id,user.id); assert.equal(result.user.role,'ADMIN');
    assert.equal(await db.layer.count({where:{createdById:user.id}}),1);
    assert.equal(await db.approvalHistory.count({where:{actorId:user.id}}),1);
    assert.equal(await db.auditLog.count({where:{actorId:user.id,description:'Synthetic history'}}),1);
    await assert.rejects(loginUser({email:'synthetic@egem.morelos',password:'IsolatedPassword123!',req:{ip:'127.0.0.1',get:()=>undefined}}), /Credenciales/);
    assert.equal((await migrateEmails(db,{apply:true})).updated,0);
    await db.user.create({data:{name:'Synthetic old',email:'collision@egem.morelos',passwordHash:hash,roleId:role.id}});
    await db.user.create({data:{name:'Synthetic new',email:'collision@aprem.morelos',passwordHash:hash,roleId:role.id}});
    assert.equal((await migrateEmails(db)).collisions,1);
    await assert.rejects(migrateEmails(db,{apply:true}), /COLLISIONS_DETECTED/);
    assert.equal(await db.user.count({where:{email:'collision@egem.morelos'}}),1);
    assert.equal(await db.auditLog.count({where:{description:'Migración de correo APREM.'}}),1);
    console.log('PASS: isolated PostgreSQL dry-run, migration, preserved identity/hash/role/state, actual login, idempotence, collision rollback and audit');
  } finally { await prisma.$disconnect(); }
} catch (error) {
  console.error('Isolated database validation failed:',error.code || error.name);
  process.exitCode=1;
} finally {
  if (db) await db.$disconnect();
  if (created) await admin.$executeRawUnsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.$disconnect();
}
