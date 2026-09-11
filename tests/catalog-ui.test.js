const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),vm=require('vm');
const ejs=require('../manager/node_modules/ejs');
const managerDir=path.resolve(__dirname,'../manager');
function controller() {
    let ignored=null;
    class Page {constructor(manager){this.manager=manager;this.options={};this.shows=0;} show(){this.shows++;this.manager.activePage=this;} hide(){this.hidden=true;}}
    const previous={show(){manager.activePage=previous;},hide(){}};
    const manager={options:{},activePage:previous,getInstances:()=>[{folder:'instance',installed:true,name:'DCS'}]};
    const module={exports:{}};
    vm.runInNewContext(fs.readFileSync(path.join(managerDir,'javascripts/catalog-ui.js'),'utf8'),{module,__dirname:path.join(managerDir,'javascripts'),setTimeout,clearTimeout,require:name=>{
        if(name==='./managerpage')return Page;if(name==='@electron/remote')return {dialog:{},shell:{}};
        if(name==='./catalog-store')return {ignoreUnits:(r,ids)=>ignored=ids};
        if(name==='./unitcatalog')return {readJson:()=>null};return require(name);
    }});
    const ui=new module.exports(manager);return {ui,manager,previous,getIgnored:()=>ignored};
}
test('Back to Manager stays closed after action finally runs',async()=>{
    const {ui,manager,previous}=controller();ui.open();const shows=ui.page.shows;
    await ui.action('close');assert.equal(ui.visible,false);assert.equal(ui.page.shows,shows);assert.equal(manager.activePage,previous);
});
test('startup scans once per Manager launch, not when the page opens',async()=>{
    const {ui}=controller();let scans=0;ui.scanFolder=async()=>{scans++;return {inventory:[]};};
    await ui.start();ui.open();ui.open();await ui.start();assert.equal(scans,1);
});
test('Later does not persist a dismissal and the next launch asks again',async()=>{
    const c=controller(),result={inventory:[{id:'New',source:'dcs',status:'New unit'}]};c.ui.scanFolder=async()=>result;
    await c.ui.start();assert.equal(c.ui.prompt.newCount,1);await c.ui.action('later');assert.equal(c.getIgnored(),null);assert.equal(c.ui.prompt,null);
    const next=controller();next.ui.scanFolder=async()=>result;await next.ui.start();assert.equal(next.ui.prompt.newCount,1);
});
test('No persists exactly the offered versions',async()=>{
    const c=controller();c.ui.scanFolder=async()=>({inventory:[{id:'A',source:'dcs',status:'New unit'},{id:'B',source:'mod',status:'New unit'}]});
    await c.ui.start();await c.ui.action('no');assert.equal(JSON.stringify(c.getIgnored()),JSON.stringify(['A']));
});
test('busy catalog rejects repeated actions',async()=>{
    const {ui}=controller();ui.busy=true;ui.source='mod';await ui.action('source','dcs');assert.equal(ui.source,'mod');
});
test('catalog EJS renders data safely and includes all required controls',()=>{
    const source=fs.readFileSync(path.join(managerDir,'ejs/catalog.ejs'),'utf8');
    const html=ejs.render(source,{catalog:{instances:[],source:'mod',result:{inventory:[{id:'<script>alert(1)</script>',displayName:'<img onerror=alert(1)>',category:'Aircraft',source:'mod',package:'Test',presets:[],liveries:{},issues:[],status:'New unit'}],issues:[]}}});
    assert.ok(!html.includes('<img onerror='));assert.ok(html.includes('&lt;img'));
    for(const label of ['Scan for new units &amp; mods','Import selected units','Restore last import','DCS units &amp; updates'])assert.ok(html.includes(label),label);
});
test('catalog installer preserves old databases while keeping new official entries',()=>{
    const os=require('os'),root=fs.mkdtempSync(path.join(os.tmpdir(),'olympus-install-test-')),runtime=path.join(root,'Mods/Services/Olympus'),db=path.join(runtime,'databases/units/aircraftdatabase.json');
    fs.mkdirSync(path.dirname(db),{recursive:true});fs.mkdirSync(path.join(runtime,'scripts'),{recursive:true});fs.writeFileSync(db,JSON.stringify({old:{label:'Custom'}}));fs.writeFileSync(path.join(runtime,'scripts','mods.lua'),'-- manual\n');
    const install=require('../manager/javascripts/catalog-install');install.preserve(root);fs.writeFileSync(db,JSON.stringify({old:{label:'Default'},new:{label:'New default'}}));install.restore(root);
    assert.deepEqual(JSON.parse(fs.readFileSync(db)),{old:{label:'Custom'},new:{label:'New default'}});
    assert.match(fs.readFileSync(path.join(runtime,'scripts','mods.lua'),'utf8'),/manual[\s\S]*catalog bridge/);
});
