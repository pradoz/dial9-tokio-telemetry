import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { lstatSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FieldType, TraceDecoder } from "../../../decode.js";

const require = createRequire(import.meta.url);
const canonicalDecoderPath = fileURLToPath(
  new URL("../../../decode.js", import.meta.url),
);
const toolkitDecoderPath = fileURLToPath(
  new URL(
    "../../../../skills/dial9-toolkit/scripts/decode.js",
    import.meta.url,
  ),
);
const { parseTrace } = require("../../../trace_parser.js") as {
  parseTrace: (bytes: Uint8Array, options?: unknown) => Promise<{
    customEvents: Array<{
      units: Record<string, string> | null;
      fieldKinds: Record<string, string> | null;
      singleEventSpan: {
        start: number;
        end: number;
        fields: Record<string, unknown>;
      } | null;
    }>;
  }>;
};

const TYPE_ID = 1;
const utf8 = (value: string): number[] => [
  ...new TextEncoder().encode(value),
];
const u16 = (value: number): number[] => [value & 0xff, value >>> 8];
const u32 = (value: number): number[] => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
  value >>> 24,
];

function annotationFrame(key: string, value: string, fieldIndex = 0): number[] {
  const keyBytes = utf8(key);
  const valueBytes = utf8(value);
  return [
    0x06,
    TYPE_ID, // one-byte ULEB128
    ...u16(1),
    ...u16(fieldIndex),
    ...u16(keyBytes.length),
    ...keyBytes,
    ...u32(valueBytes.length),
    ...valueBytes,
  ];
}

function schemaFrame(): number[] {
  const name = utf8("Metric");
  const field = utf8("value");
  return [
    0x01,
    ...u16(TYPE_ID),
    ...u16(name.length),
    ...name,
    1,
    ...u16(1),
    ...u16(field.length),
    ...field,
    FieldType.Varint,
  ];
}

function durationSpanSchemaFrame(): number[] {
  const name = utf8("Metric");
  const field = utf8("duration");
  return [
    0x01,
    ...u16(TYPE_ID),
    ...u16(name.length),
    ...name,
    1,
    ...u16(1),
    ...u16(field.length),
    ...field,
    FieldType.Varint,
  ];
}

function timestampLessSpanSchemaFrame(): number[] {
  const name = utf8("Detached");
  const start = utf8("start");
  const duration = utf8("duration");
  return [
    0x01,
    ...u16(TYPE_ID),
    ...u16(name.length),
    ...name,
    0,
    ...u16(2),
    ...u16(start.length),
    ...start,
    FieldType.Varint,
    ...u16(duration.length),
    ...duration,
    FieldType.Varint,
  ];
}

describe("TraceDecoder schema annotations", () => {
  it("shares the canonical decoder with the agent toolkit", () => {
    expect(lstatSync(toolkitDecoderPath).isSymbolicLink()).toBe(true);
    expect(realpathSync(toolkitDecoderPath)).toBe(
      realpathSync(canonicalDecoderPath),
    );
  });

  it("can omit duplicate pool-frame entries while retaining decoder pools", () => {
    const data = utf8("alpha");
    const bytes = Uint8Array.from([
      0x54, 0x52, 0x43, 0x00, 1,
      0x03, ...u32(1), ...u32(7), ...u32(data.length), ...data,
    ]);
    const normal = new TraceDecoder(bytes);
    expect(normal.decodeHeader()).toBe(true);
    expect(normal.nextFrame()).toMatchObject({
      type: "string_pool",
      entries: [{ poolId: 7, data: "alpha" }],
    });

    const compact = new TraceDecoder(bytes, { omitPoolFrameEntries: true });
    expect(compact.decodeHeader()).toBe(true);
    expect(compact.nextFrame()).toEqual({ type: "string_pool", entries: [] });
    expect(compact.stringPool.get(7)).toBe("alpha");
  });

  it("reuses event and values objects only when explicitly requested", () => {
    const bytes = Uint8Array.from([
      0x54, 0x52, 0x43, 0x00, 1,
      ...schemaFrame(),
      0x02, ...u16(TYPE_ID), 1, 0, 0, 7,
      0x02, ...u16(TYPE_ID), 1, 0, 0, 9,
    ]);
    const decodeTwo = (reuseEventObjects = false) => {
      const decoder = new TraceDecoder(bytes, { numericTimestamps: true, reuseEventObjects });
      expect(decoder.decodeHeader()).toBe(true);
      return decoder.decodeAll().filter((frame) => frame.type === "event");
    };
    const stable = decodeTwo();
    expect(stable[0]).not.toBe(stable[1]);
    expect(stable.map((frame) => frame.values.value)).toEqual(["7", "9"]);

    const decoder = new TraceDecoder(bytes, {
      numericTimestamps: true,
      reuseEventObjects: true,
    });
    expect(decoder.decodeHeader()).toBe(true);
    const first = decoder.nextFrame(); // schema
    expect(first?.type).toBe("schema");
    const a = decoder.nextFrame();
    const b = decoder.nextFrame();
    expect(a).toBe(b);
    expect(a?.type === "event" ? a.values.value : null).toBe("9");
    expect(a?.type === "event" ? a.timestamp_ns : null).toBe(2);
  });

  it("keeps timestamp strings by default and emits safe numbers only when requested", () => {
    const event = [
      0x54, 0x52, 0x43, 0x00, 1,
      ...schemaFrame(),
      0x02, ...u16(TYPE_ID), 1, 0, 0, 7,
    ];
    const decodeTimestamp = (options?: { numericTimestamps?: boolean }) => {
      const decoder = new TraceDecoder(Uint8Array.from(event), options);
      expect(decoder.decodeHeader()).toBe(true);
      return decoder.decodeAll().find((frame) => frame.type === "event")?.timestamp_ns;
    };
    expect(decodeTimestamp()).toBe("1");
    expect(decodeTimestamp({ numericTimestamps: true })).toBe(1);

    const overflow = 2n ** 53n;
    const lo = Number(overflow & 0xffff_ffffn);
    const hi = Number(overflow >> 32n);
    const bytes = Uint8Array.from([
      0x54, 0x52, 0x43, 0x00, 1,
      ...schemaFrame(),
      0x05, ...u32(lo), ...u32(hi),
      0x02, ...u16(TYPE_ID), 1, 0, 0, 7,
    ]);
    const decoder = new TraceDecoder(bytes, { numericTimestamps: true });
    expect(decoder.decodeHeader()).toBe(true);
    expect(decoder.decodeAll().find((frame) => frame.type === "event")?.timestamp_ns)
      .toBe((overflow + 1n).toString());
  });

  it("accumulates unit and kind from separate annotation frames", () => {
    const bytes = Uint8Array.from([
      0x54, 0x52, 0x43, 0x00, 1,
      ...schemaFrame(),
      ...annotationFrame("unit", "bytes"),
      ...annotationFrame("kind", "counter"),
    ]);
    const decoder = new TraceDecoder(bytes);

    expect(decoder.decodeHeader()).toBe(true);
    decoder.decodeAll();

    expect(decoder.schemas.get(TYPE_ID)).toMatchObject({
      annotations: [
        { fieldIndex: 0, key: "unit", value: "bytes" },
        { fieldIndex: 0, key: "kind", value: "counter" },
      ],
      units: { value: "bytes" },
      fieldKinds: { value: "counter" },
    });
  });

  it("keeps absent metadata nullable and attaches late annotations", async () => {
    const eventFrames = [
      0x54, 0x52, 0x43, 0x00, 1,
      ...schemaFrame(),
      0x02,
      ...u16(TYPE_ID),
      1, 0, 0,
      7,
    ];
    const unannotated = await parseTrace(Uint8Array.from(eventFrames));
    expect(unannotated.customEvents[0]).toMatchObject({
      units: null,
      fieldKinds: null,
    });

    const trace = await parseTrace(Uint8Array.from([
      ...eventFrames,
      ...annotationFrame("unit", "bytes"),
      ...annotationFrame("kind", "counter"),
    ]));

    expect(trace.customEvents).toHaveLength(1);
    expect(trace.customEvents[0]).toMatchObject({
      units: { value: "bytes" },
      fieldKinds: { value: "counter" },
    });
  });

  it("does NOT reclassify an event when its span-role annotation trails the event", async () => {
    // The wire format requires span-role (`dial9.role`) annotations to precede
    // any event of their type (docs/design/single-event-spans.md). A role frame
    // that arrives AFTER the event is a malformed trace: the decoder classifies
    // spans in a single pass at decode time and does not re-resolve later, so
    // the event stays an ordinary custom event. (Metadata annotations like
    // unit/kind may still trail — that is exercised separately above.)
    const bytes = Uint8Array.from([
      0x54, 0x52, 0x43, 0x00, 1,
      ...durationSpanSchemaFrame(),
      ...annotationFrame("unit", "ns"),
      0x02,
      ...u16(TYPE_ID),
      10, 0, 0,
      4,
      ...annotationFrame("dial9.role", "span.duration"),
    ]);

    const trace = await parseTrace(bytes);
    expect(trace.customEvents).toHaveLength(1);
    expect(trace.customEvents[0]!.singleEventSpan).toBeNull();
    // The trailing metadata annotation still attaches (metadata may follow).
    expect(trace.customEvents[0]).toMatchObject({ units: { duration: "ns" } });

    // Columnar path: with no span recognized at decode time, nothing routes to
    // the sink and the event stays fat.
    const projected: unknown[] = [];
    const spanEventSink = {
      pushIfSpan(
        _name: string,
        _timestamp: number,
        _fields: Record<string, unknown>,
        span: unknown,
      ): boolean {
        if (span == null) return false;
        projected.push(span);
        return true;
      },
    };
    const columnarTrace = await parseTrace(bytes, { spanEventSink });
    expect(columnarTrace.customEvents).toHaveLength(1);
    expect(projected).toEqual([]);
  });

  it("routes a timestamp-less span using its projected end", async () => {
    // Annotations precede the event, as the format requires.
    const bytes = Uint8Array.from([
      0x54, 0x52, 0x43, 0x00, 1,
      ...timestampLessSpanSchemaFrame(),
      ...annotationFrame("dial9.role", "span.start"),
      ...annotationFrame("dial9.role", "span.duration", 1),
      0x02,
      ...u16(TYPE_ID),
      30,
      5,
    ]);
    const projectedTimestamps: number[] = [];
    const spanEventSink = {
      pushIfSpan(
        _name: string,
        timestamp: number,
        _fields: Record<string, unknown>,
        span: unknown,
      ): boolean {
        if (span == null) return false;
        projectedTimestamps.push(timestamp);
        return true;
      },
    };

    const trace = await parseTrace(bytes, { spanEventSink });

    expect(trace.customEvents).toHaveLength(0);
    expect(projectedTimestamps).toEqual([35]);
  });
});
