// The static Studio shell markup. main.ts sets this as #app's innerHTML once, at
// boot, before any controller wires its listeners. All element ids referenced by
// the controllers live here.

export const APP_HTML = `
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark"><i class="ph-bold ph-squares-four"></i></span>
      <span class="brand-name">Tesserae <b>Studio</b></span>
    </div>
    <div class="topbar-right">
      <div class="pills">
        <span class="pill" id="mode"><span class="dot"></span><span id="mode-text">·</span></span>
        <span class="pill" id="conn"><span class="dot"></span><span id="conn-text">connecting…</span></span>
      </div>
      <button class="icon-btn" id="mcp-settings" title="Add an MCP client" aria-label="Add an MCP client"><i class="ph-bold ph-plugs-connected"></i></button>
      <button class="icon-btn" id="theme-toggle" title="Toggle theme" aria-label="Toggle light / dark theme"><i class="ph-bold ph-moon"></i></button>
    </div>
  </header>
  <dialog id="mcp-dialog" class="dialog">
    <form method="dialog">
      <h2>Add an MCP client</h2>
      <p class="d-hint">Drive Studio from an agent (Claude Code / Desktop). Studio's MCP server is a thin client over this backend, so point it at the URL below. Start Studio first, then add it to your client and restart the client.</p>
      <div class="field">
        <label for="mcp-url">Studio URL</label>
        <div class="copy-row"><code class="mcp-snippet" id="mcp-url"></code><button type="button" class="btn ghost" data-copy="mcp-url">Copy</button></div>
      </div>
      <label class="mcp-label">Claude Code</label>
      <div class="copy-row"><pre class="mcp-snippet" id="mcp-cli"></pre><button type="button" class="btn ghost" data-copy="mcp-cli">Copy</button></div>
      <label class="mcp-label">Claude Desktop (config file)</label>
      <div class="copy-row"><pre class="mcp-snippet" id="mcp-json"></pre><button type="button" class="btn ghost" data-copy="mcp-json">Copy</button></div>
      <p class="d-hint">The <code>tesserae-studio-mcp</code> command ships with the Studio install (<code>pip install -e server</code>). No install? Use <code>command: "python"</code>, <code>args: ["-m", "studio_server.mcp_server"]</code>.</p>
      <div class="dialog-actions">
        <button type="button" class="btn" id="mcp-close">Done</button>
      </div>
    </form>
  </dialog>
  <div class="toolbar">
    <div class="tool-fields">
      <div class="field"><label for="widget">Widget</label><select id="widget"></select></div>
      <div class="field"><label for="fragment">Fragment</label><select id="fragment"></select></div>
      <div class="field"><label for="size">Size</label>
        <select id="size">
          <option value="xs">xs (180×180)</option>
          <option value="sm">sm (380×240)</option>
          <option value="md" selected>md (640×400)</option>
          <option value="lg">lg (1200×800)</option>
          <option value="fragment">fragment size</option>
          <option value="custom">custom…</option>
        </select>
      </div>
      <div class="field dim"><label for="w">Width</label><input id="w" type="number" min="20" max="2000" value="640" /></div>
      <div class="field dim"><label for="h">Height</label><input id="h" type="number" min="20" max="2000" value="400" /></div>
    </div>
    <div class="tool-actions">
      <button class="btn ghost" id="new-widget"><i class="ph-bold ph-plus"></i> New widget</button>
      <button class="btn ghost" id="new-bundle"><i class="ph-bold ph-stack"></i> New bundle</button>
    </div>
  </div>
  <dialog id="bundle-dialog" class="dialog">
    <form method="dialog" id="bundle-form">
      <h2>New bundle</h2>
      <p class="d-hint">A shared <code>&lt;name&gt;_core</code> companion (with an admin page) plus member widgets that read it.</p>
      <div class="field"><label for="bd-name">Bundle name</label>
        <input id="bd-name" type="text" placeholder="e.g. News" required /></div>
      <div class="field"><label for="bd-members">Members (one per line)</label>
        <textarea id="bd-members" rows="3" placeholder="Headlines&#10;Ticker"></textarea></div>
      <label class="check"><input id="bd-admin" type="checkbox" checked /> Include admin page (blueprint)</label>
      <div class="dialog-actions">
        <button type="button" class="btn ghost" id="bd-cancel">Cancel</button>
        <button type="submit" class="btn" id="bd-create">Create</button>
      </div>
    </form>
  </dialog>
  <dialog id="new-dialog" class="dialog">
    <form method="dialog" id="new-form">
      <h2>New widget</h2>
      <div class="field"><label for="nw-name">Name</label>
        <input id="nw-name" type="text" placeholder="e.g. Air Quality" required /></div>
      <div class="field"><label for="nw-arche">Archetype</label>
        <select id="nw-arche">
          <option value="stat">Stat</option>
          <option value="list">List</option>
          <option value="chart">Chart</option>
          <option value="status">Status</option>
          <option value="weather">Weather</option>
          <option value="calendar">Calendar</option>
          <option value="image">Image</option>
        </select></div>
      <label class="check"><input id="nw-server" type="checkbox" /> Include server.py</label>
      <div class="dialog-actions">
        <button type="button" class="btn ghost" id="nw-cancel">Cancel</button>
        <button type="submit" class="btn" id="nw-create">Create</button>
      </div>
    </form>
  </dialog>
  <div class="workbench">
    <section class="editor-pane">
      <div class="pane-head">
        <div class="pane-id">
          <span class="pane-title" id="editor-widget">—</span>
          <span class="pane-sub" id="editor-sub"></span>
        </div>
        <div class="pane-status">
          <button class="pill register" id="register-btn" hidden><span class="dot"></span><span id="register-text"></span></button>
          <button class="pill" id="lint-pill" hidden><span class="dot"></span><span id="lint-text"></span></button>
        </div>
        <div class="pane-actions">
          <button class="btn ghost" id="mine-btn" hidden><i class="ph-bold ph-magic-wand"></i> Mine schema</button>
          <button class="btn" id="save" disabled>Save <kbd>⌘S</kbd></button>
        </div>
      </div>
      <div class="tabs" id="tabs"></div>
      <div class="editor-wrap">
        <div class="monaco" id="monaco"></div>
        <div class="editor-empty" id="editor-empty" hidden></div>
      </div>
      <div class="mine-panel" id="mine-panel" hidden></div>
      <div class="lint-panel" id="lint-panel" hidden></div>
    </section>
    <section class="preview-pane">
      <div class="stage-head">
        <div class="tier-toggle" role="tablist">
          <button class="tier-btn active" id="tier-interactive">Interactive</button>
          <button class="tier-btn" id="tier-faithful" title="True e-ink render through Tesserae">Faithful</button>
        </div>
        <span class="badge" id="badge"></span>
        <span class="src-chip" id="src" hidden></span>
        <div class="stage-actions">
          <button class="btn ghost" id="config-btn"><i class="ph-bold ph-sliders-horizontal"></i> Config</button>
          <button class="btn ghost" id="admin-btn" hidden><i class="ph-bold ph-wrench"></i> Admin</button>
        </div>
      </div>
      <div class="cell-frame" id="frame"></div>
      <iframe class="admin-frame" id="admin-frame" title="Admin page" hidden></iframe>
      <div class="config-panel" id="config-panel" hidden></div>
      <p class="note" id="note"></p>
    </section>
  </div>
`;
