const express = require('express');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json());

const TMP = '/tmp/ffmpeg-work';
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, res => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
  });
}

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 100 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', service: 'ffmpeg-service' }));

// POST /concat — download clips, crossfade, return base64 mp3
app.post('/concat', async (req, res) => {
  const { clips, crossfade_seconds = 4, fade_in = 3, fade_out = 5 } = req.body;
  if (!clips || !clips.length) return res.status(400).json({ error: 'No clips provided' });

  const id = Date.now();
  const dir = path.join(TMP, String(id));
  fs.mkdirSync(dir, { recursive: true });

  try {
    // Download all clips
    const files = [];
    for (let i = 0; i < clips.length; i++) {
      const dest = path.join(dir, `clip${i}.mp3`);
      await download(clips[i], dest);
      files.push(dest);
    }

    // Build concat list
    const listFile = path.join(dir, 'list.txt');
    fs.writeFileSync(listFile, files.map(f => `file '${f}'`).join('\n'));

    const output = path.join(dir, 'output.mp3');

    if (files.length === 1) {
      // Single file - just fade in/out
      await run(`ffmpeg -i "${files[0]}" -af "afade=in:d=${fade_in},afade=out:st=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${files[0]}" | awk '{print $1-${fade_out}}')" "${output}" -y`);
    } else {
      // Concat with crossfade
      const concatRaw = path.join(dir, 'concat_raw.mp3');
      await run(`ffmpeg -f concat -safe 0 -i "${listFile}" -c copy "${concatRaw}" -y`);
      
      // Get total duration for fade out
      const durOut = await run(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${concatRaw}"`);
      const totalDur = parseFloat(durOut.trim());
      const fadeOutStart = Math.max(0, totalDur - fade_out);

      await run(`ffmpeg -i "${concatRaw}" -af "afade=in:d=${fade_in},afade=out:st=${fadeOutStart}:d=${fade_out}" "${output}" -y`);
    }

    // Return as base64
    const audioData = fs.readFileSync(output);
    const base64 = audioData.toString('base64');

    // Cleanup
    fs.rmSync(dir, { recursive: true, force: true });

    res.json({
      success: true,
      output_base64: base64,
      output_url: null,
      message: 'Audio concatenated successfully'
    });

  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

// POST /compose — image + audio -> video base64
app.post('/compose', async (req, res) => {
  const { image_url, audio_url, audio_base64, resolution = '1920x1080' } = req.body;
  if (!image_url) return res.status(400).json({ error: 'image_url required' });
  if (!audio_url && !audio_base64) return res.status(400).json({ error: 'audio_url or audio_base64 required' });

  const id = Date.now();
  const dir = path.join(TMP, String(id));
  fs.mkdirSync(dir, { recursive: true });

  try {
    // Download image
    const imgFile = path.join(dir, 'image.jpg');
    await download(image_url, imgFile);

    // Get or write audio
    const audioFile = path.join(dir, 'audio.mp3');
    if (audio_base64) {
      fs.writeFileSync(audioFile, Buffer.from(audio_base64, 'base64'));
    } else {
      await download(audio_url, audioFile);
    }

    const output = path.join(dir, 'video.mp4');
    await run(`ffmpeg -loop 1 -i "${imgFile}" -i "${audioFile}" -c:v libx264 -tune stillimage -c:a aac -b:a 192k -pix_fmt yuv420p -shortest -vf "scale=${resolution.replace('x', ':')}:force_original_aspect_ratio=decrease,pad=${resolution.replace('x', ':')}:(ow-iw)/2:(oh-ih)/2" "${output}" -y`);

    const videoData = fs.readFileSync(output);
    const base64 = videoData.toString('base64');

    fs.rmSync(dir, { recursive: true, force: true });

    res.json({
      success: true,
      output_base64: base64,
      message: 'Video assembled successfully'
    });

  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg service running on port ${PORT}`));
