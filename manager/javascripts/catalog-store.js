const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATABASES, readJson, hash } = require('./unitcatalog');
const { toLua } = require('./catalog-lua');
function paths(savedGames) { return { data:path.join(savedGames,'Olympus','Catalog'), runtime:path.join(savedGames,'Mods','Services','Olympus') }; }
function atomic(file, contents) {
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const temp=file+'.'+crypto.randomUUID()+'.tmp';
    try { fs.writeFileSync(temp,contents); fs.renameSync(temp,file); } finally { if(fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function locked(savedGames, fn) {
    const {data}=paths(savedGames); fs.mkdirSync(data,{recursive:true});
    const lock=path.join(data,'write.lock'); let fd;
    try { fd=fs.openSync(lock,'wx'); } catch { throw new Error('Another catalog operation is active. If Manager crashed, close all Manager windows and remove Olympus/Catalog/write.lock.'); }
    try { return fn(); } finally {fs.closeSync(fd);fs.unlinkSync(lock);}
}
function commit(savedGames, files, label) {
    const {data}=paths(savedGames), backup=path.join(data,'Backups',new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID().slice(0,8));
    const writes=[...files].filter(([file,content])=>!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==content);
    if(!writes.length) return null;
    fs.mkdirSync(backup,{recursive:true}); const manifest={label,createdAt:new Date().toISOString(),files:[]};
    for(const [file,content] of writes) {
        const relative=path.relative(savedGames,file);
        if(relative.startsWith('..')||path.isAbsolute(relative)) throw new Error('Refusing a catalog write outside this Saved Games instance.');
        const exists=fs.existsSync(file), before=exists?fs.readFileSync(file):null, index=manifest.files.length;
        if(before) fs.writeFileSync(path.join(backup,index+'.bak'),before);
        manifest.files.push({relative,existed:exists,afterHash:hash(content),backup:index+'.bak'});
    }
    atomic(path.join(backup,'manifest.json'),JSON.stringify(manifest,null,2));
    const completed=[];
    try { for(let i=0;i<writes.length;i++) { atomic(...writes[i]); completed.push(i); } }
    catch(error) {
        for(const i of completed.reverse()) { const record=manifest.files[i],file=writes[i][0]; if(record.existed) atomic(file,fs.readFileSync(path.join(backup,record.backup))); else fs.unlinkSync(file); }
        throw new Error(`Import rolled back: ${error.message}. Backup: ${backup}`);
    }
    atomic(path.join(data,'last-backup.json'),JSON.stringify({backup}));
    return backup;
}
function buildEntry(u) {
    const air=['Aircraft','Helicopter'].includes(u.category);
    return {name:u.id,label:u.displayName,shortLabel:u.id.replace(/\s/g,'').slice(0,8),category:u.category.toLowerCase(),
        coalition:'blue',era:u.era||'Modern',type:({GroundUnit:'Ground Unit',NavyUnit:'Naval Unit'})[u.category]||u.category,
        enabled:true,filename:'',description:'Imported from installed '+(u.source==='dcs'?'DCS content.':'mod content.'),
        abilities:'',canTargetPoint:false,canRearm:air,length:u.length||0,range:'Short',acquisitionRange:0,engagementRange:0,
        loadouts:[],liveries:{}};
}
function importUnits(result, ids) {
    return locked(result.savedGames,()=>{
        const {data,runtime}=paths(result.savedGames),dbDir=path.join(runtime,'databases','units');
        if(!fs.existsSync(path.join(runtime,'scripts','catalog.lua'))) throw new Error('Catalog runtime bridge is not installed for this instance. Install the matching Olympus catalog upgrade first.');
        const state=readJson(path.join(data,'state.json'),{managed:{},ignored:{},ownedPresets:{}});
        state.managed ||= {}; state.ignored ||= {}; state.ownedPresets ||= {};
        const generated=readJson(path.join(data,'generated.json'),{units:{},payloads:{}});
        const databases=Object.fromEntries(Object.values(DATABASES).concat('mods').map(name=>[name,readJson(path.join(dbDir,name+'.json'),{})]));
        const requested=new Set(ids), selected=result.inventory.filter(u=>requested.has(u.id));
        if(selected.length!==requested.size) throw new Error('The selection changed. Scan again before importing.');
        let count=0, payloadCount=0; const skipped=[], touched=new Set();
        for(const u of selected) {
            if(u.conflict) {skipped.push(u.id);continue;}
            const target=u.source==='mod'?'mods':DATABASES[u.category];
            if(!target) throw new Error(`Unknown category for ${u.id}`);
            const other=Object.entries(databases).find(([file,db])=>file!==target && Object.hasOwn(db,u.id));
            if(other) {skipped.push(u.id);continue;}
            const db=databases[target], prev=db[u.id];
            if(prev && prev.category!==u.category.toLowerCase()) {skipped.push(u.id);continue;}
            const entry=prev || buildEntry(u); entry.loadouts ||= []; entry.liveries ||= {};
            // Runtime-verified official WWII content is safe to expose, including
            // static AAA/flak pieces. The previous rule left those entries hidden.
            if (u.source === 'dcs' && u.runtimeVerified &&
                (u.category === 'Aircraft' || u.category === 'Helicopter' || u.category === 'NavyUnit' || u.era === 'WW2') &&
                (u.presets.length > 0 || u.era === 'WW2')) {
                entry.enabled = true;
            }
            if (u.era && !entry.era) entry.era = u.era;
            const owned=state.ownedPresets[u.id] ||= {};
            generated.units[u.id]=u.category; generated.payloads[u.id] ||= {};
            for(const p of u.presets) {
                const {payload,source,priority,...loadout}=p;
                const index=entry.loadouts.findIndex(x=>x.code===p.code);
                if(index<0 || owned[p.code]===hash(entry.loadouts[index])) {
                    if(index>=0) entry.loadouts[index]=loadout; else entry.loadouts.push(loadout);
                    owned[p.code]=hash(loadout);
                }
                const full={...payload};
                // DCS standard defaults only when the preset omits them. Do not alter CLSIDs or settings.
                full.fuel ??= Number.isFinite(u.fuel)?u.fuel:999999;
                full.gun ??= 100;
                full.ammo_type ??= 1;
                full.flare ??= u.countermeasures?.flare?.default || 0;
                full.chaff ??= u.countermeasures?.chaff?.default || 0;
                generated.payloads[u.id][p.code]=full; payloadCount++;
            }
            for(const [key,livery] of Object.entries(u.liveries)) if(!Object.hasOwn(entry.liveries,key)) entry.liveries[key]=livery;
            if(!prev && !entry.loadouts.length && ['Aircraft','Helicopter'].includes(u.category)) entry.loadouts.push({name:'Empty loadout',code:'',items:[],enabled:true,roles:['No task']});
            db[u.id]=entry;touched.add(target); state.managed[u.id]=u.fingerprint; delete state.ignored[u.id];count++;
        }
        const files=new Map([...touched].map(name=>[path.join(dbDir,name+'.json'),JSON.stringify(databases[name],null,2)]));
        files.set(path.join(data,'state.json'),JSON.stringify(state,null,2));
        files.set(path.join(data,'generated.json'),JSON.stringify(generated,null,2));
        files.set(path.join(runtime,'scripts','catalog_generated.lua'),'-- Generated by Olympus Manager. Do not edit.\nreturn '+toLua(generated)+'\n');
        const backup=commit(result.savedGames,files,'Import '+count+' unit records');
        return {count,payloadCount,skipped,backup};
    });
}
function ignoreUnits(result, ids) {
    return locked(result.savedGames,()=>{
        const file=path.join(paths(result.savedGames).data,'state.json'), state=readJson(file,{managed:{},ignored:{}}); state.ignored ||= {};
        for(const u of result.inventory) if(ids.includes(u.id)) state.ignored[u.id]=u.fingerprint;
        atomic(file,JSON.stringify(state,null,2));
    });
}
function restoreLast(savedGames) {
    return locked(savedGames,()=>{
        const {data}=paths(savedGames), latest=readJson(path.join(data,'last-backup.json'),null);
        if(!latest) throw new Error('No catalog backup is available.');
        const backup=path.resolve(latest.backup), parent=path.resolve(data,'Backups');
        if(!backup.startsWith(parent+path.sep)) throw new Error('Invalid backup path.');
        const manifest=readJson(path.join(backup,'manifest.json'),null), restore=[];
        for(const item of manifest.files) {
            const file=path.resolve(savedGames,item.relative), relative=path.relative(savedGames,file);
            if(relative.startsWith('..')||path.isAbsolute(relative)||path.basename(item.backup)!==item.backup) throw new Error('Invalid backup entry.');
            if(!fs.existsSync(file)||hash(fs.readFileSync(file,'utf8'))!==item.afterHash) throw new Error('Files changed since the last import. Restore stopped to protect later edits: '+item.relative);
            restore.push({file,item});
        }
        for(const {file,item} of restore) if(item.existed) atomic(file,fs.readFileSync(path.join(backup,item.backup))); else fs.unlinkSync(file);
        fs.unlinkSync(path.join(data,'last-backup.json'));
        return backup;
    });
}
module.exports={importUnits,ignoreUnits,restoreLast,atomic,commit,buildEntry};
