import {it,expect} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDb,createUser} from '../server/db.js';
it('v4 升 v5 前备份，账户、流水和归档表不变，重复启动只应用一次迁移',()=>{
  const dir=mkdtempSync(join(tmpdir(),'bazaar-v5-')),path=join(dir,'market.sqlite');let db=openDb(path);
  try{
    createUser(db,'恢复升级账户','hash');db.exec('DROP TABLE order_restores;DELETE FROM schema_migrations WHERE version=5');db.pragma('user_version=4');const users=db.prepare('SELECT * FROM users').all(),ledger=db.prepare('SELECT * FROM ledger').all();db.close();rmSync(`${path}.before-v5.bak`);
    db=openDb(path);expect(db.pragma('user_version',{simple:true})).toBe(5);expect(db.prepare('SELECT * FROM users').all()).toEqual(users);expect(db.prepare('SELECT * FROM ledger').all()).toEqual(ledger);expect(db.prepare('SELECT * FROM order_archives').all()).toEqual([]);
    const snapshot=new Database(`${path}.before-v5.bak`,{readonly:true});try{expect(snapshot.pragma('user_version',{simple:true})).toBe(4);expect(snapshot.prepare('SELECT * FROM users').all()).toEqual(users);expect(snapshot.prepare('SELECT * FROM ledger').all()).toEqual(ledger);}finally{snapshot.close();}
    db.close();db=openDb(path);expect(db.prepare('SELECT * FROM schema_migrations WHERE version=5').all()).toHaveLength(1);expect(db.prepare('PRAGMA quick_check').get()).toEqual({quick_check:'ok'});
  }finally{if(db.open)db.close();rmSync(dir,{recursive:true,force:true});}
});
