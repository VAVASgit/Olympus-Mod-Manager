// Preserve user catalogs across the existing Manager install/repair workflow.
const fs=require('fs'),path=require('path');
const {readJson}=require('./unitcatalog');
const {atomic}=require('./catalog-store');
const SCRIPTS=['mods.lua','unitPayloads.lua','mods_generated.lua','catalog_generated.lua'];
const BRIDGE="\n-- Olympus catalog bridge (managed)\npcall(function() local lfs = require('lfs'); dofile(lfs.writedir() .. 'Mods/Services/Olympus/scripts/catalog.lua') end)\n";
function preserve(folder) {
    const runtime=path.join(folder,'Mods','Services','Olympus');if(!fs.existsSync(runtime))return;
    const files={};
    const dir=path.join(runtime,'databases','units');
    if(fs.existsSync(dir))for(const file of fs.readdirSync(dir).filter(x=>x.endsWith('.json')))files['databases/units/'+file]=fs.readFileSync(path.join(dir,file),'utf8');
    for(const name of SCRIPTS)if(fs.existsSync(path.join(runtime,'scripts',name)))files['scripts/'+name]=fs.readFileSync(path.join(runtime,'scripts',name),'utf8');
    atomic(path.join(folder,'Olympus','Catalog','preserved-install.json'),JSON.stringify(files));
}
function restore(folder) {
    const runtime=path.join(folder,'Mods','Services','Olympus'), files=readJson(path.join(folder,'Olympus','Catalog','preserved-install.json'),{});
    for(const [relative,content] of Object.entries(files)) {
        if(!/^databases\/units\/[^/\\]+\.json$/.test(relative)&&!SCRIPTS.some(x=>relative==='scripts/'+x))throw new Error('Invalid preserved catalog path');
        const target=path.join(runtime,relative);
        if(relative.endsWith('.json'))atomic(target,JSON.stringify({...readJson(target,{}),...JSON.parse(content)},null,2));else atomic(target,content);
    }
    const mods=path.join(runtime,'scripts','mods.lua');
    if(fs.existsSync(mods)){const text=fs.readFileSync(mods,'utf8');if(!text.includes('-- Olympus catalog bridge (managed)'))atomic(mods,text+BRIDGE);}
}
module.exports={preserve,restore,BRIDGE};
