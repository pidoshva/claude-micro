#!/usr/bin/env node
/**
 * Regenerates ./lib from the locally installed ChatGPT.app.
 *
 * The Work Louder device SDK (@worklouder/device-kit-oai) ships inside
 * ChatGPT.app's app.asar. We never vendor a copy of it -- we extract it from
 * the app that is already on this machine, so an app update just means
 * re-running this script.
 *
 * Files marked `unpacked` in the asar header live on disk under
 * app.asar.unpacked (that's where the node-hid .node prebuild is), so those
 * get copied rather than sliced out of the archive.
 */
const fs = require('fs');
const path = require('path');

const APP = process.env.CHATGPT_APP || '/Applications/ChatGPT.app';
const ASAR = path.join(APP, 'Contents/Resources/app.asar');
const UNPACKED = ASAR + '.unpacked';
const OUT = path.join(__dirname, 'lib');
const WANT = /^\/node_modules\/@worklouder\//;

function readHeader(fd) {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const size = head.readUInt32LE(12);
  const json = Buffer.alloc(size);
  fs.readSync(fd, json, 0, size, 16);
  // The header is padded to a 4-byte boundary; file offsets are relative to
  // the end of that padding, not the end of the JSON.
  const base = 16 + size + ((4 - (size % 4)) % 4);
  return { header: JSON.parse(json.toString('utf8')), base };
}

function main() {
  if (!fs.existsSync(ASAR)) {
    console.error(`no asar at ${ASAR} -- is ChatGPT.app installed?`);
    process.exit(1);
  }
  const fd = fs.openSync(ASAR, 'r');
  const { header, base } = readHeader(fd);
  fs.rmSync(OUT, { recursive: true, force: true });

  let packed = 0, unpacked = 0, missing = [];
  (function walk(node, prefix) {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const rel = prefix + '/' + name;
      if (entry.files) { walk(entry, rel); continue; }
      if (!WANT.test(rel)) continue;
      const dest = path.join(OUT, rel.replace(/^\//, ''));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (entry.unpacked) {
        const src = path.join(UNPACKED, rel);
        if (fs.existsSync(src)) { fs.copyFileSync(src, dest); unpacked++; }
        else missing.push(rel);
      } else {
        const buf = Buffer.alloc(entry.size);
        if (entry.size) fs.readSync(fd, buf, 0, entry.size, base + Number(entry.offset));
        fs.writeFileSync(dest, buf);
        packed++;
      }
    }
  })(header, '');

  fs.closeSync(fd);
  console.log(`extracted ${packed} packed + ${unpacked} unpacked files into ${OUT}`);
  if (missing.length) console.warn(`missing ${missing.length} unpacked file(s):\n  ` + missing.join('\n  '));

  // Fail loudly now rather than at daemon start.
  const kit = require(path.join(OUT, 'node_modules/@worklouder/device-kit-oai'));
  if (typeof kit.RPCApiOAI !== 'function') throw new Error('SDK loaded but RPCApiOAI missing');
  console.log('SDK loads cleanly');
}

main();
