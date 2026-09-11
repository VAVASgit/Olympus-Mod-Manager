const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),os=require('os');
const {inspect,readPayloadTable,toLua}=require('../manager/javascripts/catalog-lua');
const {scan}=require('../manager/javascripts/unitcatalog');
const store=require('../manager/javascripts/catalog-store');
function fixture() {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'olympus-catalog-test-'));
    const saved=path.join(root,'Saved'), dcs=path.join(root,'DCS'), runtime=path.join(saved,'Mods','Services','Olympus');
    const write=(p,text)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,typeof text==='string'?text:JSON.stringify(text));};
    for(const name of ['aircraftdatabase','helicopterdatabase','groundunitdatabase','navyunitdatabase','mods']) write(path.join(runtime,'databases','units',name+'.json'),{});
    write(path.join(runtime,'scripts','catalog.lua'),'-- runtime stub');write(path.join(dcs,'autoupdate.cfg'),{version:'test'});
    return {root,saved,dcs,runtime,write,scan:()=>scan({savedGames:saved,dcsRoot:dcs})};
}
function plane(id='F-22A') {return `local u={Name=${toLua(id)},DisplayName='Test aircraft',shape_table_data={{name='Wrong nested name'}},attribute={'Planes'}}; add_aircraft(u)`;}
function payload(id='F-22A',name='CAP',clsid='{CUSTOM}') {return `local p={unitType=${toLua(id)},name='Display only',payloads={{name=${toLua(name)},displayName='Friendly caption',pylons={{num=2,CLSID=${toLua(clsid)},settings={delay=2}}},tasks={[1]=11}}}};return p`;}
test('unit registration does not mistake nested names or sensors for units',()=>{
    const r=inspect(plane()+`;sensor={Name='Sensor',category=0}; declare_sensor(sensor)`);
    assert.deepEqual(r.units.map(u=>u.id),['F-22A']);
});
test('one tech package supports aircraft, helicopters, ships and ground units',()=>{
    const r=inspect(`add_aircraft({Name='A'});add_helicopter({Name='H'});add_ship({Name='S'});GT={Name='G',attribute={'Ground Units'}};GT_t.add_GT(GT)`);
    assert.deepEqual(r.units.map(u=>u.category),['Aircraft','Helicopter','NavyUnit','GroundUnit']);
});
test('payload uses unitType and internal name, preserves CLSID and per-pylon settings',()=>{
    const p=readPayloadTable(inspect(payload()).payloadTables[0],'test');
    assert.equal(p.id,'F-22A');assert.equal(p.presets[0].code,'CAP');assert.equal(p.presets[0].name,'Friendly caption');
    assert.deepEqual(p.presets[0].roles,['CAP']);assert.equal(p.presets[0].payload.pylons[2].CLSID,'{CUSTOM}');assert.equal(p.presets[0].payload.pylons[2].settings.delay,2);
});
test('duplicate pylon slots are rejected',()=>{
    const p=readPayloadTable({unitType:'F',payloads:[{name:'bad',pylons:[{num:1,CLSID:'A'},{num:1,CLSID:'B'}]}]},'test');
    assert.equal(p.presets.length,0);assert.equal(p.issues.length,1);
});
test('Lua strings keep comment markers, braces, Unicode and quotes',()=>{
    const id='Aircraft -- { " Ø В';assert.equal(inspect(plane(id)).units[0].id,id);
    assert.match(toLua({settings:['a','b']}),/\[1\]="a",\[2\]="b"/);
});
test('never executes Lua or counts a sensor table as a spawnable unit',()=>{
    const r=inspect(`os.execute('malicious'); local x={Name='radar',category=1};declare_sensor(x)`);assert.equal(r.units.length,0);
    assert.throws(()=>inspect('\x1bLua'),/Compiled Lua/);
});
test('scan merges package and user presets by unit and code without cross-unit fallback',()=>{
    const f=fixture(),pkg=path.join(f.saved,'Mods','tech','Mixed');
    f.write(path.join(pkg,'units.lua'),plane()+`;add_ship({Name='Ship'})`);
    f.write(path.join(pkg,'UnitPayloads','F.lua'),payload());
    f.write(path.join(f.saved,'MissionEditor','UnitPayloads','F.lua'),payload('F-22A','CAP','{PLAYER}'));
    const r=f.scan(),a=r.inventory.find(u=>u.id==='F-22A'),ship=r.inventory.find(u=>u.id==='Ship');
    assert.equal(a.source,'mod');assert.equal(a.presets[0].payload.pylons[2].CLSID,'{PLAYER}');assert.equal(ship.category,'NavyUnit');assert.equal(ship.presets.length,0);
});
test('fresh DCS snapshot adds compiled native units and reports stale snapshots',()=>{
    const f=fixture();f.write(path.join(f.saved,'Olympus','Catalog','dcs-catalog.json'),{schemaVersion:1,dcsRoot:f.dcs,version:'test',units:[{id:'La-7',category:'Aircraft',displayName:'La-7'}]});
    assert.equal(f.scan().inventory[0].era,'WW2');assert.equal(f.scan().snapshotUsable,true);
    f.write(path.join(f.dcs,'autoupdate.cfg'),{version:'new'});assert.equal(f.scan().inventory.length,0);assert.equal(f.scan().snapshotUsable,false);
});
test('runtime snapshot preserves WWII package era metadata for B-17G',()=>{
    const f=fixture(),pkg=path.join(f.dcs,'CoreMods','WWII Units','WWII Assets Pack');
    f.write(path.join(pkg,'units.lua'),plane('B-17G'));
    f.write(path.join(f.saved,'Olympus','Catalog','dcs-catalog.json'),{schemaVersion:1,dcsRoot:f.dcs,version:'test',units:[{id:'B-17G',category:'Aircraft',displayName:'B-17G'}]});
    const b=f.scan().inventory.find(u=>u.id==='B-17G');
    assert.equal(b.era,'WW2');
});
test('runtime pylon validation skips unknown modded stores',()=>{
    const f=fixture();f.write(path.join(f.saved,'Olympus','Catalog','dcs-catalog.json'),{schemaVersion:1,dcsRoot:f.dcs,version:'test',units:[{id:'F-22A',category:'Aircraft',displayName:'F',allowedPylons:{2:['{OTHER}']}}]});
    f.write(path.join(f.saved,'MissionEditor','UnitPayloads','F.lua'),payload());
    assert.equal(f.scan().inventory[0].presets.length,0);assert.match(f.scan().inventory[0].issues.join(' '),/not supported/);
});
test('import preserves manual entries and loadouts, supports idempotence and restoration',()=>{
    const f=fixture(),db=path.join(f.runtime,'databases','units','mods.json');
    const original={'Manual':{category:'aircraft',label:'Keep this',enabled:false},'F-22A':{category:'aircraft',label:'My label',loadouts:[{code:'CAP',name:'My manual preset',enabled:false}],liveries:{mine:{name:'Mine'}}}};
    f.write(db,original);f.write(path.join(f.saved,'Mods','aircraft','F','unit.lua'),plane());f.write(path.join(f.saved,'Mods','aircraft','F','UnitPayloads','F.lua'),payload('F-22A','NEW'));
    const r=store.importUnits(f.scan(),['F-22A']);assert.equal(r.count,1);
    const changed=JSON.parse(fs.readFileSync(db));assert.deepEqual(changed.Manual,original.Manual);assert.equal(changed['F-22A'].label,'My label');assert.deepEqual(changed['F-22A'].loadouts[0],original['F-22A'].loadouts[0]);
    assert.equal(changed['F-22A'].loadouts[1].code,'NEW');assert.equal(f.scan().inventory[0].status,'Up to date');
    const generated=inspect(fs.readFileSync(path.join(f.runtime,'scripts','catalog_generated.lua'),'utf8'));assert.ok(generated);
    assert.equal(store.importUnits(f.scan(),['F-22A']).backup,null);
    store.restoreLast(f.saved);assert.deepEqual(JSON.parse(fs.readFileSync(db)),original);
});
test('official WWII ground units become visible when explicitly imported',()=>{
    const f=fixture(),db=path.join(f.runtime,'databases','units','groundunitdatabase.json');
    f.write(db,{'flak30':{category:'groundunit',label:'AAA Flak 38 20mm',enabled:false}});
    f.write(path.join(f.saved,'Olympus','Catalog','dcs-catalog.json'),{schemaVersion:1,dcsRoot:f.dcs,version:'test',units:[{id:'flak30',category:'GroundUnit',displayName:'AAA Flak 38 20mm',era:'WW2'}]});
    const result=f.scan(); assert.equal(result.inventory[0].era,'WW2');
    store.importUnits(result,['flak30']);
    assert.equal(JSON.parse(fs.readFileSync(db))['flak30'].enabled,true);
});
test('No dismisses only the current fingerprint; changed presets are offered again',()=>{
    const f=fixture(),unit=path.join(f.saved,'Mods','aircraft','F','unit.lua');f.write(unit,plane());
    store.ignoreUnits(f.scan(),['F-22A']);assert.equal(f.scan().inventory[0].ignored,true);
    f.write(path.join(f.saved,'MissionEditor','UnitPayloads','F.lua'),payload());assert.equal(f.scan().inventory[0].ignored,false);
});
test('restore protects edits made after import',()=>{
    const f=fixture();f.write(path.join(f.saved,'Mods','aircraft','F','unit.lua'),plane());store.importUnits(f.scan(),['F-22A']);
    f.write(path.join(f.runtime,'databases','units','mods.json'),{later:'edit'});assert.throws(()=>store.restoreLast(f.saved),/Files changed/);
});
test('duplicate IDs across native and mod databases are preserved and reported',()=>{
    const f=fixture();f.write(path.join(f.runtime,'databases','units','aircraftdatabase.json'),{'F-22A':{category:'aircraft'}});f.write(path.join(f.saved,'Mods','tech','F','unit.lua'),plane());
    assert.equal(f.scan().inventory[0].conflict,true);assert.deepEqual(store.importUnits(f.scan(),['F-22A']).skipped,['F-22A']);
});
test('bad database JSON blocks import instead of replacing user data',()=>{
    const f=fixture();f.write(path.join(f.runtime,'databases','units','mods.json'),'{bad');assert.throws(()=>f.scan(),/Cannot read/);
});
test('write failure rolls back completed files',()=>{
    const f=fixture(),a=path.join(f.saved,'a.json'),b=path.join(f.saved,'b.json');f.write(a,'before');f.write(b,'before');
    const rename=fs.renameSync;let failed=false;
    fs.renameSync=(src,dest)=>{if(dest===b&&!failed){failed=true;throw new Error('simulated write failure');}return rename(src,dest);};
    try {assert.throws(()=>store.commit(f.saved,new Map([[a,'after'],[b,'after']]),'test'),/rolled back/);}finally{fs.renameSync=rename;}
    assert.equal(fs.readFileSync(a,'utf8'),'before');assert.equal(fs.readFileSync(b,'utf8'),'before');
});
