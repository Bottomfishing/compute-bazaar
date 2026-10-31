import {it,expect} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDb,createUser} from '../server/db.js';
it('从 v3 升级会备份旧账户和流水，重复打开 v4 不改写数据',()=>{
  const dir=mkdtempSync(join(tmpdir(),'bazaar-v4-')),path=join(dir,'market.sqlite');let db=openDb(path);
  try{
    db.transaction(()=>createUser(db,'升级账户','fixture-hash')).immediate();db.exec('DROP TABLE order_restores;DROP TABLE order_archives;DELETE FROM schema_migrations WHERE version>=4;');db.pragma('user_version=3');db.close();rmSync(`${path}.before-v4.bak`);
    db=openDb(path);expect(db.pragma('user_version',{simple:true})).toBe(5);const snapshot=new Database(`${path}.before-v4.bak`,{readonly:true});try{expect(snapshot.pragma('user_version',{simple:true})).toBe(3);expect((snapshot.prepare('SELECT balance_cents FROM users').get() as {balance_cents:number}).balance_cents).toBe(10000);expect(snapshot.prepare('SELECT * FROM ledger').all()).toHaveLength(1);}finally{snapshot.close();}
    expect(db.prepare('SELECT * FROM order_archives').all()).toEqual([]);db.close();db=openDb(path);expect(db.prepare('SELECT * FROM ledger').all()).toHaveLength(1);expect(db.prepare('SELECT * FROM schema_migrations WHERE version=4').all()).toHaveLength(1);
  }finally{if(db.open)db.close();rmSync(dir,{recursive:true,force:true});}
});

