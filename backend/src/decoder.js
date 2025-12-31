import sharp from 'sharp';

const SAMPLE_RATE = 44100;
const WIDTH = 320;
const HEIGHT = 240;

const BLACK_FREQ = 1500;
const WHITE_FREQ = 2300;
const FREQ_RANGE = WHITE_FREQ - BLACK_FREQ;


const HSYNC_MS = 9;
const PORCH_MS = 3;
const Y_MS = 88.064;
const LINE_MS = 150.096; 

const HSYNC_SAMPLES = Math.round(SAMPLE_RATE * HSYNC_MS / 1000);
const PORCH_SAMPLES = Math.round(SAMPLE_RATE * PORCH_MS / 1000);
const Y_SCAN_SAMPLES = Math.round(SAMPLE_RATE * Y_MS / 1000);
const LINE_SAMPLES = Math.round(SAMPLE_RATE * LINE_MS / 1000);

export async function decodeWavPcmToPngBytes(int16Samples) {
  console.log(`Processing ${int16Samples.length} samples (${(int16Samples.length/SAMPLE_RATE).toFixed(2)}s)`);
  
  const signal = new Float64Array(int16Samples.length);
  for (let i = 0; i < int16Samples.length; i++) {
    signal[i] = int16Samples[i] / 32768.0;
  }

  const syncPositions = findAllSyncPulses(signal);
  console.log(`Found ${syncPositions.length} sync pulses`);
  
  if (syncPositions.length < 10) {
    console.error('Not enough sync pulses found!');
    return decodeWithFixedTiming(signal, Math.floor(SAMPLE_RATE * 1.2));
  }
  
  const image = decodeWithSyncPositions(signal, syncPositions);
  
  return sharp(Buffer.from(image.buffer), {
    raw: { width: WIDTH, height: HEIGHT, channels: 1 }
  }).png().toBuffer();
}

function findAllSyncPulses(signal) {
  const positions = [];
  const windowSize = 256;
  const searchStart = Math.floor(SAMPLE_RATE * 0.3);
  let lastSyncPos = -LINE_SAMPLES;
  
  for (let i = searchStart; i < signal.length - windowSize; i += 100) {
    if (i - lastSyncPos < LINE_SAMPLES * 0.8) continue;
    
    const power1200 = goertzelPower(signal, i, windowSize, 1200);
    
    if (power1200 > 0.08) {
      const power1500 = goertzelPower(signal, i, windowSize, 1500);
      const power1900 = goertzelPower(signal, i, windowSize, 1900);
      
      if (power1200 > power1500 && power1200 > power1900) {

        const finePos = findPeakSync(signal, i - 50, i + 50, windowSize);
        positions.push(finePos);
        lastSyncPos = finePos;
        i += Math.floor(LINE_SAMPLES * 0.7);
      }
    }
  }

  return refineSyncPositions(positions);
}


function findPeakSync(signal, startSearch, endSearch, windowSize) {
  let bestPos = startSearch;
  let bestPower = 0;
  
  for (let pos = startSearch; pos <= endSearch && pos + windowSize < signal.length; pos += 10) {
    const power = goertzelPower(signal, pos, windowSize, 1200);
    if (power > bestPower) {
      bestPower = power;
      bestPos = pos;
    }
  }
  
  return bestPos;
}


function refineSyncPositions(positions) {
  if (positions.length < 3) return positions;
  
  const refined = [positions[0]];
  

  let totalSpacing = 0;
  let count = 0;
  for (let i = 1; i < Math.min(10, positions.length); i++) {
    totalSpacing += positions[i] - positions[i - 1];
    count++;
  }
  const avgLineSpacing = totalSpacing / count;
  
  console.log(`Average line spacing: ${avgLineSpacing.toFixed(1)} samples (${(avgLineSpacing/SAMPLE_RATE*1000).toFixed(2)}ms)`);
  

  for (let i = 1; i < positions.length; i++) {
    const detectedPos = positions[i];
    const expectedPos = refined[i - 1] + avgLineSpacing;
    const diff = Math.abs(detectedPos - expectedPos);
    
    if (diff < avgLineSpacing * 0.05) {

      refined.push(detectedPos);
    } else if (diff < avgLineSpacing * 0.15) {

      refined.push(detectedPos * 0.9 + expectedPos * 0.1);
    } else {

      console.warn(`Line ${i}: large sync error (${diff.toFixed(0)} samples), using expected position`);
      refined.push(expectedPos);
    }
  }
  
  return refined;
}

function decodeWithSyncPositions(signal, syncPositions) {
  const image = new Uint8ClampedArray(WIDTH * HEIGHT);
  
  for (let y = 0; y < HEIGHT && y < syncPositions.length; y++) {
    const syncPos = syncPositions[y];
    const yScanStart = syncPos + HSYNC_SAMPLES + PORCH_SAMPLES;
    
    if (yScanStart + Y_SCAN_SAMPLES >= signal.length) break;
    
    const samplesPerPixel = Y_SCAN_SAMPLES / WIDTH;
    
    for (let x = 0; x < WIDTH; x++) {
      const pixelCenter = Math.floor(yScanStart + (x + 0.5) * samplesPerPixel);
      

      const freq = detectFrequencyAutocorr(signal, pixelCenter, Math.floor(samplesPerPixel));
      image[y * WIDTH + x] = freqToPixel(freq);
      
      if (y === 0 && x % 40 === 0) {
        console.log(`Pixel [0,${x}]: freq=${freq.toFixed(1)}Hz -> ${image[y*WIDTH+x]}`);
      }
    }
    
    if (y % 40 === 0) console.log(`Line ${y}/${HEIGHT}`);
  }
  
  return image;
}

function decodeWithFixedTiming(signal, startPos) {
  console.log('Using fixed timing fallback');
  const image = new Uint8ClampedArray(WIDTH * HEIGHT);
  let pos = startPos;
  
  for (let y = 0; y < HEIGHT; y++) {
    const yScanStart = pos + HSYNC_SAMPLES + PORCH_SAMPLES;
    if (yScanStart + Y_SCAN_SAMPLES >= signal.length) break;
    
    const samplesPerPixel = Y_SCAN_SAMPLES / WIDTH;
    
    for (let x = 0; x < WIDTH; x++) {
      const pixelCenter = Math.floor(yScanStart + (x + 0.5) * samplesPerPixel);
      const freq = detectFrequencyAutocorr(signal, pixelCenter, Math.floor(samplesPerPixel));
      image[y * WIDTH + x] = freqToPixel(freq);
    }
    
    pos += LINE_SAMPLES;
  }
  
  return image;
}


function detectFrequencyAutocorr(signal, center, windowSize) {

  const size = Math.max(60, Math.min(windowSize, 200));
  const start = center - Math.floor(size / 2);
  
  if (start < 0 || start + size >= signal.length) return BLACK_FREQ;
  

  const minPeriod = Math.floor(SAMPLE_RATE / WHITE_FREQ) - 2; // ~17 samples for 2300Hz
  const maxPeriod = Math.floor(SAMPLE_RATE / BLACK_FREQ) + 2; // ~31 samples for 1500Hz
  
  let bestLag = minPeriod;
  let bestCorr = -Infinity;
  
  for (let lag = minPeriod; lag <= maxPeriod && lag < size / 2; lag++) {
    let corr = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < size - lag; i++) {
      const a = signal[start + i];
      const b = signal[start + i + lag];
      corr += a * b;
      normA += a * a;
      normB += b * b;
    }
    

    if (normA > 0 && normB > 0) {
      corr /= Math.sqrt(normA * normB);
    }
    
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }
  
  const freq = SAMPLE_RATE / bestLag;
  

  return Math.max(BLACK_FREQ, Math.min(WHITE_FREQ, freq));
}

function goertzelPower(signal, start, size, targetFreq) {
  if (start < 0 || start + size > signal.length) return 0;
  
  const k = Math.round((size * targetFreq) / SAMPLE_RATE);
  const omega = (2 * Math.PI * k) / size;
  const cosine = Math.cos(omega);
  const sine = Math.sin(omega);
  const coeff = 2 * cosine;
  
  let q0 = 0, q1 = 0, q2 = 0;
  
  for (let i = 0; i < size; i++) {
    const sample = signal[start + i];
    q0 = coeff * q1 - q2 + sample;
    q2 = q1;
    q1 = q0;
  }
  
  const real = q1 - q2 * cosine;
  const imag = q2 * sine;
  
  return (real * real + imag * imag) / (size * size);
}

function freqToPixel(freq) {
  if (freq <= BLACK_FREQ) return 0;
  if (freq >= WHITE_FREQ) return 255;
  return Math.round(((freq - BLACK_FREQ) / FREQ_RANGE) * 255);
}