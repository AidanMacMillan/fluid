/**
 * The miniplayer's half inside the page.
 *
 * Chrome has a contract for this and sites already implement it: a page that
 * wants to stay watchable after you look away registers a media session
 * handler for `enterpictureinpicture`, and the browser calls that handler
 * itself when the tab is hidden. Google Meet, Jitsi and every video site worth
 * the name are on the other end of it already. So the miniplayer is not a
 * feature invented here — it is the browser half of a contract this app was
 * not holding up, and this script is that half.
 *
 * Two things stop it working in Electron as it stands:
 *
 * - Nothing fires the handler, because the part of Chrome that notices a tab
 *   went away and calls it is Chrome's own browser UI, which Electron does not
 *   have. `enter` below is that caller.
 * - `documentPictureInPicture` is exposed but inert: `requestWindow` resolves
 *   with a window that is 0x0, already closed, and never drawn, so a site that
 *   takes the contract at its word quietly loses its interface into nothing
 *   (electron/electron#39633, open since 2023). The polyfill below replaces it
 *   with a real popup, which `handleWindowOpen` then turns into a floating
 *   window — see `MINIPLAYER_FRAME` there.
 *
 * It runs in the page's main world, which is why it is a source string rather
 * than a preload: a preload runs in the isolated world, and `mediaSession` and
 * `documentPictureInPicture` have to be replaced where the page's own scripts
 * will look them up.
 *
 * It is injected on `dom-ready`, which is late — every script in the document
 * has already run by then, and no event Electron offers fires any earlier
 * (`did-navigate`, `did-frame-navigate` and `did-start-loading` were all
 * measured landing after the page's own inline scripts). The only way in
 * ahead of them is `Page.addScriptToEvaluateOnNewDocument` over an attached
 * debugger, and a debugger attached to every page is DevTools refusing to
 * open — which in a browser built for development is the worse of the two.
 *
 * So the gap is a page that registers its handler while the document is
 * parsing, whose registration this never sees. Real sites register when a call
 * is joined or a video starts playing, both long after, and the ones that do
 * not still get the video path below: the call tile floats, rather than the
 * interface the site would have drawn for it.
 *
 * Every entry point is wrapped, and every failure is silent: this is code
 * running inside somebody else's page, and a miniplayer that does not open is
 * a disappointment, while a page that stops working is a bug.
 */

/**
 * The window name the agent opens its popup under. The main process reads it
 * off the `window.open` to tell a miniplayer apart from a sign-in popup, which
 * is the one thing the two have in common (see `handleWindowOpen`).
 */
export const MINIPLAYER_FRAME = '__fluid_miniplayer'

/**
 * Whether a `window.open` name is one the agent opened a miniplayer under.
 * Each window gets a name of its own — the frame name plus a count — for the
 * reason given at `requestWindow` in the agent.
 */
export function isMiniplayerFrame(name: string): boolean {
  return name === MINIPLAYER_FRAME || name.startsWith(`${MINIPLAYER_FRAME}:`)
}

/** What `enter` did, reported back so the main process knows what it has. */
export type MiniplayerKind = 'call' | 'video' | 'none'

/**
 * The script itself, as source. Written without template literals so that it
 * can live inside one.
 */
export const MINIPLAYER_AGENT = `(() => {
  if (window.__fluidMiniplayer) return 'present'

  var FRAME = ${JSON.stringify(MINIPLAYER_FRAME)}

  // The handlers the page has registered, the window currently holding the
  // miniplayer, the capture tracks it has open, and what has to be put back
  // when the miniplayer closes.
  var handlers = new Map()
  var tracks = new Set()
  var held = null
  var native = false
  var opened = 0
  var disposeVideoControls = null

  // A fresh name every time. \`window.open\` with a name that is already open
  // does not open anything: it navigates that window to the address, and a
  // navigation to about:blank is a new, empty document — whatever the site had
  // already put in the old one is gone, and the site is never told.
  var openPopup = function (width, height, aspectRatio) {
    try {
      opened += 1
      var features = 'width=' + Math.round(width) + ',height=' + Math.round(height)
      // Only the captured-video path locks its shape. A site's own call
      // interface needs to be free to rearrange itself when resized.
      if (aspectRatio) features += ',fluid-video-aspect-ratio=' + aspectRatio
      return window.open('about:blank', FRAME + ':' + opened, features)
    } catch (error) {
      return null
    }
  }

  // Whether the page is on a call, which is half of what makes it eligible.
  // Read off the tracks rather than counted as they end: a track that has
  // stopped says so itself, and nothing has to stay subscribed to hear it.
  var capturing = function () {
    var live = false
    tracks.forEach(function (track) {
      if (track.readyState === 'live') live = true
    })
    return live
  }

  // The same question asked of the page instead of of this script, for the
  // call that was already up before this script arrived: capture is only seen
  // above when \`getUserMedia\` is called after the wrapper is in place, and a
  // document that loaded mid-call never calls it again. A video playing a
  // \`MediaStream\` is a call by any other name — a file or a normal video has a
  // \`src\`, and only live media arrives as a stream.
  var streaming = function () {
    var videos = document.querySelectorAll('video')
    for (var i = 0; i < videos.length; i++) {
      var video = videos[i]
      if (video.paused) continue
      var source = video.srcObject
      if (source && typeof MediaStream !== 'undefined' && source instanceof MediaStream) return true
    }
    return false
  }

  // Styles are assigned one property at a time through the CSSOM rather than
  // parsed from a string. The pages this runs in are the strictest on the web:
  // Google's enforce Trusted Types, and their content policies can refuse an
  // injected \`<style>\` element. A popup opened on about:blank inherits the
  // opener's policy along with its origin, so the miniplayer window is
  // governed by the site's rules too.
  var setStyles = function (element, styles) {
    for (var name in styles) {
      if (!Object.prototype.hasOwnProperty.call(styles, name)) continue
      try {
        element.style.setProperty(name, styles[name])
      } catch (error) {}
    }
  }

  // --- documentPictureInPicture -------------------------------------------

  var events = new EventTarget()
  var api = {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    requestWindow: function (options) {
      var settings = options || {}
      // Only from a click, as the real one insists: every window this opens
      // becomes a miniplayer — frameless, above everything, on every space —
      // and a page must not be able to put one up by itself. The app's own
      // offer passes, because it asks the page to enter as a user gesture.
      var activation = navigator.userActivation
      if (activation && !activation.isActive) {
        return Promise.reject(new DOMException('requestWindow requires user activation', 'NotAllowedError'))
      }
      // Asking again while a window is open is allowed, and the answer is a
      // new window with the old one closed — which Meet relies on. The new one
      // is opened first: the main process takes a miniplayer window only from
      // a tab that is entering one or already has one up, and closing first
      // would leave it with neither for as long as the close took to land.
      var previous = held
      var popup = openPopup(settings.width || 400, settings.height || 300)
      if (!popup) return Promise.reject(new DOMException('no window', 'InvalidStateError'))
      held = popup
      if (previous && previous !== popup && !previous.closed) {
        try { previous.close() } catch (error) {}
      }
      setTimeout(function () {
        var entered = new Event('enter')
        entered.window = popup
        events.dispatchEvent(entered)
      }, 0)
      return Promise.resolve(popup)
    }
  }
  Object.defineProperty(api, 'window', {
    get: function () { return held && !held.closed ? held : null }
  })
  try {
    Object.defineProperty(window, 'documentPictureInPicture', { value: api, configurable: true })
  } catch (error) {}

  // --- the page's own handlers --------------------------------------------

  try {
    var session = navigator.mediaSession
    if (session && session.setActionHandler) {
      var original = session.setActionHandler.bind(session)
      var patched = function (action, handler) {
        if (handler) handlers.set(action, handler)
        else handlers.delete(action)
        // Passed along as well: the page asked the browser for something, and
        // listening in is not a reason to stop it being asked.
        try { return original(action, handler) } catch (error) { return undefined }
      }
      patched.__patched = true
      session.setActionHandler = patched
    }
  } catch (error) {}

  try {
    var devices = navigator.mediaDevices
    if (devices && devices.getUserMedia) {
      var getUserMedia = devices.getUserMedia.bind(devices)
      devices.getUserMedia = function (constraints) {
        return getUserMedia(constraints).then(function (stream) {
          stream.getTracks().forEach(function (track) { tracks.add(track) })
          return stream
        })
      }
    }
  } catch (error) {}

  // --- the video path ------------------------------------------------------

  var playingVideo = function () {
    var best = null
    var bestArea = 0
    var videos = document.querySelectorAll('video')
    for (var i = 0; i < videos.length; i++) {
      var video = videos[i]
      if (video.paused || video.ended || video.readyState < 2) continue
      if (!video.videoWidth || !video.videoHeight) continue
      var area = video.videoWidth * video.videoHeight
      if (area > bestArea) { best = video; bestArea = area }
    }
    return best
  }

  // Captured frames do not include text tracks or YouTube's separate caption
  // layer. Mirror the currently displayed text without changing the site's
  // caption selection, fetching another transcript, or moving its DOM.
  var addVideoCaptions = function (popup, video) {
    var caption = popup.document.createElement('div')
    setStyles(caption, {
      position: 'absolute', left: '12px', right: '12px', bottom: '12px',
      'text-align': 'center', 'pointer-events': 'none', 'z-index': '1',
      color: '#fff', font: '500 clamp(12px, 3.5vw, 22px)/1.4 system-ui, sans-serif',
      'white-space': 'pre-line', 'overflow-wrap': 'anywhere', display: 'none'
    })
    var text = popup.document.createElement('span')
    setStyles(text, {
      background: 'rgba(0,0,0,0.8)', padding: '2px 6px', 'border-radius': '3px',
      'box-decoration-break': 'clone', '-webkit-box-decoration-break': 'clone'
    })
    caption.appendChild(text)
    popup.document.body.appendChild(caption)

    var player = video.closest('.html5-video-player')
    var container = null
    var tracks = []
    var disposed = false
    var visible = function (element) {
      if (!element.isConnected || !element.getClientRects().length) return false
      for (var node = element; node && node !== player; node = node.parentElement) {
        var style = getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
      }
      return true
    }
    var render = function () {
      if (disposed) return
      var lines = []
      if (container && visible(container)) {
        container.querySelectorAll('.caption-visual-line').forEach(function (line) {
          if (visible(line) && line.textContent.trim()) lines.push(line.textContent.trim())
        })
      }
      if (!lines.length) {
        tracks.forEach(function (track) {
          if (track.mode !== 'showing' || (track.kind !== 'subtitles' && track.kind !== 'captions')) return
          Array.from(track.activeCues || []).forEach(function (cue) {
            var value = typeof cue.getCueAsHTML === 'function' ? cue.getCueAsHTML().textContent : cue.text
            if (value) lines.push(value)
          })
        })
      }
      var value = lines.join('\\n')
      if (text.textContent !== value) text.textContent = value
      caption.style.display = value ? 'block' : 'none'
    }
    var captionObserver = new MutationObserver(render)
    var findContainer = function () {
      var next = player.querySelector('.ytp-caption-window-container')
      if (next === container) return
      captionObserver.disconnect()
      container = next
      if (container) captionObserver.observe(container, {
        childList: true, subtree: true, characterData: true, attributes: true,
        attributeFilter: ['style', 'class', 'hidden', 'aria-hidden']
      })
      render()
    }
    // YouTube can replace the layer when captions are toggled or its language
    // changes. Watch for that without observing every progress-bar style tick.
    var playerObserver = new MutationObserver(findContainer)
    if (player) {
      playerObserver.observe(player, { childList: true, subtree: true })
      findContainer()
    }
    var syncTracks = function () {
      tracks.forEach(function (track) { track.removeEventListener('cuechange', render) })
      tracks = Array.from(video.textTracks)
      tracks.forEach(function (track) { track.addEventListener('cuechange', render) })
      render()
    }
    var trackEvents = ['addtrack', 'removetrack', 'change']
    trackEvents.forEach(function (name) { video.textTracks.addEventListener(name, syncTracks) })
    syncTracks()
    return {
      element: caption,
      dispose: function () {
        disposed = true
        captionObserver.disconnect()
        playerObserver.disconnect()
        tracks.forEach(function (track) { track.removeEventListener('cuechange', render) })
        trackEvents.forEach(function (name) { video.textTracks.removeEventListener(name, syncTracks) })
        caption.remove()
      }
    }
  }

  // These controls belong to the original video: the popup's muted stream
  // only carries its frames and has no playhead of its own to seek.
  var addVideoControls = function (popup, video) {
    var doc = popup.document
    var captions = addVideoCaptions(popup, video)
    var overlay = doc.createElement('div')
    setStyles(overlay, {
      position: 'absolute', inset: '0', display: 'flex', 'align-items': 'center',
      'justify-content': 'center', gap: '16px', background: 'rgba(0,0,0,0.12)',
      opacity: '0', transition: 'opacity 160ms ease', 'pointer-events': 'none', 'z-index': '2'
    })
    doc.body.appendChild(overlay)

    // Phosphor's play-fill, pause-fill, arrow-counter-clockwise and arrow-clockwise.
    var paths = {
      play: 'M240 128a15.74 15.74 0 0 1-7.6 13.51L88.32 229.65a16 16 0 0 1-16.2.3A15.86 15.86 0 0 1 64 216.13V39.87a15.86 15.86 0 0 1 8.12-13.82a16 16 0 0 1 16.2.3l144.08 88.14A15.74 15.74 0 0 1 240 128',
      pause: 'M216 48v160a16 16 0 0 1-16 16h-40a16 16 0 0 1-16-16V48a16 16 0 0 1 16-16h40a16 16 0 0 1 16 16M96 32H56a16 16 0 0 0-16 16v160a16 16 0 0 0 16 16h40a16 16 0 0 0 16-16V48a16 16 0 0 0-16-16',
      backward: 'M224 128a96 96 0 0 1-94.71 96H128a95.38 95.38 0 0 1-65.9-26.2a8 8 0 0 1 11-11.63a80 80 0 1 0-1.67-114.78a3 3 0 0 1-.26.25L44.59 96H72a8 8 0 0 1 0 16H24a8 8 0 0 1-8-8V56a8 8 0 0 1 16 0v29.8L60.25 60A96 96 0 0 1 224 128',
      forward: 'M240 56v48a8 8 0 0 1-8 8h-48a8 8 0 0 1 0-16h27.4l-26.59-24.36l-.25-.24a80 80 0 1 0-1.67 114.78a8 8 0 0 1 11 11.63A95.44 95.44 0 0 1 128 224h-1.32a96 96 0 1 1 69.07-164L224 85.8V56a8 8 0 1 1 16 0'
    }
    var makeButton = function (label, icon, primary, action) {
      var button = doc.createElement('button')
      button.type = 'button'
      button.title = label
      button.setAttribute('aria-label', label)
      setStyles(button, {
        display: 'grid', 'place-items': 'center', width: primary ? '52px' : '40px',
        height: primary ? '52px' : '40px', padding: '0', border: '1px solid rgba(255,255,255,0.2)',
        'border-radius': '50%', color: '#fff', background: 'rgba(18,18,22,0.7)',
        'box-shadow': '0 2px 12px rgba(0,0,0,0.2)', 'backdrop-filter': 'blur(12px)',
        cursor: 'pointer', 'pointer-events': 'none', 'flex-shrink': '0'
      })
      // DOM construction also works on pages enforcing Trusted Types; no
      // HTML strings, external icons or stylesheet injections are needed.
      var svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 256 256')
      svg.setAttribute('width', primary ? '26' : '20')
      svg.setAttribute('height', primary ? '26' : '20')
      svg.setAttribute('aria-hidden', 'true')
      svg.setAttribute('fill', 'currentColor')
      var path = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', paths[icon])
      svg.appendChild(path)
      button.appendChild(svg)
      button.addEventListener('click', action)
      overlay.appendChild(button)
      return { button: button, path: path }
    }

    var seekTo = function (seconds) {
      if (!Number.isFinite(video.duration) || video.duration <= 0) return
      try { video.currentTime = Math.max(0, Math.min(video.duration, seconds)) } catch (error) {}
    }
    var backward = makeButton('Skip backward 5 seconds', 'backward', false, function () { seekTo(video.currentTime - 5) })
    var toggle = makeButton('Pause', 'pause', true, function () {
      if (video.paused || video.ended) {
        if (video.ended) seekTo(0)
        var request = video.play()
        if (request && request.catch) request.catch(function () {})
      } else video.pause()
    })
    var forward = makeButton('Skip forward 5 seconds', 'forward', false, function () { seekTo(video.currentTime + 5) })

    var transport = doc.createElement('div')
    setStyles(transport, {
      position: 'absolute', left: '0', right: '0', bottom: '0', display: 'flex',
      'align-items': 'center', gap: '10px', padding: '24px 14px 12px',
      background: 'linear-gradient(transparent, rgba(0,0,0,0.65))',
      color: '#fff', font: '11px system-ui, sans-serif', 'font-variant-numeric': 'tabular-nums'
    })
    overlay.appendChild(transport)
    var elapsed = doc.createElement('span')
    var total = doc.createElement('span')
    ;[elapsed, total].forEach(function (label) { setStyles(label, { 'flex-shrink': '0' }) })
    var seek = doc.createElement('input')
    seek.type = 'range'
    seek.min = '0'
    seek.max = '0'
    seek.step = '0.1'
    seek.value = '0'
    seek.setAttribute('aria-label', 'Seek')
    setStyles(seek, {
      flex: '1', 'min-width': '0', height: '16px', margin: '0', padding: '0',
      'accent-color': '#fff', 'color-scheme': 'dark', cursor: 'pointer',
      'pointer-events': 'none'
    })
    transport.appendChild(elapsed)
    transport.appendChild(seek)
    transport.appendChild(total)
    var controls = [backward.button, toggle.button, forward.button, seek]
    var hovering = doc.documentElement.matches(':hover')
    var scrubbing = false
    var disposed = false

    var formatTime = function (seconds) {
      if (!Number.isFinite(seconds)) return '--:--'
      var whole = Math.max(0, Math.floor(seconds))
      var hours = Math.floor(whole / 3600)
      var minutes = Math.floor((whole % 3600) / 60)
      var rest = String(whole % 60).padStart(2, '0')
      return hours ? hours + ':' + String(minutes).padStart(2, '0') + ':' + rest : minutes + ':' + rest
    }
    var updateVisibility = function () {
      if (disposed) return
      // Pausing or receiving a media event never reveals the overlay. Keyboard
      // focus can still reveal it so the controls are usable without a mouse.
      var keyboardFocus = doc.hasFocus() && controls.some(function (control) { return control.matches(':focus-visible') })
      var visible = hovering || scrubbing || keyboardFocus
      overlay.style.opacity = visible ? '1' : '0'
      captions.element.style.bottom = visible ? '48px' : '12px'
      controls.forEach(function (control) { control.style.pointerEvents = visible ? 'auto' : 'none' })
    }
    var updateTime = function () {
      var duration = video.duration
      var seekable = Number.isFinite(duration) && duration > 0
      if (seek.disabled !== !seekable) seek.disabled = !seekable
      // Keep the range's configuration stable while its thumb is being dragged.
      var maximum = seekable ? String(duration) : '0'
      if (seek.max !== maximum) seek.max = maximum
      if (!scrubbing) seek.value = seekable ? String(video.currentTime) : '0'
      var position = scrubbing ? Number(seek.value) : video.currentTime
      elapsed.textContent = formatTime(position)
      total.textContent = formatTime(duration)
      seek.setAttribute('aria-valuetext', formatTime(position) + ' of ' + formatTime(duration))
      seek.style.opacity = seekable ? '1' : '0.4'
      seek.style.cursor = seekable ? 'pointer' : 'default'
    }
    var update = function () {
      var paused = video.paused || video.ended
      toggle.path.setAttribute('d', paths[paused ? 'play' : 'pause'])
      toggle.button.title = paused ? 'Play' : 'Pause'
      toggle.button.setAttribute('aria-label', paused ? 'Play' : 'Pause')
      var seekable = Number.isFinite(video.duration) && video.duration > 0
      ;[backward.button, forward.button].forEach(function (button) {
        button.disabled = !seekable
        button.style.opacity = seekable ? '1' : '0.4'
        button.style.cursor = seekable ? 'pointer' : 'default'
      })
      updateTime()
    }
    seek.addEventListener('pointerdown', function () { scrubbing = true; updateVisibility() })
    seek.addEventListener('input', function () {
      scrubbing = true
      seekTo(Number(seek.value))
      updateTime()
    })
    var endScrub = function () { scrubbing = false; updateTime(); updateVisibility() }
    seek.addEventListener('change', endScrub)
    seek.addEventListener('pointerup', endScrub)
    seek.addEventListener('pointercancel', endScrub)
    seek.addEventListener('blur', endScrub)
    var onEnter = function (event) {
      // Pointer capture during a seek can deliver moves outside the window.
      hovering = event.clientX >= 0 && event.clientX < popup.innerWidth &&
        event.clientY >= 0 && event.clientY < popup.innerHeight
      updateVisibility()
    }
    var onLeave = function () { hovering = false; updateVisibility() }
    var onBlur = function () { hovering = false; endScrub() }
    doc.documentElement.addEventListener('pointerenter', onEnter)
    doc.documentElement.addEventListener('pointerleave', onLeave)
    doc.addEventListener('pointermove', onEnter)
    doc.addEventListener('focusin', updateVisibility)
    var onFocusOut = function () { queueMicrotask(updateVisibility) }
    doc.addEventListener('focusout', onFocusOut)
    popup.addEventListener('blur', onBlur)
    var events = ['play', 'pause', 'ended', 'durationchange', 'loadedmetadata', 'emptied']
    events.forEach(function (name) { video.addEventListener(name, update) })
    video.addEventListener('timeupdate', updateTime)
    update()
    updateVisibility()

    var dispose = function () {
      disposed = true
      captions.dispose()
      events.forEach(function (name) { video.removeEventListener(name, update) })
      video.removeEventListener('timeupdate', updateTime)
      doc.documentElement.removeEventListener('pointerenter', onEnter)
      doc.documentElement.removeEventListener('pointerleave', onLeave)
      doc.removeEventListener('pointermove', onEnter)
      doc.removeEventListener('focusin', updateVisibility)
      doc.removeEventListener('focusout', onFocusOut)
      popup.removeEventListener('blur', onBlur)
      popup.removeEventListener('pagehide', dispose)
      if (disposeVideoControls === dispose) disposeVideoControls = null
    }
    popup.addEventListener('pagehide', dispose)
    return dispose
  }

  // The miniplayer shows the video without taking it, by playing the stream
  // the element is already producing.
  //
  // Moving the element itself was the obvious approach and it does not work.
  // A media element moved to another document has its resource torn down —
  // measured on YouTube: \`readyState\` 0, paused, and a black window — and a
  // site with an opinion about its own player, which is every large one, puts
  // a replacement in the page before the frame is out. \`captureStream\` asks
  // for none of that: the element stays exactly where the page put it, still
  // playing, and what crosses into the window is frames.
  //
  // The copy is muted because the original is not. It keeps playing in the
  // hidden tab, which is where the sound should come from — a tab is throttled
  // when it is hidden but never silenced — and two copies of the same audio is
  // worse than none.
  var openForVideo = function (video) {
    var stream = null
    try {
      if (video.captureStream) stream = video.captureStream()
      else if (video.mozCaptureStream) stream = video.mozCaptureStream()
    } catch (error) {
      stream = null
    }
    // Protected content refuses to be captured, and that refusal is the point
    // of it. The browser's own picture-in-picture can still show it.
    if (!stream) return nativePictureInPicture(video)

    var height = 260
    var ratio = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9
    var popup = openPopup(Math.min(Math.max(Math.round(height * ratio), 240), 640), height, ratio)
    if (!popup) return false

    held = popup
    setStyles(popup.document.body, { margin: '0', background: '#000', height: '100vh', overflow: 'hidden', position: 'relative' })

    var copy = popup.document.createElement('video')
    copy.autoplay = true
    copy.muted = true
    copy.playsInline = true
    copy.draggable = false
    setStyles(copy, { width: '100%', height: '100%', 'object-fit': 'contain', background: '#000' })
    popup.document.body.appendChild(copy)
    copy.srcObject = stream
    var playing = copy.play()
    if (playing && playing.catch) playing.catch(function () {})
    if (disposeVideoControls) disposeVideoControls()
    disposeVideoControls = addVideoControls(popup, video)
    return true
  }

  // The fallback, and the one thing here that is not this app's own window:
  // Chromium's picture-in-picture, which works in Electron and needs no
  // cooperation from the page. No bar above it — it is the browser's window,
  // not one of ours — so there is nothing to hang a button on, and the way
  // back is the tab itself.
  var nativePictureInPicture = function (video) {
    try {
      if (!document.pictureInPictureEnabled) return false
      var request = video.requestPictureInPicture()
      if (request && request.catch) request.catch(function () {})
      native = true
      return true
    } catch (error) {
      return false
    }
  }

  // --- what the main process calls ----------------------------------------

  window.__fluidMiniplayer = {
    // Chrome's rule, as close as it can be kept: a call is a page that has
    // registered the handler and is actually capturing. \`audible\` is the main
    // process's answer to the same question from the outside, for the call
    // joined with the camera and microphone already off.
    enter: function (reason, options) {
      try {
        if (held && !held.closed) return 'open'
        if (native && document.pictureInPictureElement) return 'open'
        var settings = options || {}
        var handler = handlers.get('enterpictureinpicture')
        if (handler && (capturing() || streaming() || settings.audible)) {
          try {
            handler({ action: 'enterpictureinpicture', reason: reason || 'contentoccluded' })
            return 'call'
          } catch (error) {
            // Fall through: a site that throws here still has a video.
          }
        }
        var video = playingVideo()
        if (!video) return 'none'
        return openForVideo(video) ? 'video' : 'none'
      } catch (error) {
        return 'none'
      }
    },

    // Closing the window is how a site is told it is out: Meet and the rest
    // listen for \`pagehide\` on the window they were given and take their
    // interface home. The video path needs no such telling — the page never
    // knew it was in a miniplayer, because nothing was taken from it.
    leave: function () {
      if (disposeVideoControls) disposeVideoControls()
      try {
        var window_ = held
        held = null
        if (window_ && !window_.closed) window_.close()
      } catch (error) {}
      try {
        if (native && document.pictureInPictureElement) document.exitPictureInPicture()
      } catch (error) {}
      native = false
      return 'left'
    },

    // The same, for a window that has already gone — closed by the user, or
    // taken away with the tab. Nothing to undo but the bookkeeping.
    cleanup: function () {
      // Unless a newer window has taken its place in the meantime, which is
      // what a window closed by \`requestWindow\` itself looks like from here.
      if (held && !held.closed) return 'kept'
      if (disposeVideoControls) disposeVideoControls()
      held = null
      native = false
      return 'clean'
    }
  }

  return 'installed'
})()`
