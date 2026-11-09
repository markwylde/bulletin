/**
 * Client side of the broker framing. Kept with the plugin bundle because the jail only sees
 * `/plugin`; the server implementation lives in `src/broker/protocol.ts`. A test asserts both
 * produce identical bytes.
 */

export const MAX_FRAME_BYTES = 1024 * 1024;

export class FramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FramingError";
  }
}

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function encodeFrame(value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value, replacer) ?? "null");

  if (payload.byteLength > MAX_FRAME_BYTES) {
    throw new FramingError(`Broker frame exceeds ${MAX_FRAME_BYTES} bytes`);
  }

  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, 4);
  return frame;
}

/** Incremental server-to-plugin decoder. Server frames are always valid JSON. */
export class FrameDecoder {
  #buffer = new Uint8Array(0);
  #expected: number | null = null;

  push(chunk: Uint8Array): unknown[] {
    const next = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    next.set(this.#buffer);
    next.set(chunk, this.#buffer.byteLength);
    this.#buffer = next;
    const values: unknown[] = [];

    while (true) {
      if (this.#expected === null) {
        if (this.#buffer.byteLength < 4) {
          break;
        }

        const length = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, 4).getUint32(
          0,
          false,
        );

        if (length === 0 || length > MAX_FRAME_BYTES) {
          throw new FramingError(`Invalid broker frame length: ${length}`);
        }

        this.#expected = length;
        this.#buffer = this.#buffer.subarray(4);
      }

      if (this.#buffer.byteLength < this.#expected) {
        break;
      }

      const payload = this.#buffer.subarray(0, this.#expected);
      this.#buffer = this.#buffer.subarray(this.#expected);
      this.#expected = null;

      try {
        values.push(JSON.parse(new TextDecoder().decode(payload)));
      } catch {
        throw new FramingError("Broker frame is not valid JSON");
      }
    }

    return values;
  }
}
