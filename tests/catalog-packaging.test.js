const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
test('catalog hook is included in both package distributions and installed from the packaged location',()=>{
    const build=read('scripts/batch/package.bat');
    assert.ok(build.includes('.\\scripts\\lua\\hooks\\OlympusCatalogExport.lua .\\package\\Scripts\\OlympusCatalogExport.lua'));
    assert.ok(build.includes('.\\package\\Scripts\\OlympusCatalogExport.lua .\\zip\\Scripts\\Hooks\\OlympusCatalogExport.lua'));
    assert.ok(read('manager/javascripts/filesystem.js').includes('path.join("..", "Scripts", "OlympusCatalogExport.lua")'));
});
test('catalog integration retains legacy mod loading and payload fallback',()=>{
    const mods=read('scripts/lua/backend/mods.lua');
    assert.ok(mods.includes('loadGeneratedMods()'));
    assert.ok(mods.includes("Mods/Services/Olympus/scripts/catalog.lua"));
    const command=read('scripts/lua/backend/OlympusCommand.lua');
    assert.ok(command.includes('mist.utils.deepCopy(Olympus.catalogPayloads[unit.unitType][loadout])'));
    assert.ok(command.includes('Olympus.modsUnitPayloads[unit.unitType][loadout]'));
});
