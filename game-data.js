/* Unity WebGL chunked-file loader (stays under the ~20MB per-file limit).
 *
 * Large build outputs are stored as <=20MB parts plus a manifest:
 *   Build/data-manifest.json -> Build/data-<hash>/part-*.bin (406MB .data)
 *   Build/wasm-manifest.json -> Build/wasm-<hash>/part-*.bin (71MB .wasm)
 *
 * This file installs a window.fetch override so Unity can keep requesting
 * the ORIGINAL URLs (Build/WebGLValidation.data / .wasm) while we
 * transparently fetch the parts, concatenate them, and return a Response.
 * An XMLHttpRequest shim is included too because Unity's loader.js uses XHR
 * for dataUrl. Part fetches always use the original fetch (no recursion).
 */

(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  // Map normalized request path -> { manifestUrl, mime }.
  // Keys are lowercase, without leading "./" or "/" and without query/hash.
  var CHUNKED_FILES = {
    'build/webglvalidation.data': { manifestUrl: 'Build/data-manifest.json', mime: 'application/octet-stream' },
    'build/webglvalidation.wasm': { manifestUrl: 'Build/wasm-manifest.json', mime: 'application/wasm' },
  };

  var originalFetch = window.fetch ? window.fetch.bind(window) : null;
  if (!originalFetch) {
    console.error('window.fetch is not available; chunked loader cannot be installed.');
    return;
  }

  var manifestCache = {}; // manifestUrl -> Promise<manifest>
  var fileCache = {}; // normalizedPath -> Promise<{ bytes: Uint8Array, mime: string, size: number }>

  function normalizePath(url) {
    var s = String(url);
    // Drop query string and hash.
    s = s.split('#')[0].split('?')[0];
    try {
      // Resolve relative URLs against the document base so
      // "Build/X", "./Build/X" and absolute URLs all match.
      var absolute = new URL(s, document.baseURI || window.location.href);
      s = absolute.pathname;
    } catch (e) {
      // Keep s as-is for non-URL strings.
    }
    s = s.replace(/^\.\/+/, '').replace(/^\/+/, '');
    return s.toLowerCase();
  }

  function getChunkedEntry(input) {
    var urlString;
    if (typeof input === 'string') {
      urlString = input;
    } else if (input instanceof Request) {
      urlString = input.url;
    } else if (input instanceof URL) {
      urlString = input.href;
    } else {
      return null;
    }
    // Never intercept the part files or manifests themselves.
    if (/part-\d+\.bin$/.test(urlString) || /-manifest\.json$/.test(urlString)) return null;
    var key = normalizePath(urlString);
    var entry = CHUNKED_FILES[key];
    return entry ? { key: key, entry: entry } : null;
  }

  function toAbsoluteUrl(url) {
    // Browser fetch() resolves relative URLs automatically, but Node's
    // undici fetch (and some workers) requires absolute URLs. Resolve
    // everything against the document base so both work.
    try {
      return new URL(String(url), document.baseURI || window.location.href).href;
    } catch (e) {
      return String(url);
    }
  }

  function fetchManifest(manifestUrl) {
    if (!manifestCache[manifestUrl]) {
      manifestCache[manifestUrl] = originalFetch(toAbsoluteUrl(manifestUrl)).then(function (res) {
        if (!res.ok) throw new Error(manifestUrl + ': HTTP ' + res.status);
        return res.json();
      }).then(function (manifest) {
        if (!manifest || !Array.isArray(manifest.parts) || !manifest.parts.length) {
          throw new Error('Invalid manifest: ' + manifestUrl);
        }
        return manifest;
      }).catch(function (err) {
        delete manifestCache[manifestUrl];
        throw err;
      });
    }
    return manifestCache[manifestUrl];
  }

  // Backwards-compatible helper: fetch parts and return a blob URL.
  // Prefer the fetch override below; this is kept for manual use/debugging.
  async function loadGameData(manifestUrl, onProgress, mimeType) {
    var manifest = await fetchManifest(manifestUrl);
    var assembled = await assembleManifest(manifest, manifestUrl, onProgress);
    var blob = new Blob([assembled.bytes], { type: mimeType || manifest.mime || 'application/octet-stream' });
    return URL.createObjectURL(blob);
  }

  function assembleManifest(manifest, manifestUrl, onProgress) {
    var total = manifest.size;
    var mime = manifest.mime || 'application/octet-stream';
    var buffers = new Array(manifest.parts.length);
    var next = 0;
    var received = 0;

    function worker() {
      function step() {
        if (next >= manifest.parts.length) return Promise.resolve();
        var index = next++;
        var part = manifest.parts[index];
        return originalFetch(toAbsoluteUrl(part.url)).then(function (res) {
          if (!res.ok) throw new Error(part.url + ': HTTP ' + res.status);
          return res.arrayBuffer();
        }).then(function (buf) {
          if (buf.byteLength !== part.size) {
            throw new Error('Incomplete part: ' + part.url + ' (' + buf.byteLength + '/' + part.size + ')');
          }
          buffers[index] = new Uint8Array(buf);
          received += buf.byteLength;
          if (typeof onProgress === 'function') {
            try { onProgress(received / total, received, total); } catch (e) { /* ignore */ }
          }
          return step();
        });
      }
      return step();
    }

    // 2 parallel workers, same as before.
    return Promise.all([worker(), worker()]).then(function () {
      if (received !== total) throw new Error('Incomplete file from ' + manifestUrl);
      var out = new Uint8Array(total);
      var offset = 0;
      for (var i = 0; i < buffers.length; i++) {
        out.set(buffers[i], offset);
        offset += buffers[i].length;
      }
      return { bytes: out, mime: mime, size: total };
    });
  }

  function loadChunkedFile(key, entry, onProgress) {
    if (!fileCache[key]) {
      fileCache[key] = fetchManifest(entry.manifestUrl).then(function (manifest) {
        var mime = entry.mime || manifest.mime || 'application/octet-stream';
        // Tag manifest with the expected mime so Response has the right type
        // (critical for WebAssembly.instantiateStreaming on .wasm).
        var tagged = { size: manifest.size, parts: manifest.parts, mime: mime };
        return assembleManifest(tagged, entry.manifestUrl, onProgress);
      }).catch(function (err) {
        delete fileCache[key];
        throw err;
      });
    }
    return fileCache[key];
  }

  function makeChunkedResponse(assembled) {
    // Clone the bytes so the cached copy stays intact if Unity detaches the buffer.
    var copy = assembled.bytes.slice().buffer;
    return new Response(copy, {
      status: 200,
      statusText: 'OK',
      headers: {
        'Content-Type': assembled.mime,
        'Content-Length': String(assembled.size),
      },
    });
  }

  // ---- window.fetch override ----
  // Intercepts only the two original Unity URLs; everything else passes through.
  var patchedFetch = function (input, init) {
    var match = getChunkedEntry(input);
    // Only intercept plain GETs (Unity never POSTs these assets).
    var method = (init && init.method) || (input instanceof Request ? input.method : 'GET');
    if (!match || String(method).toUpperCase() !== 'GET') {
      return originalFetch(input, init);
    }
    // If the caller asked for a byte range we can't serve from cache metadata,
    // fall through to the network (which will 404) so the error is visible.
    if (init && init.headers) {
      try {
        var h = new Headers(init.headers);
        if (h.has('Range')) return originalFetch(input, init);
      } catch (e) { /* ignore */ }
    }
    if (input instanceof Request && input.headers && typeof input.headers.has === 'function') {
      try { if (input.headers.has('Range')) return originalFetch(input, init); } catch (e) { /* ignore */ }
    }

    var progressCb = patchedFetch.onProgress;
    return loadChunkedFile(match.key, match.entry, progressCb ? function (fraction, loaded, total) {
      try { progressCb(match.key, fraction, loaded, total); } catch (e) { /* ignore */ }
    } : undefined).then(function (assembled) {
      return makeChunkedResponse(assembled);
    });
  };
  // Optional hook: patchedFetch.onProgress = (key, fraction, loaded, total) => {}
  // Exposed so index.html can drive the loading bar during reassembly.
  patchedFetch.onProgress = null;

  // Preserve fetch properties (e.g. fetch.polyfill).
  for (var k in originalFetch) {
    try { patchedFetch[k] = originalFetch[k]; } catch (e) { /* ignore */ }
  }

  window.fetch = patchedFetch;
  window.__unityOriginalFetch = originalFetch;

  // ---- XMLHttpRequest shim (loader.js uses XHR for dataUrl) ----
  // Same interception as fetch, but implemented by patching each real XHR
  // instance's open()/send() so `instanceof XMLHttpRequest`, event listeners,
  // responseType, etc. keep working exactly as usual for non-chunked URLs.
  if (typeof window.XMLHttpRequest !== 'undefined' && !window.__unityChunkedXHRPatched) {
    var OriginalXHR = window.XMLHttpRequest;
    window.__unityOriginalXHR = OriginalXHR;

    function fire(xhr, type, props) {
      var ev;
      try {
        ev = new ProgressEvent(type, props || {});
      } catch (e) {
        try {
          ev = document.createEvent('ProgressEvent');
          ev.initEvent(type, false, false);
        } catch (e2) {
          ev = document.createEvent('Event');
          ev.initEvent(type, false, false);
        }
        for (var p in (props || {})) { try { ev[p] = props[p]; } catch (e3) { /* ignore */ } }
      }
      try {
        var handler = xhr['on' + type];
        if (typeof handler === 'function') handler.call(xhr, ev);
      } catch (e) { /* let load/error handlers throw async to avoid breaking dispatch */ setTimeout(function () { throw e; }); }
      try { xhr.dispatchEvent(ev); } catch (e) { /* ignore */ }
      if (type === 'readystatechange' && typeof xhr.onreadystatechange === 'function') {
        // onreadystatechange is also covered by 'on'+type above, kept for clarity.
      }
    }

    function shadow(xhr, props) {
      for (var name in props) {
        try {
          Object.defineProperty(xhr, name, { value: props[name], writable: true, configurable: true });
        } catch (e) { try { xhr[name] = props[name]; } catch (e2) { /* ignore */ } }
      }
    }

    function PatchedXHR() {
      var xhr = new OriginalXHR();
      var origOpen = xhr.open.bind(xhr);
      var origSend = xhr.send.bind(xhr);
      var match = null;

      xhr.open = function (method, url) {
        match = String(method || 'GET').toUpperCase() === 'GET' ? getChunkedEntry(String(url)) : null;
        return origOpen.apply(xhr, arguments);
      };

      xhr.send = function () {
        if (!match) return origSend.apply(xhr, arguments);
        var entry = match.entry;
        var key = match.key;
        var args = arguments;
        // Do NOT hit the network (the original .data/.wasm files don't exist).
        // Serve the reassembled parts and emulate a normal XHR lifecycle.
        try { fire(xhr, 'loadstart', { lengthComputable: true, loaded: 0, total: 0 }); } catch (e) { /* ignore */ }
        loadChunkedFile(key, entry, patchedFetch.onProgress ? function (fraction, loaded, total) {
          try { patchedFetch.onProgress(key, fraction, loaded, total); } catch (e) { /* ignore */ }
          try { fire(xhr, 'progress', { lengthComputable: true, loaded: loaded, total: total }); } catch (e) { /* ignore */ }
        } : function (fraction, loaded, total) {
          try { fire(xhr, 'progress', { lengthComputable: true, loaded: loaded, total: total }); } catch (e) { /* ignore */ }
        }).then(function (assembled) {
          var rt = String(xhr.responseType || '').toLowerCase();
          var buffer = assembled.bytes.slice().buffer;
          var text = null;
          if (rt === '' || rt === 'text' || rt === 'json') {
            try { text = new TextDecoder().decode(assembled.bytes); } catch (e) { text = ''; }
          }
          var response = buffer;
          var responseText = '';
          if (rt === '' || rt === 'text') { response = text; responseText = text; }
          else if (rt === 'json') { try { response = JSON.parse(text); } catch (e) { response = null; } }
          else if (rt === 'blob') { response = new Blob([assembled.bytes], { type: assembled.mime }); }
          else if (rt === 'arraybuffer') { response = buffer; }
          shadow(xhr, {
            status: 200, statusText: 'OK', readyState: 4,
            response: response, responseText: responseText, responseURL: xhr.responseURL || '',
          });
          try { fire(xhr, 'readystatechange', {}); } catch (e) { /* ignore */ }
          try { fire(xhr, 'progress', { lengthComputable: true, loaded: assembled.size, total: assembled.size }); } catch (e) { /* ignore */ }
          try { fire(xhr, 'load', {}); } catch (e) { /* ignore */ }
          try { fire(xhr, 'loadend', {}); } catch (e) { /* ignore */ }
        }).catch(function (err) {
          try { console.error('[chunked-loader] XHR shim failed for', key, err); } catch (e) { /* ignore */ }
          shadow(xhr, { status: 0, statusText: String((err && err.message) || err), readyState: 4, response: null, responseText: '' });
          try { fire(xhr, 'readystatechange', {}); } catch (e) { /* ignore */ }
          try { fire(xhr, 'error', {}); } catch (e) { /* ignore */ }
          try { fire(xhr, 'loadend', {}); } catch (e) { /* ignore */ }
        });
        // Async path: do not return the network result.
        return undefined;
      };

      return xhr;
    }
    PatchedXHR.prototype = OriginalXHR.prototype;
    window.XMLHttpRequest = PatchedXHR;
    window.__unityChunkedXHRPatched = true;
  }

  // Public API for index.html / debugging.
  window.UnityChunkedLoader = {
    files: CHUNKED_FILES,
    fetchManifest: fetchManifest,
    loadGameData: loadGameData, // legacy blob-URL helper
    clearCache: function () {
      for (var m in manifestCache) delete manifestCache[m];
      for (var f in fileCache) delete fileCache[f];
    },
  };
})();
