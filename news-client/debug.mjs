// Lines for the loader's on-screen debug overlay (<jlpt-news-debug>). The loader hands the main script
// JLPT_NEWS.debug: a function when it ran the bundle with new Function, but only the JSON value
// (true / false) when it had to inject a <script>; then the line goes to the loader as a
// 'jlpt-news-debug' event whose detail is the JSON text {message, level}. Anything else (false, or
// no debug at all from a loader installed before the overlay): debug is off.
let sink;

export function configureDebug(value) {
  sink = value;
}

// level: 'ok' | 'warn' | 'error' | undefined. Never throws.
export function debug(message, level) {
  try {
    if (typeof sink === 'function') return void sink(String(message), level);
    if (sink !== true) return;
    document.dispatchEvent(new CustomEvent('jlpt-news-debug', {detail: JSON.stringify({message: String(message), level})}));
  } catch {
    // The overlay is only a help; the script goes on without it.
  }
}
