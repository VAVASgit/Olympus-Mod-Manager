-- Load only the generated data table. Existing manual/legacy mods remain intact.
local ok, err = pcall(function()
    local lfs = lfs or require('lfs')
    local chunk = loadfile(lfs.writedir() .. 'Mods/Services/Olympus/scripts/catalog_generated.lua')
    if not chunk then return end
    local data = chunk()
    if type(data) ~= 'table' then return end
    Olympus.modsList = Olympus.modsList or {}
    Olympus.catalogPayloads = Olympus.catalogPayloads or {}
    for id, category in pairs(data.units or {}) do Olympus.modsList[id] = category end
    for id, payloads in pairs(data.payloads or {}) do Olympus.catalogPayloads[id] = payloads end
end)
if not ok and env and env.info then env.info('[Olympus Catalog] ' .. tostring(err)) end
