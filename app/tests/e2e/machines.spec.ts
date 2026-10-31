import {test,expect} from '@playwright/test';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
test('真实 mock CLI 接入：UI登记→心跳→挂牌→就绪计费→清理→停用',async({browser})=>{
  test.setTimeout(60000);
  const host=await browser.newContext(),renter=await browser.newContext();const a=await host.newPage(),b=await renter.newPage();const errors:string[]=[];for(const p of [a,b]){p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text());});}
  const stamp=Date.now();await host.request.post('/api/auth/register',{data:{nickname:`接机主${stamp}`,password:'mock-browser-password'}});await renter.request.post('/api/auth/register',{data:{nickname:`接租客${stamp}`,password:'mock-browser-password'}});
  let agent:ChildProcess|undefined;
  try{
    await a.goto('/machines');await a.getByLabel('机器名称').fill(`实验节点${stamp}`);await a.getByLabel('机房位置').fill('江苏 · 南京');await a.getByRole('button',{name:'登记并生成接入凭据 ↗'}).click();await expect(a.getByRole('dialog')).toBeVisible();const token=await a.getByLabel('接入凭据').inputValue();const m=await host.request.get('/api/machines/mine');const machine=(await m.json())[0] as {id:number};
    await a.getByRole('button',{name:'我已保存，关闭弹窗'}).click();
    agent=spawn(process.execPath,['--import','tsx','agent/mock.ts'],{env:{...process.env,AGENT_SERVER:'http://127.0.0.1:3011',AGENT_MACHINE_ID:String(machine.id),AGENT_TOKEN:token,MOCK_GPU_COUNT:'2',MOCK_GPU_MODEL:'RTX 4090',MOCK_START_DELAY_MS:'1200'},stdio:'ignore',windowsHide:true});
    const card=a.locator('.my-listing').filter({hasText:`实验节点${stamp}`});await expect(card.locator('.status')).toHaveText('在线');await card.getByRole('button',{name:'发布机器挂牌 ↗'}).click();await expect(card).toContainText('已绑定 LOT');await a.screenshot({path:'../docs/shots/05-machines.png',fullPage:true,animations:'disabled'});
    const own=await host.request.get('/api/listings/mine');const listing=(await own.json())[0] as {id:number};await b.goto('/');await b.getByRole('button',{name:`租用 LOT ${String(listing.id).padStart(3,'0')}`}).click();await b.getByRole('button',{name:'确认预付并开始租用 ↗'}).click();await expect(b.locator('.order-card .status')).toHaveText('租用中');await b.getByRole('button',{name:'查看执行记录'}).click();await expect(b.getByRole('region',{name:'执行记录'})).toContainText('模拟环境已就绪，开始计费');await b.screenshot({path:'../docs/shots/06-agent-order.png',fullPage:true,animations:'disabled'});
    await b.getByRole('button',{name:'提前结束并结算 ↗'}).click();await b.getByRole('button',{name:'确认结束并结算',exact:true}).click();await expect(b.locator('tbody')).toContainText('资源已释放');
    await a.setViewportSize({width:390,height:844});await a.reload();await expect(a.locator('.my-listing').filter({hasText:`实验节点${stamp}`})).toBeVisible();expect(await a.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await a.screenshot({path:'../docs/shots/mobile-machines.png',fullPage:true,animations:'disabled'});await a.locator('.my-listing').filter({hasText:`实验节点${stamp}`}).getByRole('button',{name:'停用机器'}).click();await a.getByRole('button',{name:'确认操作',exact:true}).click();await expect(a.locator('.my-listing').filter({hasText:`实验节点${stamp}`}).locator('.status')).toHaveText('已停用');expect(errors).toEqual([]);
  }finally{if(agent&&agent.exitCode===null){const ended=once(agent,'exit');agent.kill();await ended;}await host.close();await renter.close();}
});
