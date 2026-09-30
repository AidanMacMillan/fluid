# iOS and Android feasibility with Capacitor

Research date: September 27, 2026. Based on the current working tree, including the in-progress `@fluid/agent-core` extraction. This is a source and documentation assessment; no mobile build or device testing has been performed. Effort estimates below are planning judgments, not measured delivery commitments.

**Recommendation:** use Capacitor with Svelte for a mobile version of Fluid, sharing components and domain logic with Electron. Start with projects, tasks, notes, saved links, and access to agents running on a computer or server. Treat Fluid's full browser experience as a separate native development project. Capacitor supplies the mobile application runtime and native bridge; it does not supply Electron's backend.

Capacitor accepts a compiled web application with an asset directory and `index.html`, so Svelte/Vite is a direct fit. There is no need to replace Svelte with Ionic components or move the desktop app to another runtime. See [Capacitor installation](https://capacitorjs.com/docs/getting-started).

**What the repository already gives us**

| Existing area | Reuse potential | Work required |
| --- | --- | --- |
| `@fluid/sdk` models, validation, client, events, tree and split helpers | Strong | Retain platform-neutral contracts; distinguish remote operations from device-local operations. |
| Theme tokens, icons, avatars, task facts, markdown, agent message/tool/approval cards | Strong | Extract reusable UI and adapt spacing, text selection, accessibility, and touch targets. |
| Agent transcript state and `AgentPane` | Promising | Implement a mobile `ViewHost`, remote calls/messages, attachment URLs, reconnect behavior, and mobile layout. |
| Task/project lists, settings, launchers | Partial | Share row/card/form elements; provide mobile navigation and sheets. |
| `Workspace`, `App.svelte`, browser surface and chrome | Limited as-is | Remove direct `window.api` access and desktop window assumptions. Separate data state from platform behavior. |
| Browser sessions, extensions, PTYs, local agent execution, VS Code | Backend/native work | Retain on desktop/server or replace with mobile-specific implementations. |

The best existing boundary is [the SDK transport](../packages/sdk/src/client.ts): `createClient` takes `call` and `subscribe`. The [renderer adapter](../packages/desktop/src/renderer/src/lib/api.ts) currently binds those to Electron's `window.fluid`. A network transport can implement the same shape without rewriting every consumer.

This is only a starting point. [Workspace state](../packages/desktop/src/renderer/src/lib/workspace.svelte.ts) also captures `window.api` at module load and invokes browser, file, project-picker, and notification services. Replacing the SDK transport alone will not make the desktop renderer run on a phone.

The current [agent pane](../packages/agent-core/src/views/components/AgentPane.svelte) already receives a `ViewHost` and provider as props, which is a useful seam for reuse. Its calls, messages, file handling, and split controls still require adaptation. The in-progress package should be validated once its extraction settles.

**Suggested package boundaries**

```text
packages/sdk          Existing contracts, validation, typed client
packages/ui           Shared Svelte components and theme tokens
packages/workspace    Platform-neutral state and operations, extracted gradually
packages/agent-core   Shared agent protocol, transcript, and UI
packages/desktop      Electron shell, IPC, browser, local execution and storage
packages/mobile       Svelte/Vite application + Capacitor ios/ and android/
packages/app          Existing Cloudflare service; extend only for chosen services
```

Keep desktop on Electron. Give mobile its own navigation shell, while rendering shared task details and agent components inside it. Inject a small platform interface for opening links, choosing files, sharing, haptics, lifecycle, and notifications. Advertise capabilities explicitly so unsupported actions are omitted instead of failing at runtime.

Use a separate Vite build with a static `dist` directory for Capacitor. The existing `packages/app` is a SvelteKit Cloudflare Worker for Slack OAuth, not the desktop UI or a workspace synchronization backend; its server routes cannot be bundled as mobile application logic. See [its current responsibilities](../packages/app/README.md).

**The largest product decision is where the workspace lives**

Today, the [database](../packages/desktop/src/main/db/client.ts) lives in Electron's user-data directory. Packaging the UI for mobile gives the phone neither that database nor the computer's files and running processes.

| Approach | Benefit | Main cost or limitation |
| --- | --- | --- |
| Independent mobile workspace | Useful local tasks and notes; no desktop connection needed | Data stays separate until sync is implemented; desktop agents are unavailable. |
| Paired desktop companion | Fastest route to existing tasks and running agents | Computer must be running and reachable; pairing, authentication, secure transport and reconnection are new work. |
| Shared service with desktop execution workers | Workspace available while a computer is asleep; better foundation for multiple devices | Accounts, durable storage, synchronization, conflict handling, attachment storage, notifications, and operations. Local execution still needs an available worker. |

For a feasibility prototype, use an authenticated paired desktop with online mutations and a local read cache/drafts. For an independent daily-use mobile product, plan synchronization as a first-class feature.

A remote transport needs more than a WebSocket around IPC. Add device identity, scoped authorization, protocol versioning, snapshot recovery after disconnects, and safe retry/idempotency for writes. SDK models currently contain `Date` objects, so JSON needs an explicit encoding/revival contract. Keep selected project/tab and layout state per device; blindly sharing desktop activation methods would make devices navigate each other. Agent streams need their own attach/replay lifecycle in addition to workspace events.

Do not expose the existing router's trusted `kind: 'window'` access to a network client. [The current router](../packages/desktop/src/main/api/router.ts) includes privileged file and extension operations. Add an authenticated remote caller with an explicit allowed method set. Transfer attachments as files/blobs behind authorization; local paths and extension-specific URL schemes are not portable identifiers.

PGlite itself is not a mobile blocker: it supports browser IndexedDB persistence. Its current filesystem initialization and migration loading are desktop-specific. A browser-backed PGlite implementation could preserve SQL logic, but needs device measurements for startup, memory, durability, and migrations. Native SQLite is another candidate, with extra schema/query adaptation because the existing schema uses Postgres features. Neither storage choice provides sync automatically. See [PGlite's storage API](https://pglite.dev/docs/api).

**Browser functionality is feasible, but requires native ownership**

[Fluid's browser implementation](../packages/desktop/src/main/browser-views.ts) uses Electron `WebContentsView` objects, session partitions, navigation events, native bounds, and other desktop APIs. They do not exist inside Capacitor's web UI.

For an initial companion, open a saved URL in the system browser or a separate in-app browser. Capacitor's official InAppBrowser provides external, system-browser, and WebView modes. Its documented isolation separates web content from the application; it is not a named, persistent, per-space/per-profile tab manager. Its Android minimum is API 26, and documented isolation differs below API 28. See [InAppBrowser](https://capacitorjs.com/docs/apis/inappbrowser).

For a browser-centered mobile Fluid, build a dedicated native plugin with Swift and Kotlin implementations that manages tab IDs, navigation, visibility/bounds, profiles, lifecycle, downloads, and popup handling. Keep untrusted websites in views without Fluid's privileged application bridge. Share browser chrome where practical, but expect native view layering and keyboard coordination work. An iframe is not a reliable substitute for arbitrary websites because sites can prohibit embedding.

Multiple persistent browser profiles are achievable:

- iOS 17 introduced multiple persistent `WKWebsiteDataStore` instances, suitable for mapping Fluid's space/profile pairs to separate data stores. See [WebKit's profile API](https://webkit.org/blog/14423/building-profiles-with-new-webkit-api/).
- AndroidX WebKit exposes `ProfileStore`, but its `MULTI_PROFILE` capability must be checked at runtime. Define an explicit fallback or unsupported-device policy; do not silently merge isolated profiles. See [Android ProfileStore](https://developer.android.com/reference/androidx/webkit/ProfileStore).

Synchronizing a tab URL does not synchronize its website login. Keep browser cookies local to each device and expect users to authenticate there. Recreating ad blocking is also separate work: the current adapter hooks Electron requests, whereas iOS offers compiled WebKit content rules. Equivalent filter behavior should be tested, not assumed. See [WKContentRuleList](https://developer.apple.com/documentation/webkit/wkcontentrulelist).

**Execution, integrations, and mobile interaction**

Terminal sessions use `node-pty`; VS Code starts a local server; agent backends use Node and desktop processes. These implementations cannot be moved into Capacitor's browser runtime unchanged. Keep execution on a computer or server, and reuse the phone UI to send prompts, inspect results, and respond to approvals. A remote terminal can be a later feature. A remote host is required whenever the requested tools need that host's filesystem or processes.

Do not design mobile agent execution around a continuously running background JavaScript process. Capacitor's Background Runner documents short, OS-scheduled execution windows rather than an always-running service. Keep work on the execution host and refresh/replay when mobile resumes; add push notifications for meaningful events. See [Background Runner limitations](https://capacitorjs.com/docs/apis/background-runner).

Slack currently uses a desktop loopback OAuth listener. Add a mobile callback path using Universal Links/App Links or a registered scheme, preserving PKCE and state verification; store device credentials in platform-protected storage. See [Capacitor deep links](https://capacitorjs.com/docs/guides/deep-links).

Replace desktop right-click menus, hover controls, separate picker windows, and drag-only operations with touch actions and sheets. Use safe-area insets, keyboard-aware composition, Android back navigation, and one primary pane on phones. Tablet layouts can reuse more of the split UI. File import should use device pickers and uploads. Start clipboard capture with explicit paste; receiving shared URLs/files needs a share extension or Android intent integration, separate from an outbound share action.

Ship a curated set of bundled mobile integrations initially. The existing downloadable desktop extension host is not a portable mobile extension system. Apple's rules around executable downloads and minimum functionality need to be considered for the actual product, and screen-mirroring designs can raise additional remote-client requirements. A useful task/notes application with mobile-specific interactions is a stronger submission than a thin collection of website links; approval remains subject to review. See [App Review Guidelines, 2.5.2 and 4.2](https://developer.apple.com/app-store/review/guidelines/).

**Compatibility and build requirements**

The current stable Capacitor documentation is v8. It specifies Node 22+, Xcode 26+ on macOS, and Android Studio 2025.2.1+. The repository's documented Node 24 setup satisfies its Node requirement. See [environment setup](https://capacitorjs.com/docs/getting-started/environment-setup).

Capacitor documents iOS 15+ and Android API 24+ support, but these are runtime floors, not a guarantee for this application's UI. See [iOS support](https://capacitorjs.com/docs/ios) and [Android support](https://capacitorjs.com/docs/android).

Fluid uses Tailwind 4, which targets Safari 16.4+ and Chrome 111+. Additional modern CSS and JavaScript features still require auditing. I would start the browser-profile prototype at iOS 17+ and require a modern Android WebView; the Android OS number alone does not establish all WebView capabilities. Set the mobile Vite build target deliberately rather than inheriting desktop Chromium assumptions. See [Tailwind browser compatibility](https://tailwindcss.com/docs/compatibility).

**A practical validation sequence**

1. Build a small Svelte/Capacitor shell on one physical iPhone and Android device. Render a shared task card and real agent transcript, with keyboard, scrolling, safe areas, and back navigation.
2. Add a paired, authenticated transport for task listing, notes, and one agent session. Verify streaming, approval responses, lock/unlock, network loss, reconnection, and host sleep. Confirm retries do not duplicate writes or prompts.
3. Persist a local cache/draft, terminate and relaunch the app, and test migration and low-connectivity behavior. Measure a representative long transcript on a lower-end device.
4. If browser parity matters, separately prove two isolated persistent profiles, restart survival, logout/reset isolation, navigation, and return-to-app behavior on both platforms. Include Android capability failure and native view overlay tests.

Rough planning ranges for one experienced engineer familiar with this codebase: **1–2 weeks** for the narrow shared-UI/paired-agent spike; **6–10 additional weeks** for a focused paired companion beta with task/notes editing, reconnect behavior, files, and mobile polish. A product with independent cloud sync, accounts, and notification delivery is more plausibly **3–6+ months total**. Full browser profiles, blocking, downloads, and extension parity should be estimated only after the native browser spike; expect months of additional work. These ranges exclude guaranteed app-review timelines and assume the current agent refactor stabilizes.

The immediate go/no-go is therefore favorable for shared Svelte UI in Capacitor. The unresolved choices are the mobile feature scope, desktop dependency versus independent sync, and whether multi-profile browsing belongs in the first release. A fixed code-reuse percentage would be misleading before those choices and the extraction spike.
