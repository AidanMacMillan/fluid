const CDN =
  'https://cdnjs.cloudflare.com https://esm.sh https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com https://fonts.gstatic.com https://fonts.bunny.net'
export const VISUALIZATION_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${CDN}`,
  `style-src 'unsafe-inline' ${CDN}`,
  `img-src data: blob: ${CDN}`,
  `font-src data: ${CDN}`,
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'sandbox allow-scripts'
].join('; ')

// A small compatibility layer for local HTML, not an MCP Apps host. Keep generated
// scripts on a separate opaque origin; no Electron or Fluid API is exposed here.
export function visualizationDocument(fragment: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{color-scheme:light dark;--background:light-dark(#fff,#17191f);--foreground:light-dark(#20232a,#e8e9ef);--card:light-dark(#f3f4f7,#252831);--card-foreground:var(--foreground);--popover:var(--card);--popover-foreground:var(--foreground);--primary:var(--foreground);--primary-foreground:var(--background);--secondary:var(--card);--secondary-foreground:var(--foreground);--muted:var(--card);--muted-foreground:light-dark(#626775,#a4aaba);--accent:var(--card);--accent-foreground:var(--foreground);--destructive:light-dark(#bc2437,#ff8d9c);--border:light-dark(#d2d6df,#454a59);--input:var(--border);--ring:light-dark(#356fd1,#9cbbff);--blue:light-dark(#236dc7,#89b8ff);--orange:light-dark(#b85b18,#f7b278);--green:light-dark(#277449,#8cd4a6);--red:var(--destructive);--purple:light-dark(#8050b0,#c6a4ed);--yellow:light-dark(#866500,#e8d276);--viz-series-1:var(--blue);--viz-series-2:var(--orange);--viz-series-3:var(--green);--viz-series-4:var(--purple);--viz-series-5:var(--red);--viz-series-6:var(--yellow);--font-size-base:14px}
*{box-sizing:border-box}html,body{margin:0;padding:0;background:transparent;color:var(--foreground);font:400 var(--font-size-base)/1.5 system-ui,sans-serif}body{display:flow-root;overflow-wrap:anywhere}button,input,select,textarea{font:inherit;color:inherit}button,a,input,select,textarea{touch-action:manipulation}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}h1,h2,h3{font-weight:500;line-height:1.3}h1{font-size:1.4rem}h2{font-size:1.2rem}h3{font-size:1rem}a{color:var(--blue)}img,svg,canvas{max-width:100%}[hidden]{display:none!important}
.card{padding:16px;background:var(--card);color:var(--card-foreground);border:1px solid var(--border);border-radius:12px}.viz-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:12px}.viz-row,.viz-controls,.nav{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.viz-controls{margin:12px 0}.viz-stat-value{font-size:1.7rem;font-weight:500}.viz-badge{display:inline-block;padding:2px 8px;background:var(--secondary);border-radius:20px}.btn,.nav-link{padding:6px 12px;border:1px solid var(--border);border-radius:6px;background:var(--secondary);color:var(--secondary-foreground);text-decoration:none}.btn-primary,.btn[aria-pressed=true],.btn[aria-selected=true]{background:var(--primary);color:var(--primary-foreground)}.btn-ghost{background:transparent;border-color:transparent}.btn-block{width:100%}.nav-link.active{background:var(--accent)}.nav-justified>*{flex:1}.form-label{display:grid;gap:4px}.form-control,.form-select{min-width:0;max-width:100%;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--background)}.form-check{display:flex;align-items:center;gap:8px}.form-range{max-width:100%;accent-color:var(--blue)}.form-control-color{padding:2px}.viz-tile{display:grid;place-items:center;min-height:40px}.progress{height:8px;border-radius:6px;overflow:hidden;background:var(--muted)}.progress-bar{height:100%;background:var(--viz-series-1)}.table{width:100%;border-collapse:collapse}.table th,.table td{text-align:left;padding:8px;border-bottom:1px solid var(--border)}.table-sm td,.table-sm th{padding:4px}.table-responsive{overflow-x:auto}.text-small{font-size:.857rem}.text-muted{color:var(--muted-foreground)}.text-destructive{color:var(--destructive)}.text-end{text-align:right!important}.text-center{text-align:center!important}.text-nowrap{white-space:nowrap}.tabular-nums{font-variant-numeric:tabular-nums}pre{overflow:auto}code{font-family:ui-monospace,monospace}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}hr{border:0;border-top:1px solid var(--border)}@media(pointer:coarse){button,input,select{min-height:44px}input,select,textarea{font-size:16px}}
</style>
<script src="https://cdn.jsdelivr.net/npm/lucide@0.468.0/dist/umd/lucide.min.js"></script>
<script>
(() => {
  const send = (type, data = {}) => parent.postMessage({channel:'fluid-visualization',type,...data}, '*');
  window.openai = Object.freeze({sendFollowUpMessage: async ({prompt}) => {
    if(typeof prompt !== 'string' || !prompt.trim() || prompt.length > 10000) throw new Error('Invalid follow-up');
    send('followup', {prompt});
  }});
  addEventListener('message', event => {
    if(event.source !== parent || event.data?.channel !== 'fluid-visualization' || event.data.type !== 'theme') return;
    for(const [name,value] of Object.entries(event.data.colors || {})) {
      if(/^--[a-z-]+$/.test(name) && typeof value === 'string' && CSS.supports('color', value)) document.documentElement.style.setProperty(name,value);
    }
  });
  addEventListener('DOMContentLoaded', () => {
    window.lucide?.createIcons({attrs:{width:16,height:16}});
    let last = 0;
    const resize = () => {
      const height = Math.ceil(document.body.getBoundingClientRect().height);
      if(height !== last) {last = height; send('resize',{height});}
    };
    new ResizeObserver(resize).observe(document.body); resize();
    document.querySelectorAll('[data-tooltip]').forEach(el => el.setAttribute('title', el.getAttribute('data-tooltip')));
    document.addEventListener('click', event => {
      const tab = event.target.closest('[role=tab]');
      const group = tab?.closest('[role=tablist]');
      if(!group || tab.disabled) return;
      for(const sibling of group.querySelectorAll('[role=tab]')) {
        const active = sibling === tab;
        sibling.setAttribute('aria-selected',String(active)); sibling.classList.toggle('active',active);
        const panel = document.getElementById(sibling.getAttribute('aria-controls')); if(panel) panel.hidden = !active;
      }
    });
    send('ready');
  });
})();
</script>
</head><body>${fragment}</body></html>`
}
