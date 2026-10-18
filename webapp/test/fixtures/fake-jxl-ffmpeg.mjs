#!/usr/bin/env node
// Deterministic fixture for the optional JXL/Chrome streaming smoke test.
// Not used by production. This outputs real JPEG XL image bytes (64x64 red).
import fs from "node:fs";
const jxl = Buffer.from("/wpPBgATCAEAKAFnEygBAFChMsq4wcu5ni8/dFhM27jO0FbbFpYkioxjk3QCh5ACOzJmzBhjxswYg+eMMcZkSCk/AMDBOHQRBGzjP6/zLAR4hJUkAA==","base64");
if (process.argv.includes("-encoders")) {
  console.log(" V..... libjxl               libjxl JPEG XL (codec jpegxl)");
  process.exit(0);
}
if (!process.argv.includes("tee")) process.exit(14);
fs.writeSync(3, "#software: Lavf\n#tb 0: 1/4\n#media_type 0: video\n#codec_id 0: jpegxl\n");
for (let i = 0; i < 8; i++) {
  fs.writeSync(1,jxl);
  fs.writeSync(3,`0, ${i}, ${i}, 1, ${jxl.length}, 0x1234\n`);
}
