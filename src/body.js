// Reads at most `cap` bytes of a ReadableStream (null = empty), then cancels
// it. Used for the tracker PUT body and the raw e-mail, so neither is ever
// buffered beyond its cap. `truncated` is true when more than `cap` bytes
// were offered.
export async function readCapped(stream, cap) {
  if (stream === null || stream === undefined) return { bytes: new Uint8Array(0), text: "", truncated: false };
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    if (total + bytes.byteLength > cap) {
      chunks.push(bytes.subarray(0, cap - total));
      total = cap;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(bytes);
    total += bytes.byteLength;
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return { bytes: buf, text: new TextDecoder().decode(buf), truncated };
}
