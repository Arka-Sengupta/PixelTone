import sharp from 'sharp';
import { pcm16ToWavBytes } from './wav.js';

const IMAGE_WIDTH = 320;
const IMAGE_HEIGHT = 240;
const SAMPLE_RATE = 44100;

const BLACK_FREQUENCY = 1500;
const WHITE_FREQUENCY = 2300;

const HSYNC_MS = 9;
const PORCH_MS = 3;
const Y_MS = 88.064;
const UV_MS = 44.032;

export async function encodeImageToRobot36WavBuffer(inputBuffer) {
  const resized = await sharp(inputBuffer)
    .resize(IMAGE_WIDTH, IMAGE_HEIGHT, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data, info } = resized;
  const yuv = rgbBufferToYuvPlanes(data, info.width, info.height);
  const pcm = generateRobot36Pcm(yuv);

  return pcm16ToWavBytes(pcm, SAMPLE_RATE, 1);
}

function clamp(v) {
  return Math.max(0, Math.min(255, v));
}

function rgbBufferToYuvPlanes(rgb, width, height) {
  const Y = new Float32Array(width * height);
  const U = new Float32Array(width * height);
  const V = new Float32Array(width * height);

  let idx = 0;
  for (let i = 0; i < width * height; i++) {
    const r = rgb[idx++];
    const g = rgb[idx++];
    const b = rgb[idx++];

    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const u = (b - y) * 0.492 + 128;
    const v = (r - y) * 0.877 + 128;

    Y[i] = clamp(y);
    U[i] = clamp(u);
    V[i] = clamp(v);
  }

  return { Y, U, V, width, height };
}

function generateRobot36Pcm({ Y, U, V, width, height }) {
  const samples = [];
  let phase = 0;

  const appendTone = (freq, ms) => {
    const count = Math.floor((ms / 1000) * SAMPLE_RATE);
    for (let i = 0; i < count; i++) {
      samples.push(Math.sin(phase) * 32767);
      phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    }
    phase %= 2 * Math.PI;
  };

  const appendScanline = (line, ms) => {
    const count = Math.floor((ms / 1000) * SAMPLE_RATE);
    for (let i = 0; i < count; i++) {
      const idx = Math.min(
        Math.floor((i / count) * line.length),
        line.length - 1
      );
      const pixel = line[idx];
      const freq =
        BLACK_FREQUENCY +
        (pixel / 255) * (WHITE_FREQUENCY - BLACK_FREQUENCY);

      samples.push(Math.sin(phase) * 32767);
      phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    }
    phase %= 2 * Math.PI;
  };

  const downsample = (src) => {
    const dst = new Float32Array(width / 2);
    for (let i = 0; i < dst.length; i++) {
      dst[i] = src[i * 2];
    }
    return dst;
  };

  // --- Header ---
  appendTone(1900, 300);
  appendTone(1200, 10);
  appendTone(1900, 300);
  appendVisCode(0x08); 

  // --- Image ---
  for (let line = 0; line < height; line++) {
    appendTone(1200, HSYNC_MS);
    appendTone(1500, PORCH_MS);

    appendScanline(
      Y.subarray(line * width, (line + 1) * width),
      Y_MS
    );

    appendTone(1500, 4.5);
    appendTone(1900, 1.5);

    if (line % 2 === 0) {
      appendScanline(
        downsample(V.subarray(line * width, (line + 1) * width)),
        UV_MS
      );
    } else {
      appendScanline(
        downsample(U.subarray(line * width, (line + 1) * width)),
        UV_MS
      );
    }
  }

  function appendVisCode(vis) {
    appendTone(1200, 30);

    let parity = 0;
    for (let i = 0; i < 7; i++) {
      const bit = (vis >> i) & 1;
      parity ^= bit;
      appendTone(bit ? 1100 : 1300, 30);
    }

    appendTone(parity ? 1100 : 1300, 30);
    appendTone(1200, 30);
  }

  return Int16Array.from(samples);
}
