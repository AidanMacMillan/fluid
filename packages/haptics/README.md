# Trackpad haptics

A small Node-API bridge to AppKit's alignment feedback, called only from
Electron's main process. macOS chooses the appropriate device and respects
system haptic preferences. Other platforms export a no-op.

`pnpm install` builds the addon on macOS using Xcode Command Line Tools and
node-gyp. Node-API keeps the binary compatible with Electron without a separate
ABI rebuild. Release packaging rebuilds it for each target architecture and
unpacks it from the application archive.

After changing native code, run `pnpm --filter @fluid/haptics run install`.
After changing drag feedback, run `pnpm --filter @fluid/desktop test:haptics`.
To check the feel, drag a tab or task across insertion points on a Force Touch
trackpad, including pinned sections, folders, other tasks, and split edges.
Holding over one target, returning to the original slot, and cancelling should
be silent; entering another valid destination should give a single light tick.
