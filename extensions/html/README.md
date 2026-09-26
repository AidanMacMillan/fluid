# @fluid/extension-html

Registers native rendering for `text/html` files. Use the
[shared development setup](../../packages/sdk/README.md#develop-a-built-in-extension).

The entire extension is in [src/index.ts](src/index.ts). It requests an ephemeral
session and a resizable viewport; there is no custom view bundle. Native file
rendering is implemented in the desktop's
[browser-views.ts](../../packages/desktop/src/main/browser-views.ts).

Keep document scripts isolated from extension bridges and browsing profiles.
Check a responsive HTML file at phone and window widths, follow an external link,
and verify that the document cannot navigate away inside its file view.
