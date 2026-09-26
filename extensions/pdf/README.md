# @fluid/extension-pdf

Registers Chromium's native viewer for `application/pdf` files. Use the
[shared development setup](../../packages/sdk/README.md#develop-a-built-in-extension).

The entire extension is in [src/index.ts](src/index.ts). Its session must be
persisted: Chromium's PDF viewer does not load in an in-memory session. There is
no custom UI bundle; host changes belong in the desktop's
[browser-views.ts](../../packages/desktop/src/main/browser-views.ts).

Check a multipage PDF, search, text selection, zoom, and links out of the document.
If a PDF renders blank, check the native session configuration before changing
the registration.
