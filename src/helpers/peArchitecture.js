const fs = require("fs");

const MACHINES = { arm64: 0xaa64, x64: 0x8664, ia32: 0x014c };

function readPeMachine(file) {
  const fd = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(64);
    if (fs.readSync(fd, header, 0, 64, 0) !== 64 || header.readUInt16LE(0) !== 0x5a4d) {
      throw new Error(`Not a Windows PE image: ${file}`);
    }
    const pe = Buffer.alloc(6);
    const offset = header.readUInt32LE(0x3c);
    if (fs.readSync(fd, pe, 0, 6, offset) !== 6 || pe.readUInt32LE(0) !== 0x4550) {
      throw new Error(`Invalid PE header: ${file}`);
    }
    return pe.readUInt16LE(4);
  } finally {
    fs.closeSync(fd);
  }
}

function assertPeArchitecture(file, arch = "arm64") {
  const machine = readPeMachine(file);
  if (!MACHINES[arch] || machine !== MACHINES[arch]) {
    throw new Error(
      `Wrong architecture in ${file}: PE machine 0x${machine.toString(16)}, expected ${arch}`
    );
  }
  return file;
}

module.exports = { MACHINES, readPeMachine, assertPeArchitecture };
