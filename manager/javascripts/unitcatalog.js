const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { inspect, readPayloadTable } = require('./catalog-lua');
const DATABASES = { Aircraft: 'aircraftdatabase', Helicopter: 'helicopterdatabase', GroundUnit: 'groundunitdatabase', NavyUnit: 'navyunitdatabase' };
const SKIP = new Set(['node_modules','.git','textures','shapes','cockpit','input','sounds','missions','docs','doc','themes','theme','options','l10n','terrains','sensors','weapons','comm','fm','efm','bin']);
function hash(obj) {
    const stable=x=>Array.isArray(x)?x.map(stable):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;
    return crypto.createHash('sha256').update(JSON.stringify(stable(obj))).digest('hex');
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch(e) { if (e.code === 'ENOENT') return fallback; throw new Error(`Cannot read ${file}: ${e.message}`); } }
function walk(root, visit, seen = new Set()) {
    if (!fs.existsSync(root)) return;
    const real = fs.realpathSync(root); if (seen.has(real)) return; seen.add(real);
    for (const item of fs.readdirSync(root, { withFileTypes: true })) {
        const full = path.join(root, item.name);
        if (item.isDirectory() && !SKIP.has(item.name.toLowerCase())) walk(full, visit, seen);
        else if (item.isFile() && /\.lua$/i.test(item.name)) visit(full);
        // Directory junctions at package roots are supported by package discovery;
        // nested links are not followed, so circular mod trees cannot hang a scan.
    }
}
function packageRoots(root, source) {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).map(name => ({root:path.join(root,name), name, source})).filter(p => {
        try { return fs.statSync(p.root).isDirectory(); } catch { return false; }
    });
}
function scan({ savedGames, dcsRoot }) {
    if (!savedGames || !fs.existsSync(path.join(savedGames,'Mods','Services','Olympus','databases','units'))) throw new Error('Select a Saved Games instance with Olympus installed.');
    const dataDir = path.join(savedGames,'Olympus','Catalog');
    const snapshot = readJson(path.join(dataDir,'dcs-catalog.json'), null);
    const dbDir = path.join(savedGames,'Mods','Services','Olympus','databases','units');
    const databases = Object.fromEntries(Object.values(DATABASES).concat('mods').map(name => [name,readJson(path.join(dbDir,name+'.json'),{})]));
    const existing = new Map();
    for (const [file,db] of Object.entries(databases)) for (const [id,entry] of Object.entries(db)) existing.set(id,{ file, entry });
    const units = new Map(), presets = new Map(), liveries = [], issues = [], modIds = new Set(), ww2Ids = new Set(['La-7','T-34-85']);
    let compiledFiles = 0, inspectedFiles = 0;
    const packages = [ ...packageRoots(path.join(savedGames,'Mods','aircraft'),'mod'), ...packageRoots(path.join(savedGames,'Mods','tech'),'mod') ];
    if (dcsRoot && fs.existsSync(path.join(dcsRoot,'autoupdate.cfg'))) {
        for (const base of ['CoreMods/aircraft','CoreMods/tech','Mods/aircraft','Mods/tech']) packages.push(...packageRoots(path.join(dcsRoot,base),'dcs'));
        for (const base of ['CoreMods/WWII Units','Scripts/Database','MissionEditor/data/scripts/UnitPayloads','Bazar/Liveries']) if (fs.existsSync(path.join(dcsRoot,base))) packages.push({root:path.join(dcsRoot,base),source:'dcs',name:base});
    }
    const addPresets = (table, file, priority) => {
        const parsed = readPayloadTable(table, file); issues.push(...parsed.issues);
        if (!presets.has(parsed.id)) presets.set(parsed.id,new Map());
        for (const p of parsed.presets) { const prev = presets.get(parsed.id).get(p.code); if (!prev || priority >= prev.priority) presets.get(parsed.id).set(p.code,{...p,priority}); }
        return parsed.id;
    };
    for (const pkg of packages) {
        try {
            walk(pkg.root, file => {
                const isLivery = /[\\/]liveries[\\/]/i.test(file);
                if (isLivery && path.basename(file).toLowerCase() !== 'description.lua') return;
                // Weapon definition scripts are not unit or payload definitions.
                // Some DCS releases use syntax that the safe metadata parser does
                // not need to understand, so do not report them as catalog errors.
                if (!isLivery && /[\\/]Weapons\.lua$/i.test(file) && !/[\\/]UnitPayloads[\\/]/i.test(file)) return;
                const buffer = fs.readFileSync(file); inspectedFiles++;
                if (buffer[0] === 27) { if (!isLivery) compiledFiles++; return; }
                if (buffer.length > 4 * 1024 * 1024) return;
                const source = buffer.toString('utf8');
                if (!isLivery && !/add_aircraft|add_helicopter|add_ship|add_surface_unit|add_GT|make_flyable|MAC_flyable|payloads\s*["'\]]*\s*=|\bName\s*=/.test(source)) return;
                let parsed; try { parsed = inspect(source); } catch(e) { if (!isLivery) issues.push(`${path.relative(pkg.root,file)}: ${e.message}`); return; }
                if (isLivery) {
                    const folder = path.dirname(file), unit = path.basename(path.dirname(folder));
                    liveries.push({unit, key:path.basename(folder).toLowerCase(), name:parsed.globals.name || path.basename(folder), countries:Object.values(parsed.globals.countries || {}), source:pkg.source});
                    return;
                }
                for (const u of parsed.units) {
                    if (pkg.source === 'mod') modIds.add(u.id);
                    units.set(u.id,{...units.get(u.id),...u,source:pkg.source,package:pkg.name,sourcePath:pkg.root,definitionMtime:fs.statSync(file).mtimeMs,era:/WWII/i.test(pkg.root)?'WW2':undefined});
                }
                for (const id of parsed.flyable) if (pkg.source === 'mod') modIds.add(id);
                for (const table of parsed.payloadTables) {
                    const id = addPresets(table,file,10); if (pkg.source === 'mod') modIds.add(id); if(/WWII/i.test(pkg.root)) ww2Ids.add(id);
                }
            });
        } catch(e) { issues.push(`${pkg.name}: ${e.message}`); }
    }
    let version = ''; try { version = readJson(path.join(dcsRoot || '', 'autoupdate.cfg'),{}).version || ''; } catch(e) { issues.push(e.message); }
    const snapshotUsable = snapshot?.schemaVersion === 1 && Array.isArray(snapshot.units) && (!dcsRoot || path.resolve(snapshot.dcsRoot || '').toLowerCase() === path.resolve(dcsRoot).toLowerCase()) && (!version || snapshot.version === version);
    if (snapshotUsable) {
        for (const u of snapshot.units) {
            if (!u.id || !DATABASES[u.category]) continue;
            const known = units.get(u.id), source = modIds.has(u.id) || u.source === 'mod' ? 'mod' : 'dcs';
            if(source==='mod' && known?.definitionMtime>Date.parse(snapshot.createdAt)) continue;
            // Preserve package metadata when the runtime snapshot omits it. This
            // keeps WWII assets such as B-17G classified as WWII after merging.
            const snapshotEra = u.era || known?.era || (/WWII|World War II/i.test(known?.package || u.package || '') ? 'WW2' : undefined);
            units.set(u.id,{...known,...u,source,package:known?.package || u.package || 'DCS database',era:snapshotEra,runtimeVerified:true});
            if (snapshotEra === 'WW2') ww2Ids.add(u.id);
            if (u.payloads) addPresets({unitType:u.id,payloads:u.payloads},'DCS database',0);
        }
    } else issues.push('Complete DCS catalog unavailable or outdated. Start DCS once after an update, then reopen Manager. Compiled definitions are never guessed.');
    // Existing Olympus entries are an authoritative category source for payload-only files.
    for (const [id] of presets) if (!units.has(id) && existing.has(id)) {
        const entry = existing.get(id).entry, cat = Object.keys(DATABASES).find(c => c.toLowerCase() === entry.category);
        if (cat) units.set(id,{id,displayName:entry.label || id,category:cat,source:modIds.has(id)||existing.get(id).file==='mods'?'mod':'dcs',package:'Installed content'});
    }
    const userPayloads = path.join(savedGames,'MissionEditor','UnitPayloads');
    try { walk(userPayloads,file => { try { for (const table of inspect(fs.readFileSync(file,'utf8')).payloadTables) addPresets(table,file,20); } catch(e) { issues.push(`User preset ${path.basename(file)}: ${e.message}`); } }); } catch(e) { issues.push(e.message); }
    try { walk(path.join(savedGames,'Liveries'),file => {
        if (path.basename(file).toLowerCase()!=='description.lua') return;
        try { const g=inspect(fs.readFileSync(file,'utf8')).globals, folder=path.dirname(file); liveries.push({unit:path.basename(path.dirname(folder)),key:path.basename(folder).toLowerCase(),name:g.name||path.basename(folder),countries:Object.values(g.countries||{})}); } catch(e) { issues.push(`Livery ${file}: ${e.message}`); }
    }); } catch(e) { issues.push(e.message); }
    const state = readJson(path.join(dataDir,'state.json'),{ignored:{},managed:{}});
    const inventory = [...units.values()].filter(u=>!snapshotUsable||u.source==='mod'||u.runtimeVerified).map(u => {
        const air = ['Aircraft','Helicopter'].includes(u.category);
        u.era = existing.get(u.id)?.entry.era || u.era || (ww2Ids.has(u.id)?'WW2':undefined);
        u.presets = air ? [...(presets.get(u.id)?.values() || [])].sort((a,b)=>a.code.localeCompare(b.code)) : [];
        u.liveries = u.liveries || {};
        for (const l of liveries) if ([u.id,u.liveryEntry].filter(Boolean).some(id=>id.replace(/\//g,'_').toLowerCase()===l.unit.toLowerCase())) u.liveries[l.key]={name:l.name,countries:l.countries.length?l.countries:'All'};
        u.issues=[];
        if (air && !u.presets.length) u.issues.push('No preset found. Save a payload preset in DCS Mission Editor, then scan again.');
        if (!u.runtimeVerified) u.issues.push('Static definition; AI compatibility has not been verified in DCS.');
        // Validate only against a complete runtime pylon list; never invent CLSIDs.
        const allowed = u.allowedPylons;
        if (allowed) u.presets = u.presets.filter(p => {
            const bad=Object.entries(p.payload.pylons).some(([slot,v]) => v.CLSID!=='<CLEAN>' && (!allowed[slot] || !Object.values(allowed[slot]).includes(v.CLSID)));
            if (bad) u.issues.push(`Preset "${p.code}" contains a store not supported by this unit's current pylon definitions and was skipped.`);
            return !bad;
        });
        u.fingerprint = hash({id:u.id,category:u.category,era:u.era,presets:u.presets.map(({source,priority,...p})=>p),liveries:u.liveries});
        const prev=existing.get(u.id), managed=state.managed?.[u.id];
        u.target = u.source==='mod'?'mods':DATABASES[u.category];
        u.conflict = Boolean(prev && prev.file!==u.target);
        u.status = u.conflict ? 'Conflict — preserved' : managed===u.fingerprint ? 'Up to date' : prev ? 'Metadata available' : 'New unit';
        u.ignored = state.ignored?.[u.id] === u.fingerprint;
        return u;
    }).sort((a,b)=>a.displayName.localeCompare(b.displayName));
    return { savedGames,dcsRoot,version,snapshotUsable,snapshotTime:snapshot?.createdAt,compiledFiles,inspectedFiles,inventory,issues:[...new Set(issues)],scannedAt:new Date().toISOString() };
}
module.exports = { scan, DATABASES, readJson, hash };
