import express from 'express';
import cors from 'cors';
import multer from 'multer';

import { encodeImageToRobot36WavBuffer } from './encoder.js';
import { decodeWavPcmToPngBytes } from './decoder.js';

const app = express();
const upload = multer();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// ---------- ENCODE ----------
app.post('/api/encode', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Missing image file' });
    }

    const wavBytes = await encodeImageToRobot36WavBuffer(req.file.buffer);

    res.set('Content-Type', 'audio/wav');
    res.set('Content-Disposition', 'attachment; filename="output.wav"');
    res.send(Buffer.from(wavBytes));

  } catch (e) {
    console.error('ENCODE ERROR:', e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- DECODE ----------
app.post('/api/decode', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Missing audio file (wav)' });
    }

    const { samples } = parsePcm16Wav(req.file.buffer);
    const png = await decodeWavPcmToPngBytes(samples);

    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', 'attachment; filename="decoded_sstv.png"');
    res.send(png);

  } catch (e) {
    console.error('DECODE ERROR:', e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`SSTV backend listening on :${PORT}`);
});

// ---------- WAV PARSER ----------
function parsePcm16Wav(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  let pos = 12;
  let dataOffset = -1;
  let dataSize = -1;
  let channels = 1;
  let sampleRate = 44100;
  let bps = 16;

  while (pos + 8 <= dv.byteLength) {
    const id = String.fromCharCode(
      dv.getUint8(pos),
      dv.getUint8(pos + 1),
      dv.getUint8(pos + 2),
      dv.getUint8(pos + 3)
    );
    const size = dv.getUint32(pos + 4, true);

    if (id === 'fmt ') {
      const fmt = pos + 8;
      const format = dv.getUint16(fmt, true);
      channels = dv.getUint16(fmt + 2, true);
      sampleRate = dv.getUint32(fmt + 4, true);
      bps = dv.getUint16(fmt + 14, true);

      if (format !== 1 || bps !== 16) {
        throw new Error('Only PCM16 WAV supported');
      }
    }

    if (id === 'data') {
      dataOffset = pos + 8;
      dataSize = size;
      break;
    }

    pos += 8 + size;
  }

  if (dataOffset < 0) {
    throw new Error('WAV data chunk not found');
  }

  const samples = new Int16Array(dataSize / 2);
  let o = dataOffset;
  for (let i = 0; i < samples.length; i++) {
    samples[i] = dv.getInt16(o, true);
    o += 2;
  }

  // Stereo → mono (left channel)
  if (channels > 1) {
    const mono = new Int16Array(Math.floor(samples.length / channels));
    for (let i = 0; i < mono.length; i++) {
      mono[i] = samples[i * channels];
    }
    return { samples: mono, sampleRate };
  }

  return { samples, sampleRate };
}

//temp patch

app.post('/api/decode', upload.single('audio'), async (req, res) => {
  try {
    console.log('--- DECODE REQUEST ---');
    console.log('file:', req.file?.originalname);
    console.log('size:', req.file?.size);

    if (!req.file) {
      throw new Error('No audio file received');
    }

    const { samples } = parsePcm16Wav(req.file.buffer);
    console.log('samples:', samples.length);

    const png = await decodeWavPcmToPngBytes(samples);

    res.set('Content-Type', 'image/png');
    res.send(png);

  } catch (e) {
    console.error('DECODE CRASH:', e);
    res.status(500).json({ error: e.message });
  }
});
