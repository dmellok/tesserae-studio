async function getJson(url, init) {
    const resp = await fetch(url, init);
    if (!resp.ok)
        throw new Error(`${url} -> ${resp.status} ${resp.statusText}`);
    return (await resp.json());
}
export const getHealth = () => getJson("/studio/api/health");
export const getConfig = () => getJson("/studio/api/config");
export const getCatalog = () => getJson("/studio/api/catalog");
// ctx.data for the preview. Studio resolves the source: a live fetch() through
// the connected Tesserae, or the dev-gallery sample from the disk checkout.
export const getWidgetData = (key) => getJson(`/studio/api/widgets/${encodeURIComponent(key)}/data`);
