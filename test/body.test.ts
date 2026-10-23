import { describe, expect, it } from "vitest";
import { readBounded } from "../src/login/body.js";

/** A stream that hands out the given chunks one by one, and counts how many were pulled. */
function chunked(chunks: Uint8Array[]) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[state.pulled++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

const bytes = (n: number, fill = 97) => new Uint8Array(n).fill(fill);

describe("readBounded", () => {
  it("returns all the bytes of a body within the limit", async () => {
    const { stream } = chunked([bytes(4, 1), bytes(3, 2)]);
    expect(await readBounded(stream, 10)).toEqual(new Uint8Array([1, 1, 1, 1, 2, 2, 2]));
  });

  it("accepts a body of exactly the limit and an empty body", async () => {
    expect((await readBounded(chunked([bytes(5), bytes(5)]).stream, 10))?.byteLength).toBe(10);
    expect(await readBounded(null, 10)).toEqual(new Uint8Array(0));
    expect(await readBounded(chunked([]).stream, 10)).toEqual(new Uint8Array(0));
  });

  it("gives up as soon as more than the limit arrives, without reading the rest", async () => {
    const { stream, state } = chunked(Array.from({ length: 100 }, () => bytes(1000)));
    expect(await readBounded(stream, 2500)).toBeNull();
    expect(state.pulled).toBeLessThan(10);
    expect(state.cancelled).toBe(true);
  });
});
