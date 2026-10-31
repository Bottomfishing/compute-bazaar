import { openDb } from './db.js';
import { seed } from './app.js';
const db=openDb(process.env.DB_PATH||'./data/market.sqlite');seed(db);db.close();process.stdout.write('演示挂牌已准备好；已有数据不会覆盖。\n');
