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

  // A fresh name every time. \`window.open\` with a name that is already open
  // does not open anything: it navigates that window to the address, and a
  // navigation to about:blank is a new, empty document — whatever the site had
  // already put in the old one is gone, and the site is never told.
  var openPopup = function (width, height) {
    try {
      opened += 1
      return window.open('about:blank', FRAME + ':' + opened, 'width=' + Math.round(width) + ',height=' + Math.round(height))
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
    var popup = openPopup(Math.min(Math.max(Math.round(height * ratio), 240), 640), height)
    if (!popup) return false

    held = popup
    setStyles(popup.document.body, { margin: '0', background: '#000', height: '100vh', overflow: 'hidden' })

    var copy = popup.document.createElement('video')
    copy.autoplay = true
    copy.muted = true
    copy.playsInline = true
    setStyles(copy, { width: '100%', height: '100%', 'object-fit': 'contain', background: '#000' })
    popup.document.body.appendChild(copy)
    copy.srcObject = stream
    var playing = copy.play()
    if (playing && playing.catch) playing.catch(function () {})
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
      held = null
      native = false
      return 'clean'
    }
  }

  return 'installed'
})()`
