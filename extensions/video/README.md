# @fluid/extension-video

The `video/*` file player. Start with the
[shared development setup](../../packages/sdk/README.md#develop-a-built-in-extension).

[src/index.ts](src/index.ts) registers the player;
[VideoView.svelte](src/views/VideoView.svelte) implements playback controls,
seeking, and the ambient background. [views/index.svelte.ts](src/views/index.svelte.ts)
mounts it.

Files stream from the desktop file store, and codec support comes from Chromium.
Check play/pause, scrubbing, mute, keyboard controls, and end-of-video replay with
supported media. When changing the ambient background, verify it stays aligned
with the foreground video after seeking.
