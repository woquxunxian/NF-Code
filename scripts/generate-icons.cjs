/**
 * Generates every platform icon from the vector source in art/.
 *
 * Run with:
 *   node scripts/generate-icons.mjs
 *
 * There is no ImageMagick/Inkscape dependency: the SVG is rasterized by Electron (which
 * is already installed for development) and the ICO/ICNS/BMP containers are written by
 * hand, since neither Node nor Electron can produce those formats.
 *
 * Electron is started through the regular entry point with an environment variable set,
 * because it refuses to run a bare script as the main process.
 *
 * Outputs (all committed to git, since packaging reads them from the filesystem):
 *   art/icon.png                    512x512, window and Linux runtime icon
 *   art/rich-presence-icon.png      1024x1024, uploaded to the Discord application by hand
 *   build/512x512.png               Linux deb/AppImage/snap icon set
 *   build/icon.ico                  Windows
 *   build/icon.icns                 macOS
 *   build/appx/*.png                Microsoft Store tiles
 *   build/installerSidebar.bmp      NSIS installer sidebar
 *   docs/favicon.ico                website
 */

const fsPromises = require('fs/promises');
const pathUtil = require('path');
const {spawn} = require('child_process');

const root = pathUtil.join(__dirname, '..');
const SOURCE = pathUtil.join(root, 'art', 'icon.svg');

// Electron does not write to the console on Windows, so progress and errors are mirrored
// into a file that the caller can read when something goes wrong.
const TRACE = pathUtil.join(root, 'icon-generation.log');
const fs = require('fs');
const trace = (message) => {
  try {
    fs.appendFileSync(TRACE, `${message}\n`);
  } catch (e) {
    // ignore
  }
  console.error(message);
};

/**
 * @param {string} relativePath
 * @returns {string}
 */
const resolveFromRoot = (relativePath) => pathUtil.join(root, relativePath);

/**
 * Electron's nativeImage cannot decode SVG, so the source vector is rasterized in a
 * hidden window and read back as a PNG.
 *
 * The capture is retried because a window that was just created sometimes returns an
 * empty image, which would otherwise silently produce useless icons.
 * @param {string} svg
 * @param {number} size
 * @returns {Promise<Buffer>}
 */
const rasterizeSvg = async (svg, size) => {
  const {BrowserWindow, nativeImage} = require('electron');
  const html = `<!DOCTYPE html>
    <html>
      <head><meta charset="utf-8"><style>
        html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
        svg { display: block; width: ${size}px; height: ${size}px; }
      </style></head>
      <body>${svg}</body>
    </html>`;

  const window = new BrowserWindow({
    show: false,
    width: size,
    height: size,
    useContentSize: true,
    transparent: true,
    frame: false,
    skipTaskbar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false
    }
  });

  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    for (let attempt = 0; attempt < 10; attempt++) {
      // Give the compositor a frame or two to paint the vector
      await new Promise((resolve) => setTimeout(resolve, 300));
      const png = (await window.webContents.capturePage()).toPNG();
      const captured = readPngSize(png);
      // Larger than requested is fine, it gets scaled down later
      if (captured.width >= size && captured.height >= size) {
        return png;
      }
      trace(`Icon capture came back as ${png.length} bytes / ${captured.width}x${captured.height}, retrying`);
    }

    throw new Error(`Could not rasterize the icon at ${size}x${size}`);
  } finally {
    window.destroy();
  }
};

/**
 * Reads the pixel dimensions out of a PNG header. nativeImage reports sizes in device
 * independent pixels, which on a display with a scale factor is not the size of the image
 * that was actually captured.
 * @param {Buffer} png
 * @returns {{width: number; height: number}}
 */
const readPngSize = (png) => {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) {
    return {
      width: 0,
      height: 0
    };
  }
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20)
  };
};

/**
 * All the sizes the various targets need, scaled down from one rasterization. The source
 * is usually larger than 1024 because of the display scale factor.
 * @param {Buffer} png
 * @returns {Map<number, Buffer>}
 */
const scalePng = (png) => {
  const {nativeImage} = require('electron');
  const source = readPngSize(png);
  if (source.width === 0) {
    throw new Error('The rasterized icon is not a PNG');
  }

  const image = nativeImage.createFromBuffer(png);
  const sizes = [16, 24, 32, 44, 48, 64, 71, 128, 150, 200, 256, 310, 512, 1024];
  const result = new Map();
  for (const size of sizes) {
    const scaled = size >= source.width ? image : image.resize({
      width: size,
      height: size,
      quality: 'best'
    });
    const data = scaled.toPNG();
    const actual = readPngSize(data);
    if (actual.width !== size) {
      throw new Error(`Expected a ${size}x${size} icon but got ${actual.width}x${actual.height}`);
    }
    result.set(size, data);
  }
  return result;
};

/**
 * ICO container. Entries may hold PNG data directly, which every currently supported
 * Windows version reads.
 * @param {Array<{size: number; data: Buffer}>} entries
 * @returns {Buffer}
 */
const encodeIco = (entries) => {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(entries.length * 16);
  let offset = header.length + directory.length;

  entries.forEach((entry, index) => {
    const at = index * 16;
    // 256 is encoded as 0 in the ICO directory
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at);
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 1);
    directory.writeUInt8(0, at + 2); // palette size
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // color planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(entry.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([
    header,
    directory,
    ...entries.map((entry) => entry.data)
  ]);
};

// OSType codes for the chunks macOS expects in an .icns file, paired with the pixel size
// the image has to be authored at (2x codes carry the retina variant).
const ICNS_TYPES = [
  {type: 'icp4', size: 16},
  {type: 'icp5', size: 32},
  {type: 'ic07', size: 128},
  {type: 'ic08', size: 256},
  {type: 'ic09', size: 512},
  {type: 'ic10', size: 1024},
  {type: 'ic11', size: 32},
  {type: 'ic12', size: 64},
  {type: 'ic13', size: 256},
  {type: 'ic14', size: 512}
];

/**
 * ICNS container. Chunks hold PNG data directly, which has been supported since 10.7.
 * @param {Map<number, Buffer>} images
 * @returns {Buffer}
 */
const encodeIcns = (images) => {
  const chunks = ICNS_TYPES.map(({type, size}) => {
    const data = images.get(size);
    if (!data) {
      throw new Error(`Missing ${size}x${size} image for icns chunk ${type}`);
    }
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(header.length + data.length, 4);
    return Buffer.concat([header, data]);
  });

  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);

  return Buffer.concat([header, ...chunks]);
};

/**
 * Windows bitmap with a 16 color palette. Only used for the NSIS installer sidebar, where
 * electron-builder expects the old 4 bit format.
 * @param {{width: number; height: number; pixels: Uint8Array}} image RGBA, row major, top down
 * @returns {Buffer}
 */
const encodeBmp4bit = ({width, height, pixels}) => {
  // 4 bits per pixel, rows padded to a 4 byte boundary
  const rowSize = (((width + 1) / 2 + 3) & ~3);
  const pixelDataSize = rowSize * height;
  const paletteSize = 16 * 4;
  const headerSize = 14 + 40 + paletteSize;
  const buffer = Buffer.alloc(headerSize + pixelDataSize);

  buffer.write('BM', 0, 2, 'ascii');
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(14 + 40 + paletteSize, 10);

  // BITMAPINFOHEADER
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26); // planes
  buffer.writeUInt16LE(4, 28); // bits per pixel
  buffer.writeUInt32LE(0, 30); // compression: none
  buffer.writeUInt32LE(pixelDataSize, 34);
  buffer.writeUInt32LE(2835, 38); // pixels per meter, 72dpi
  buffer.writeUInt32LE(2835, 42);
  buffer.writeUInt32LE(16, 46); // palette entries
  buffer.writeUInt32LE(16, 50); // important palette entries

  // Entries are BGR0. A ramp of the brand color plus a few neutrals, so that antialiased
  // edges quantize to something reasonable.
  const palette = [
    [0xff, 0x4c, 0x4c], [0xff, 0x5e, 0x5e], [0xff, 0x6b, 0x6b], [0xff, 0x7d, 0x7d],
    [0xff, 0x8f, 0x8f], [0xff, 0xa1, 0xa1], [0xff, 0xb3, 0xb3], [0xff, 0xd0, 0xd0],
    [0xff, 0xff, 0xff], [0xe6, 0xe6, 0xe6], [0xcc, 0xcc, 0xcc], [0xb3, 0xb3, 0xb3],
    [0x1f, 0x1f, 0x1f], [0x66, 0x66, 0x66], [0x99, 0x99, 0x99], [0x00, 0x00, 0x00]
  ];
  palette.forEach(([blue, green, red], index) => {
    const at = 14 + 40 + index * 4;
    buffer.writeUInt8(blue, at);
    buffer.writeUInt8(green, at + 1);
    buffer.writeUInt8(red, at + 2);
    buffer.writeUInt8(0, at + 3);
  });

  /**
   * @param {number} r
   * @param {number} g
   * @param {number} b
   * @returns {number} palette index
   */
  const nearestIndex = (r, g, b) => {
    let best = 0;
    let bestDistance = Infinity;
    palette.forEach(([blue, green, red], index) => {
      const distance = (red - r) ** 2 + (green - g) ** 2 + (blue - b) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  };

  // BMP rows are stored bottom up
  for (let y = 0; y < height; y++) {
    const sourceY = height - 1 - y;
    const rowStart = headerSize + y * rowSize;
    for (let x = 0; x < width; x += 2) {
      let byte = 0;
      for (let half = 0; half < 2; half++) {
        const sourceX = x + half;
        if (sourceX >= width) {
          break;
        }
        const at = (sourceY * width + sourceX) * 4;
        // Composite onto the light installer page
        const index = pixels[at + 3] < 128
          ? 8
          : nearestIndex(pixels[at], pixels[at + 1], pixels[at + 2]);
        byte |= (half === 0 ? index << 4 : index);
      }
      buffer.writeUInt8(byte, rowStart + x / 2);
    }
  }

  return buffer;
};

const APPX_TILES = [
  {file: 'Square44x44Logo.png', width: 44, height: 44},
  {file: 'Square44x44Logo.targetsize-44_altform-unplated.png', width: 44, height: 44},
  {file: 'Square44x44Logo.targetsize-256.png', width: 256, height: 256},
  {file: 'Square150x150Logo.png', width: 150, height: 150},
  {file: 'StoreLogo.png', width: 200, height: 200},
  {file: 'SmallTile.png', width: 71, height: 71},
  {file: 'Wide310x150Logo.png', width: 310, height: 150}
];

/**
 * @param {string} relativePath
 * @param {Buffer} data
 */
const write = async (relativePath, data) => {
  const absolute = resolveFromRoot(relativePath);
  await fsPromises.mkdir(pathUtil.dirname(absolute), {recursive: true});
  await fsPromises.writeFile(absolute, data);
  trace(`Wrote ${relativePath} (${data.length} bytes)`);
};

const generate = async () => {
  const {app, nativeImage} = require('electron');
  try {
    await fsPromises.rm(TRACE, {force: true});
  } catch (e) {
    // ignore
  }
  // Destroying the capture window would otherwise leave the app with no windows and quit
  // before anything is written, so generation always has a window to hold the app open.
  const {BrowserWindow} = require('electron');
  const anchor = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    width: 1,
    height: 1
  });

  try {
    trace('Reading the source icon');
    const svg = await fsPromises.readFile(SOURCE, 'utf-8');
    trace('Rasterizing the source icon');
    const rasterized = await rasterizeSvg(svg, 1024);
    trace(`Rasterized ${rasterized.length} bytes`);
    const images = scalePng(rasterized);
    const master = nativeImage.createFromBuffer(images.get(1024));

    await write('art/icon.png', images.get(512));
    await write('art/rich-presence-icon.png', images.get(1024));
    await write('build/512x512.png', images.get(512));

    await write('build/icon.ico', encodeIco(
      [16, 24, 32, 48, 64, 128, 256].map((size) => ({size, data: images.get(size)}))
    ));
    await write('build/icon.icns', encodeIcns(images));

    await write('docs/favicon.ico', encodeIco([
      {size: 16, data: images.get(16)},
      {size: 32, data: images.get(32)},
      {size: 48, data: images.get(48)}
    ]));

    /**
     * Draws the icon centered on a transparent canvas, so non square targets are
     * letterboxed instead of stretched.
     * @param {number} width
     * @param {number} height
     * @returns {Buffer}
     */
    const tile = (width, height) => {
      const canvas = Buffer.alloc(width * height * 4);
      const size = Math.min(width, height);
      const bitmap = new Uint8Array(master.resize({
        width: size,
        height: size,
        quality: 'best'
      }).toBitmap());
      if (bitmap.length < size * size * 4) {
        throw new Error(`Scaling to ${size} produced ${bitmap.length} bytes`);
      }
      const left = Math.floor((width - size) / 2);
      const top = Math.floor((height - size) / 2);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          canvas.set(
            bitmap.subarray((y * size + x) * 4, (y * size + x) * 4 + 4),
            ((top + y) * width + left + x) * 4
          );
        }
      }
      return nativeImage.createFromBitmap(canvas, {width, height}).toPNG();
    };

    for (const appxTile of APPX_TILES) {
      await write(pathUtil.join('build', 'appx', appxTile.file), tile(appxTile.width, appxTile.height));
    }

    // The sidebar sits on a light installer page, so the icon is drawn centered on white
    const sidebarWidth = 164;
    const sidebarHeight = 314;
    const iconSize = 120;
    const icon = new Uint8Array(master.resize({
      width: iconSize,
      height: iconSize,
      quality: 'best'
    }).toBitmap());
    if (icon.length < iconSize * iconSize * 4) {
      throw new Error(`Scaling to ${iconSize} produced ${icon.length} bytes`);
    }
    const sidebar = {
      width: sidebarWidth,
      height: sidebarHeight,
      pixels: new Uint8Array(sidebarWidth * sidebarHeight * 4).fill(255)
    };
    const left = Math.floor((sidebarWidth - iconSize) / 2);
    const top = Math.floor((sidebarHeight - iconSize) / 2);
    for (let y = 0; y < iconSize; y++) {
      for (let x = 0; x < iconSize; x++) {
        const destination = ((top + y) * sidebarWidth + left + x) * 4;
        sidebar.pixels.set(icon.subarray((y * iconSize + x) * 4, (y * iconSize + x) * 4 + 4), destination);
      }
    }
    await write('build/installerSidebar.bmp', encodeBmp4bit(sidebar));
    trace('Done');
  } finally {
    if (!anchor.isDestroyed()) {
      anchor.destroy();
    }
  }
};

module.exports = {
  generate
};

// Outside of Electron, start the regular entry point with generation switched on.
// Electron does not write to stdout on Windows, so its stderr is forwarded through a pipe.
if (!process.versions.electron) {
  const electronBinary = require('electron');
  const child = spawn(electronBinary, [pathUtil.join(root, 'src-main', 'entrypoint.js')], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      TW_GENERATE_ICONS: '1'
    }
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
  });
  child.on('exit', (code) => {
    process.exit(code === null ? 1 : code);
  });
  child.on('error', (error) => {
    console.error('Could not start Electron to generate icons:', error);
    process.exit(1);
  });
}
