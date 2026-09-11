-- Olympus catalog bridge. Runs in DCS's GUI environment, never in a mission sandbox.
-- Reads the database DCS has already loaded; changes no units, weapons or missions.
local function exportCatalog()
    local lfs = require('lfs')
    local root = lfs.writedir() .. 'Olympus/Catalog/'
    lfs.mkdir(lfs.writedir() .. 'Olympus'); lfs.mkdir(root)
    local db = _G.db
    if not db or not db.Units then error('DCS unit database is not available in this hook environment') end
    local function safeData(v, depth)
        depth = depth or 0
        if depth > 12 then return nil end
        if type(v) == 'string' or type(v) == 'boolean' then return v end
        if type(v) == 'number' and v == v and v ~= math.huge and v ~= -math.huge then return v end
        if type(v) == 'table' then
            local result = {}; for k, x in pairs(v) do
                if type(k) == 'string' or type(k) == 'number' then result[k] = safeData(x, depth + 1) end
            end; return result
        end
    end
    local function quote(s)
        return '"' .. s:gsub('[%z\1-\31\\"]', function(c)
            if c == '"' then return '\\"' end
            if c == '\\' then return '\\\\' end
            return string.format('\\u%04x', string.byte(c))
        end) .. '"'
    end
    local function json(v)
        if type(v) == 'string' then return quote(v) end
        if type(v) == 'number' or type(v) == 'boolean' then return tostring(v) end
        if type(v) ~= 'table' then return 'null' end
        local isArray, count = true, 0
        for k in pairs(v) do count = count + 1; if type(k) ~= 'number' or k < 1 or k % 1 ~= 0 then isArray = false end end
        if count ~= #v or count == 0 then isArray = false end
        local parts = {}
        if isArray then for _, x in ipairs(v) do parts[#parts + 1] = json(x) end
        else for k, x in pairs(v) do parts[#parts + 1] = quote(tostring(k)) .. ':' .. json(x) end end
        return (isArray and '[' or '{') .. table.concat(parts, ',') .. (isArray and ']' or '}')
    end
    local payloads = {}
    local payloadOK, payloadError = pcall(function()
        local loader = require('me_loadoututils')
        for _, filename in pairs(loader.getUnitPayloadFileNames()) do
            local dir = loader.getUnitPayloadsReadPath(filename)
            if dir then
                local f = loadfile(dir)
                if f then local ok, data = pcall(f); if ok and type(data) == 'table' then payloads[data.unitType or data.name] = data.payloads end end
            end
        end
    end)
    local version = DCS and DCS.getVersion and DCS.getVersion() or ''
    if type(version) == 'table' then version = table.concat(version, '.') end
    local cfgFile = io.open('autoupdate.cfg','r')
    if cfgFile then local cfg = cfgFile:read('*a'); cfgFile:close(); version = cfg:match('"version"%s*:%s*"([^"]+)"') or version end
    local result = { schemaVersion = 1, version = version, dcsRoot = lfs.currentdir(), createdAt = os.date('!%Y-%m-%dT%H:%M:%SZ'), units = {}, payloadExportError = not payloadOK and tostring(payloadError) or nil }
    local types = { {'Planes','Plane','Aircraft'}, {'Helicopters','Helicopter','Helicopter'}, {'Cars','Car','GroundUnit'}, {'Ships','Ship','NavyUnit'} }
    for _, group in ipairs(types) do
        local list = db.Units[group[1]] and db.Units[group[1]][group[2]] or {}
        for _, u in pairs(list) do
            if type(u) == 'table' and type(u.type or u.Name) == 'string' then
                local id = u.type or u.Name
                local unit = { id = id, displayName = u.DisplayName or id, category = group[3], length = u.length,
                    fuel = u.M_fuel_max, countermeasures = safeData(u.passivCounterm), liveryEntry = u.livery_entry,
                    payloads = safeData(payloads[id]), attributes = safeData(u.attribute), liveries = {} }
                local origin = u._origin or u._origin_flyable
                for _, plugin in pairs(_G.plugins or {}) do
                    if origin and (plugin.id == origin or plugin.name == origin) and plugin.dirName then
                        unit.source = plugin.dirName:lower():find(lfs.writedir():lower(),1,true) and 'mod' or 'dcs'
                        unit.package = plugin.displayName or origin
                    end
                end
                if type(u.Pylons) == 'table' then
                    unit.allowedPylons = {}
                    for k, p in pairs(u.Pylons) do
                        local slot = p.Number or p.num or k
                        local stores = {}
                        for _, store in pairs(p.Launchers or {}) do if store.CLSID then stores[#stores+1] = store.CLSID end end
                        unit.allowedPylons[tostring(slot)] = stores
                    end
                end
                if DCS and DCS.getObjectLiveriesNames then
                    local ok, liveries = pcall(DCS.getObjectLiveriesNames, (u.livery_entry or id):gsub('/','_'), nil, 'en')
                    if ok and liveries then for _, livery in pairs(liveries) do unit.liveries[tostring(livery[1])] = { name = livery[2], countries = 'All' } end end
                end
                result.units[#result.units+1] = unit
            end
        end
    end
    if #result.units < 1 then error('DCS returned an empty catalog; previous snapshot retained') end
    local target, temp = root .. 'dcs-catalog.json', root .. 'dcs-catalog.json.tmp'
    local file = assert(io.open(temp,'w')); file:write(json(result)); file:close()
    -- Retain a previous complete snapshot if replacement fails.
    os.remove(target .. '.previous'); os.rename(target, target .. '.previous')
    local ok, err = os.rename(temp,target)
    if not ok then os.rename(target .. '.previous',target); error(err) end
    if log and log.write then log.write('Olympus Catalog', log.INFO, 'Exported ' .. #result.units .. ' units for ' .. tostring(version)) end
end
local ok, err = pcall(exportCatalog)
if not ok and log and log.write then log.write('Olympus Catalog', log.ERROR, tostring(err)) end
