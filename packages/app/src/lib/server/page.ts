/**
 * A plain page for the few moments the browser stops at the Worker instead of
 * passing through: a link that is malformed or has expired.
 *
 * Nothing from the request is ever written into it. Every word is one of the
 * fixed strings the routes pass, so there is nothing to escape and nothing to
 * inject.
 */
export function messagePage(status: number, title: string, detail: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --bg: #fafafa; --fg: #18181b; --muted: #52525b; }
  @media (prefers-color-scheme: dark) { :root { --bg: #09090b; --fg: #f4f4f5; --muted: #a1a1aa; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg);
         color: var(--fg); font: 15px/1.5 system-ui, sans-serif; padding: 16px; box-sizing: border-box; }
  main { max-width: 28rem; }
  h1 { font-size: 1.125rem; font-weight: 600; margin: 0 0 0.5rem; }
  p { margin: 0; color: var(--muted); }
</style>
</head>
<body><main><h1>${title}</h1><p>${detail}</p></main></body>
</html>`
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  })
}
