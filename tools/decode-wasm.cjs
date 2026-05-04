const fs = require('fs');
const buf = fs.readFileSync('14_compressed_asset.decoded');
const text = buf.toString('latin1');
const re = /"data:application\/octet-stream;base64,([A-Za-z0-9+\/=]{100,})"/g;
let m, idx = 0;
while ((m = re.exec(text))) {
  const b64 = m[1];
  const wasm = Buffer.from(b64, 'base64');
  const isWasm = wasm[0] === 0x00 && wasm[1] === 0x61 && wasm[2] === 0x73 && wasm[3] === 0x6d;
  console.log('module', idx, 'b64_len=', b64.length, 'bin_len=', wasm.length, 'wasm_magic=', isWasm, 'head=', wasm.slice(0,16).toString('hex'));
  fs.writeFileSync(`luna-wasm-${idx}.wasm`, wasm);
  idx++;
}
console.log('extracted', idx, 'modules');
