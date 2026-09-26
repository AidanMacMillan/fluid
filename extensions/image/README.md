# @fluid/extension-image

The `image/*` file viewer. Start with the
[shared development setup](../../packages/sdk/README.md#develop-a-built-in-extension).

[src/index.ts](src/index.ts) registers the viewer;
[ImageView.svelte](src/views/ImageView.svelte) implements zoom, pan, and image
presentation. [views/index.svelte.ts](src/views/index.svelte.ts) mounts it.

Keep zoom and pan in the tab's view state so returning to an image restores its
position. When changing interactions, check fit-to-window, zoom limits, dragging,
resizing, and restoration after switching tabs. Include both a large image and
one with transparency.
