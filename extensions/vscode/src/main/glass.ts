/**
 * Makes the workbench glass, in three depths.
 *
 * Not one transparency but three, because a window you can see through is only
 * an improvement where there is nothing behind the glass that has to be read:
 *
 * - The backdrop — the shell the parts are laid out on — is barely there. It is
 *   the one layer with nothing on it, so it is the one that can carry the
 *   desktop.
 * - The editor and the chrome around it are thinned rather than emptied. Code
 *   sits on them, and code over a moving desktop is unreadable.
 * - The folder view is not thinned at all. It is deliberately the exception:
 *   the explorer scrolls a tree under pinned parent rows, and a pinned row with
 *   nothing behind it is two lines of text drawn over each other. The same goes
 *   for every other sticky surface here — the editor's sticky scroll, the
 *   sticky tab strip, the terminal's — which is why none of them is touched.
 *
 * A `color-mix` against the workbench's own variable rather than a colour
 * written here, so all of this stays the user's theme: whatever the editor is
 * meant to be, it is that, at `--fluid-surface` of it. The variables are read
 * and never overwritten, precisely so they still hold the theme's answer.
 *
 * `!important` and the tripled class throughout: a part's background is an
 * inline style holding a colour the theme has already resolved, and the modern
 * UI declares its own `!important` backgrounds at two classes' worth of
 * specificity, so an ordinary rule loses to both.
 */
export const WORKBENCH_GLASS = `
  .monaco-workbench {
    /* How much of a surface's own colour survives.

       These are effective values, not per-element ones, and the rules below go
       to some trouble to keep them that way: a zone is painted by exactly one
       element and every layer nested inside it paints nothing. Five nested
       elements each carrying 50% do not read as 50% — they composite to 97%,
       which is a window with no glass in it at all.

       --fluid-surface is the main one: the editor and the bars, which is most of
       what the window is. Raise it if code becomes hard to read.

       --fluid-backdrop is the shell the parts sit on. Nothing is written on it
       and the parts cover nearly all of it, so it can be the thinnest.

       --fluid-widget is the quick pick alone, and is deliberately the most solid
       of the three: it is a list of commands drawn over live code, the one
       surface here where reading what is on it beats seeing what is behind. */
    --fluid-surface: 67%;
    --fluid-backdrop: 10%;
    --fluid-widget: 82%;

    /* The groove a scrollbar runs in, and only the groove. The slider that
       rides in it is --vscode-scrollbarSlider-background, deliberately left
       alone: it is the one part of a scrollbar that says anything, and a
       transparent one could not be found or grabbed. */
    --vscode-scrollbar-background: transparent !important;
  }

  /* Nothing of the document's own behind the workbench. */
  html,
  body {
    background-color: transparent !important;
    background-image: none !important;
  }

  /*
   * The workbench's corner, cut to sit in the well the view is positioned into
   * (glass-well in src/renderer/src/assets/main.css). Top-left only, and 12px
   * because that is --radius-surface: the well's other three sides are seams
   * with the window's own edges and want no curve of their own.
   *
   * It clips rather than just rounds, because .monaco-workbench already sets
   * overflow: hidden — so every part inside is cut to the same corner, which is
   * the whole point: the editor would otherwise paint a square one over it.
   *
   * This is also the one element that paints the backdrop.
   */
  .monaco-workbench.monaco-workbench.monaco-workbench {
    border-radius: 12px 0 0 0 !important;
    background-color: color-mix(
      in srgb,
      var(--modern-ui-shell-background, var(--vscode-editor-background)) var(--fluid-backdrop),
      transparent
    ) !important;
    background-image: none !important;
  }

  /* The editor. One layer paints; see the note on the dials above. */
  .monaco-workbench.monaco-workbench.monaco-workbench .part.editor {
    background-color: color-mix(
      in srgb,
      var(--vscode-editor-background) var(--fluid-surface),
      transparent
    ) !important;
    background-image: none !important;
  }

  /* The bars, each against its own colour rather than the editor's. */
  .monaco-workbench.monaco-workbench.monaco-workbench .part.titlebar {
    background-color: color-mix(
      in srgb,
      var(--vscode-titleBar-activeBackground) var(--fluid-surface),
      transparent
    ) !important;
  }

  .monaco-workbench.monaco-workbench.monaco-workbench .part.statusbar {
    background-color: color-mix(
      in srgb,
      var(--vscode-statusBar-background) var(--fluid-surface),
      transparent
    ) !important;
  }

  .monaco-workbench.monaco-workbench.monaco-workbench .part.panel {
    background-color: color-mix(
      in srgb,
      var(--vscode-panel-background) var(--fluid-surface),
      transparent
    ) !important;
  }

  /*
   * Everything layered inside one of those, which must paint nothing at all.
   *
   * This is the half of the arrangement that makes the dials mean what they
   * say. Each of these sits inside a part that has already been given the
   * zone's colour, so a colour of their own would be a second coat, and the
   * editor is five elements deep.
   *
   * The tab strip and the breadcrumbs are in here too, which costs the small
   * difference a theme puts between the strip and the editor. That is the price
   * of the strip being a layer over the editor rather than beside it, and it is
   * worth paying: the tabs themselves keep their own colours, and they are what
   * marks the active one.
   */
  .monaco-workbench.monaco-workbench.monaco-workbench
    :is(
      .part.editor > .content,
      .part.titlebar > .content,
      .part.statusbar > .content,
      .part.panel > .content,
      .monaco-grid-view,
      .editor-container,
      .editor-group-container,
      .editor-group-container > .title,
      .editor-group-watermark,
      .tabs-container,
      .monaco-breadcrumbs,
      .monaco-editor,
      .monaco-editor .overflow-guard,
      .monaco-editor .margin,
      .monaco-editor-background
    ) {
    background-color: transparent !important;
    background-image: none !important;
  }

  /*
   * The quick pick — the command palette, Go to File, every list that drops
   * from the top.
   *
   * It is the one widget that covers the middle of the window, so a solid slab
   * there reads as a panel welded over the editor while everything around it is
   * glass. Clear is no good either: what is behind it is code. So it takes its
   * own thinning, the mildest here, over a blur that puts the code out of focus.
   *
   * The rule outranks an inline style rather than a stylesheet: the quick
   * pick's background is written onto the element by
   * QuickInputController.updateStyles, already resolved, the same way a part's
   * is. Nothing in the workbench's own CSS sets it.
   */
  .monaco-workbench .quick-input-widget {
    background-color: color-mix(
      in srgb,
      var(--vscode-quickInput-background) var(--fluid-widget),
      transparent
    ) !important;
    backdrop-filter: blur(24px) saturate(180%);
  }
`
