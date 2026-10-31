import {test,expect} from '@playwright/test';
import {mkdirSync} from 'node:fs';
test('双会话挂牌→租用→结算→双方钱包，移动端与控制台检查',async({browser})=>{
  mkdirSync('../docs/shots',{recursive:true});
  const provider=await browser.newContext(),renter=await browser.newContext();const a=await provider.newPage(),b=await renter.newPage();const errors:string[]=[];
  for(const p of [a,b]){p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text());});}
  await a.goto('/');await expect(a.getByRole('heading',{name:'在售算力'})).toBeVisible();
  await a.screenshot({path:'../docs/shots/01-market-desktop.png',fullPage:true,animations:'disabled'});
  const suffix=Date.now().toString();
  async function register(page:typeof a,name:string){await page.getByRole('button',{name:/登录 \/ 登记入市/}).click();await page.getByRole('button',{name:'还没有账户？登记入市'}).click();await page.getByLabel('昵称',{exact:true}).fill(name);await page.getByLabel('密码',{exact:true}).fill('browser-test-password');await page.getByRole('button',{name:'创建账户，领取体验额度 ↗'}).click();await expect(page.getByRole('dialog')).toHaveCount(0);}
  await register(a,`机主${suffix}`);await a.getByRole('link',{name:'02 我要出租'}).click();await a.getByLabel('机房位置').fill(`南京${suffix}`);await a.getByLabel('挂牌备注').fill('双窗口验收挂牌');await a.getByRole('button',{name:'挂到市场 ↗'}).click();await expect(a.getByText(`南京${suffix} · 2 / 2 卡可用`)).toBeVisible();await a.screenshot({path:'../docs/shots/02-host.png',fullPage:true,animations:'disabled'});
  await b.goto('/');await register(b,`租客${suffix}`);const card=b.locator('.listing-card').filter({hasText:`南京${suffix}`});await card.getByRole('button',{name:/租用 LOT/}).click();await b.getByLabel('租用小时').fill('2');await expect(b.locator('.prepay')).toContainText('4.00');await b.getByRole('button',{name:'确认预付并开始租用 ↗'}).click();await expect(b.getByRole('heading',{name:'进行中的租用'})).toBeVisible();await expect(b.locator('.countdown strong')).toHaveText(/01:59:\d\d/);await b.screenshot({path:'../docs/shots/03-orders.png',fullPage:true,animations:'disabled'});
  await b.getByRole('button',{name:'提前结束并结算 ↗'}).click();await b.getByRole('button',{name:'确认结束并结算',exact:true}).click();await expect(b.locator('tbody')).toContainText('已结算');await b.getByRole('link',{name:'04 钱包账本'}).click();await expect(b.locator('.wallet-main strong')).toHaveText('¥99.97');await b.screenshot({path:'../docs/shots/04-wallet.png',fullPage:true,animations:'disabled'});
  await a.getByRole('link',{name:'04 钱包账本'}).click();await expect(a.getByRole('cell',{name:'供给收入',exact:false})).toBeVisible();await expect(a.locator('.wallet-main strong')).toHaveText('¥100.03');
  for(const path of ['/','/host','/orders','/wallet']){await b.setViewportSize({width:390,height:844});await b.goto(path);await expect(b.locator('main')).toBeVisible();await expect.poll(()=>b.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await b.screenshot({path:`../docs/shots/mobile-${path==='/'?'market':path.slice(1)}.png`,fullPage:true,animations:'disabled'});}
  expect(errors).toEqual([]);await provider.close();await renter.close();
});

