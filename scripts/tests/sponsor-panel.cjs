const {chromium}=require('../../tools/node_modules/playwright');
const path=require('path'),fs=require('fs'),assert=require('assert');
const {pathToFileURL}=require('url');
(async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 try {
 const page=await browser.newPage({viewport:{width:330,height:900}});const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(pathToFileURL(process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname,'../../src/index.html')).href);
 const head=page.locator('#sponsorToggle'),body=page.locator('#sponsorBody');
 assert.strictEqual(await head.count(),1,'Sponsor panel missing');
 assert.strictEqual(await body.isVisible(),false,'must start collapsed');
 await head.click();assert(await body.isVisible(),'click must expand');
 const declaration=fs.readFileSync(path.join(__dirname,'../../src/assets/sponsor/软件声明.txt'),'utf8').trim();
 assert.strictEqual((await page.locator('#sponsorDeclaration').innerText()).trim(),declaration);
 const imgs=page.locator('#sponsorBody img');assert.strictEqual(await imgs.count(),2);
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('#sponsorBody img')).every(i=>i.complete&&i.naturalWidth>0));
 for(const width of [260,330,600]){
  await page.setViewportSize({width,height:900});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow');
  const imageData=await imgs.evaluateAll(xs=>xs.map(i=>({w:i.clientWidth,h:i.clientHeight,nw:i.naturalWidth,nh:i.naturalHeight})));
  for(const i of imageData)assert(Math.abs(i.w/i.h-i.nw/i.nh)<0.01,'image aspect ratio changed');
 }
 await page.setViewportSize({width:330,height:900});
 await page.locator('#sponsorCard').screenshot({path:path.join(__dirname,'artifacts/sponsor-panel.png')});
 await head.click();assert(!await body.isVisible(),'second click must collapse');
 await head.focus();await page.keyboard.press('Enter');assert(await body.isVisible(),'Enter expands');
 await page.keyboard.press('Space');assert(!await body.isVisible(),'Space collapses');
 await page.reload();assert(!await body.isVisible(),'reload defaults collapsed');
 assert.deepStrictEqual(errors,[]);
 console.log('PASS: default collapsed, click/keyboard toggle, declaration, 2 images, 260/330/600px layout; no JS errors');
 }finally{await browser.close()}
})().catch(e=>{console.error('FAIL: '+e.message);process.exitCode=1});
