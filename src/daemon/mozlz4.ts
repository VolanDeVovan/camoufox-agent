// mozlz4 ("mozLz40\0" + little-endian size + one LZ4 block): the format of Firefox's
// sessionstore files, which is where cookies without an expiry live on disk.

const MAGIC = Buffer.from("mozLz40\0", "latin1");

export function decodeMozLz4(file: Buffer): Buffer {
  if (file.length < 12 || !file.subarray(0, 8).equals(MAGIC)) throw new Error("not a mozlz4 file");
  const size = file.readUInt32LE(8);
  const out = Buffer.allocUnsafe(size);
  let ip = 12;
  let op = 0;
  while (ip < file.length) {
    const token = file[ip++];
    let literals = token >> 4;
    if (literals === 15) {
      let b: number;
      do {
        b = file[ip++];
        literals += b;
      } while (b === 255);
    }
    if (op + literals > size || ip + literals > file.length) throw new Error("corrupt mozlz4 data");
    file.copy(out, op, ip, ip + literals);
    ip += literals;
    op += literals;
    if (ip >= file.length) break; // the last sequence has no match
    const offset = file[ip] | (file[ip + 1] << 8);
    ip += 2;
    if (offset === 0 || offset > op) throw new Error("corrupt mozlz4 data");
    let length = (token & 15) + 4;
    if ((token & 15) === 15) {
      let b: number;
      do {
        b = file[ip++];
        length += b;
      } while (b === 255);
    }
    if (op + length > size) throw new Error("corrupt mozlz4 data");
    // Byte by byte: a match may overlap what it is writing.
    for (let from = op - offset, end = op + length; op < end; ) out[op++] = out[from++];
  }
  return out.subarray(0, op);
}
