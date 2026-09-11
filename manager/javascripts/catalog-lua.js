// Read data from Lua syntax without executing installed third-party scripts.
const lua = require('./vendor/luaparse');
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
function safeKey(k) { return (typeof k === 'string' || typeof k === 'number') && !BAD_KEYS.has(String(k)); }
function parse(source) {
    if (source.charCodeAt(0) === 27) throw new Error('Compiled Lua requires a DCS catalog snapshot');
    return lua.parse(Buffer.from(source.replace(/^\uFEFF/, ''),'utf8').toString('latin1'), { luaVersion: '5.1', encodingMode: 'pseudo-latin1' });
}
function member(node) {
    if (!node) return '';
    if (node.type === 'Identifier') return node.name;
    if (node.type === 'MemberExpression') return member(node.base) + '.' + node.identifier.name;
    return '';
}
function value(n, env = {}, depth = 0) {
    if (!n || depth > 40) return undefined;
    const read = x => value(x, env, depth + 1);
    if (n.type === 'StringLiteral') return Buffer.from(n.value,'latin1').toString('utf8');
    if (['NumericLiteral', 'BooleanLiteral'].includes(n.type)) return n.value;
    if (n.type === 'Identifier') return env[n.name];
    if (n.type === 'MemberExpression') return read(n.base)?.[n.identifier.name];
    if (n.type === 'IndexExpression') return read(n.base)?.[read(n.index)];
    if (n.type === 'UnaryExpression' && n.operator === '-') { const v = read(n.argument); return typeof v === 'number' ? -v : undefined; }
    if (n.type === 'BinaryExpression' && n.operator === '..') {
        const a = read(n.left), b = read(n.right);
        return a !== undefined && b !== undefined ? String(a) + String(b) : undefined;
    }
    if (n.type === 'TableConstructorExpression') {
        const obj = Object.create(null); let index = 1;
        for (const field of n.fields) {
            const key = field.type === 'TableValue' ? index++ : field.type === 'TableKeyString' ? field.key.name : read(field.key);
            const v = read(field.value);
            if (safeKey(key) && v !== undefined) obj[key] = v;
        }
        return obj;
    }
    if (n.type === 'CallExpression') {
        const name = member(n.base);
        if (['_', 'i18n.translate'].includes(name)) return read(n.arguments[0]);
        if (['copyTable', 'deepcopy'].includes(name)) {
            const v = read(n.arguments[0]); return v ? JSON.parse(JSON.stringify(v)) : undefined;
        }
        if (name === 'pylon') return { Number: read(n.arguments[0]), Launchers: read(n.arguments[n.arguments.length - 1]) };
    }
    return undefined;
}
const CATS = { add_aircraft: 'Aircraft', add_helicopter: 'Helicopter', add_surface_unit: 'GroundUnit', add_ship: 'NavyUnit' };
function category(unit, hint) {
    if (['Aircraft','Helicopter','GroundUnit','NavyUnit'].includes(hint)) return hint;
    const attr = Object.values(unit.attribute || {}).join(' ').toLowerCase();
    if (/helicopter/.test(attr)) return 'Helicopter';
    if (/planes|aircraft/.test(attr)) return 'Aircraft';
    if (/ships|naval/.test(attr)) return 'NavyUnit';
    if (/ground units|vehicles|infantry|tanks/.test(attr)) return 'GroundUnit';
    return { 0: 'Aircraft', 1: 'Helicopter', 2: 'GroundUnit', 3: 'NavyUnit', 4: 'GroundUnit' }[unit.category];
}
function inspect(source) {
    const ast = parse(source), env = Object.create(null), units = [], payloadTables = [], flyable = [];
    env.GT = Object.create(null);
    env.wsType_Air = 1; env.wsType_Airplane = 1; env.wsType_Helicopter = 2;
    const add = (u, hint) => {
        if (!u || typeof u !== 'object') return;
        const id = u.Name || u.type;
        const cat = category(u, hint);
        if (typeof id === 'string' && id.trim() && cat) units.push({ id, category: cat, displayName: u.DisplayName || id,
            length: u.length, fuel: u.M_fuel_max, countermeasures: u.passivCounterm, pylons: u.Pylons,
            liveryEntry: u.livery_entry, attributes: Object.values(u.attribute || {}), tasks: u.Tasks });
    };
    for (const stmt of ast.body) {
        if (stmt.type === 'LocalStatement' || stmt.type === 'AssignmentStatement') {
            stmt.variables.forEach((target, i) => {
                const v = value(stmt.init[i], env);
                if (target.type === 'Identifier' && safeKey(target.name)) env[target.name] = v;
                else if (target.type === 'MemberExpression') {
                    const base = value(target.base, env), key = target.identifier.name;
                    if (base && safeKey(key)) base[key] = v;
                } else if (target.type === 'IndexExpression') {
                    const base = value(target.base, env), key = value(target.index, env);
                    if (base && safeKey(key)) base[key] = v;
                }
            });
        } else if (stmt.type === 'CallStatement') {
            const call = stmt.expression, name = member(call.base);
            if (CATS[name]) { const u=value(call.arguments[0],env); add(u,name==='add_surface_unit'?category(u||{})||'GroundUnit':CATS[name]); }
            else if (name === 'GT_t.add_GT') add(value(call.arguments[0], env));
            else if (name === 'make_flyable' || name === 'MAC_flyable') {
                const id = value(call.arguments[0], env); if (typeof id === 'string') flyable.push(id);
            }
        } else if (stmt.type === 'ReturnStatement') {
            const obj = value(stmt.arguments[0], env);
            if (obj && obj.payloads && typeof (obj.unitType || obj.name) === 'string') payloadTables.push(obj);
        }
    }
    // Only explicit unit registration calls count. Sensors/weapons also have Name/category.
    return { units, payloadTables, flyable, globals: env };
}
const ROLES = { 10:'Intercept', 11:'CAP', 17:'Reconnaissance', 18:'Escort', 19:'Fighter Sweep', 29:'SEAD', 30:'Anti-ship Strike', 31:'CAS', 32:'Ground Attack', 33:'Pinpoint Strike', 34:'Runway Attack', 35:'FAC-A' };
function readPayloadTable(table, source) {
    const id = table.unitType || table.name;
    const presets = [], issues = [];
    for (const p of Object.values(table.payloads || {})) {
        if (!p || typeof p.name !== 'string' || !p.name.trim()) continue;
        const pylons = Object.create(null), items = [], slots = new Set(); let valid = true;
        for (const [index, item] of Object.entries(p.pylons || {})) {
            const slot = item.num ?? Number(index);
            if (!Number.isInteger(slot) || slot < 1 || slot > 128 || slots.has(slot) || typeof item.CLSID !== 'string' || !item.CLSID) { valid = false; break; }
            slots.add(slot); pylons[slot] = { CLSID: item.CLSID };
            if (item.settings && typeof item.settings === 'object') pylons[slot].settings = item.settings;
            items.push({ name: item.CLSID, quantity: 1 });
        }
        if (!valid) { issues.push(`Invalid pylon data in preset "${p.name}" (${source})`); continue; }
        const payload = { pylons };
        for (const key of ['fuel','flare','chaff','gun','ammo_type']) if (typeof p[key] === 'number' && Number.isFinite(p[key]) && p[key] >= 0) payload[key] = p[key];
        const roles = [...new Set(Object.values(p.tasks || {}).map(x => ROLES[x]).filter(Boolean))];
        presets.push({ name: p.displayName || p.name, code: p.name, enabled: true, items, roles: roles.length ? roles : ['No task'], payload, source });
    }
    return { id, presets, issues };
}
function toLua(v) {
    if (typeof v === 'string') return '"' + v.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/[\x00-\x1f\x7f]/g, c => '\\' + c.charCodeAt(0).toString().padStart(3,'0')) + '"';
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (Array.isArray(v)) return '{'+v.map((x,i)=>'['+(i+1)+']='+toLua(x)).join(',')+'}';
    if (v && typeof v === 'object') return '{' + Object.entries(v).filter(([k,x]) => safeKey(k) && x !== undefined).map(([k,x]) => '[' + (/^[1-9]\d*$/.test(k) ? k : toLua(k)) + ']=' + toLua(x)).join(',') + '}';
    return 'nil';
}
module.exports = { inspect, parse, readPayloadTable, toLua, category };
