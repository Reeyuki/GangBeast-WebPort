/* GitHub Pages stores the Unity data package in files below GitHub's size limit. */
async function loadGameData(manifestUrl, onProgress) {
  const response = await fetch(manifestUrl);
  if (!response.ok) throw new Error('Manifest HTTP ' + response.status);
  const manifest = await response.json();
  if (!Array.isArray(manifest.parts) || !manifest.parts.length) {
    throw new Error('Invalid game data manifest');
  }
  const buffers = new Array(manifest.parts.length);
  let next = 0;
  let received = 0;
  const controller = new AbortController();
  async function worker() {
    while (next < manifest.parts.length) {
      const index = next++;
      const part = manifest.parts[index];
      const result = await fetch(part.url, { signal: controller.signal });
      if (!result.ok) throw new Error(part.url + ': HTTP ' + result.status);
      const bytes = await result.arrayBuffer();
      if (bytes.byteLength !== part.size) throw new Error('Incomplete file: ' + part.url);
      buffers[index] = bytes;
      received += bytes.byteLength;
      onProgress(received / manifest.size);
    }
  }
  try {
    await Promise.all([worker(), worker()]);
    if (received !== manifest.size) throw new Error('Incomplete game data');
    return URL.createObjectURL(new Blob(buffers, { type: 'application/octet-stream' }));
  } catch (error) {
    controller.abort();
    throw error;
  }
}
