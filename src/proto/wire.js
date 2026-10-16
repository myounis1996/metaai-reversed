// Minimal protobuf wire codec — just enough for meta.ai's two ecto messages.
// No .proto compiler, no runtime dependency: the schema lives in
// src/proto/ecto.js as field numbers.
//
// Encoding: a message is an array of [fieldNumber, value] pairs, in order.
//   number | bigint | boolean  → varint
//   {float: n}                 → fixed32 IEEE-754
//   string | Buffer            → length-delimited bytes
//   Array (nested pairs)       → length-delimited sub-message
//   undefined | null           → field omitted
// Repeated fields are just the same field number listed more than once.
//
// Decoding is schema-less on purpose: `decode` returns the raw [field, value]
// pairs (varint → BigInt, length-delimited → Buffer, fixed32 → number) and the
// caller decides which Buffers are sub-messages. Guessing that from the bytes
// is how generic protobuf dumpers mangle strings.

function writeVarint(value) {
  let n = BigInt(value);
  if (n < 0n) n = BigInt.asUintN(64, n);
  const out = [];
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return Buffer.from(out);
}

function encode(fields) {
  const parts = [];
  for (const [field, value] of fields) {
    if (value === undefined || value === null) continue;
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
      parts.push(writeVarint(field * 8), writeVarint(typeof value === "boolean" ? Number(value) : value));
      continue;
    }
    if (typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value) && "float" in value) {
      const bytes = Buffer.alloc(4);
      bytes.writeFloatLE(value.float);
      parts.push(writeVarint(field * 8 + 5), bytes);
      continue;
    }
    const bytes = Array.isArray(value)
      ? encode(value)
      : Buffer.isBuffer(value)
        ? value
        : Buffer.from(String(value), "utf8");
    parts.push(writeVarint(field * 8 + 2), writeVarint(bytes.length), bytes);
  }
  return Buffer.concat(parts);
}

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (pos >= buf.length) throw new Error("protobuf: truncated varint");
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [result, pos];
    shift += 7n;
    if (shift > 63n) throw new Error("protobuf: varint too long");
  }
}

function decode(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    let value;
    if (wire === 0) {
      [value, pos] = readVarint(buf, pos);
    } else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      const end = pos + Number(len);
      if (end > buf.length) throw new Error("protobuf: length-delimited field overruns buffer");
      value = buf.subarray(pos, end);
      pos = end;
    } else if (wire === 5) {
      if (pos + 4 > buf.length) throw new Error("protobuf: truncated fixed32");
      value = buf.readUInt32LE(pos);
      pos += 4;
    } else if (wire === 1) {
      if (pos + 8 > buf.length) throw new Error("protobuf: truncated fixed64");
      value = buf.readBigUInt64LE(pos);
      pos += 8;
    } else {
      throw new Error(`protobuf: unsupported wire type ${wire} at byte ${pos}`);
    }
    fields.push([field, value]);
  }
  return fields;
}

// Last occurrence wins, as protobuf specifies for non-repeated fields.
function get(fields, number) {
  let found;
  for (const [field, value] of fields) if (field === number) found = value;
  return found;
}

const getMessage = (fields, number) => {
  const raw = get(fields, number);
  return Buffer.isBuffer(raw) ? decode(raw) : null;
};
const getString = (fields, number) => {
  const raw = get(fields, number);
  return Buffer.isBuffer(raw) ? raw.toString("utf8") : null;
};
const getBool = (fields, number) => get(fields, number) === 1n;

module.exports = {encode, decode, get, getMessage, getString, getBool};
