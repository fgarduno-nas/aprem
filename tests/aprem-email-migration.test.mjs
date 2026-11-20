import test from 'node:test';
import assert from 'node:assert/strict';
import { planEmailMigration, migrateEmails } from '../backend/scripts/migrate-aprem-emails.js';

test('exact suffix, preserved local part, idempotence and case-insensitive collisions', () => {
  const users = [{id:'1',email:'Name@egem.morelos'}, {id:'2',email:'other@egem.morelos.example'}, {id:'3',email:'old@EGEM.MORELOS'}];
  assert.deepEqual(planEmailMigration(users), {changes:[{id:'1',before:'Name@egem.morelos',after:'Name@aprem.morelos'}],collisions:0});
  assert.equal(planEmailMigration([{id:'1',email:'name@aprem.morelos'}]).changes.length,0);
  assert.equal(planEmailMigration([...users,{id:'4',email:'name@aprem.morelos'}]).collisions,1);
});

test('dry-run never writes; collision aborts before updates', async () => {
  let writes = 0;
  const tx = { $executeRawUnsafe: async () => {}, user: {
    findMany: async () => [{id:'1',email:'a@egem.morelos'},{id:'2',email:'a@aprem.morelos'}],
    update: async () => { writes++; },
  }};
  const prisma = { $transaction: async (fn) => fn(tx) };
  assert.equal((await migrateEmails(prisma)).collisions,1);
  await assert.rejects(migrateEmails(prisma,{apply:true}), /COLLISIONS_DETECTED/);
  assert.equal(writes,0);
});
