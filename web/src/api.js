async function getJson(url, init) {
    const resp = await fetch(url, init);
    if (!resp.ok)
        throw new Error(`${url} -> ${resp.status} ${resp.statusText}`);
    return (await resp.json());
}
export const getHealth = () => getJson("/studio/api/health");
export const getConfig = () => getJson("/studio/api/config");
export const getCatalog = () => getJson("/studio/api/catalog");
// Live fetch() output for a widget, feeding ctx.data. Options default to the
// manifest defaults server-side when omitted. Reuses Tesserae's flattener, the
// same endpoint mine_data_schema will read in M2.
export const getWidgetData = (key, options = {}) => getJson(`/api/mcp/widgets/${encodeURIComponent(key)}/data`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ options }),
});
