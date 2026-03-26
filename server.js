const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

const TMP = '/tmp/ffmpeg-work';
const OUT = '/tmp/ffmpeg-output';
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

app.use('/files', express.static(OUT));

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, res => {
      if (res.statusCode !== 200) { reject(new Error(`Failed: ${res.statusCode}`)); return; }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 500 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

app.get('/', (req, res) => res.json({ status: 'ok', service: 'ffmpeg-service' }));

app.post('/concat', async (req, res) => {
  const { clips, crossfade_seconds = 4, fade_in = 3, fade_out = 5 } = req.body;
  if (!clips || !clips.length) return res.status(400).json({ error: 'No clips provided' });

  const id = Date.now();
  const dir = path.join(TMP, String(id));
  fs.mkdirSync(dir, { recursive: true });

  try {
    const files = [];
    for (let i = 0; i < clips.length; i++) {
      const dest = path.join(dir, `clip${i}.mp3`);
      await download(clips[i], dest);
      files.push(dest);
    }

    const outputName = `audio_${id}.mp3`;
    const output = path.join(OUT, outputName);

    if (files.length === 1) {
      await run(`ffmpeg -i "${files[0]}" -af "afade=in:d=${fade_in}" "${output}" -y`);
    } else {
      const listFile = path.join(dir, 'list.txt');
      fs.writeFileSync(listFile, files.map(f => `file '${f}'`).join('\n'));
      const concatRaw = path.join(dir, 'concat_raw.mp3');
      await run(`ffmpeg -f concat -safe 0 -i "${listFile}" -c copy "${concatRaw}" -y`);
      const durOut = await run(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${concatRaw}"`);
      const totalDur = parseFloat(durOut.trim());
      const fadeOutStart = Math.max(0, totalDur - fade_out);
      await run(`ffmpeg -i "${concatRaw}" -af "afade=in:d=${fade_in},afade=out:st=${fadeOutStart}:d=${fade_out}" "${output}" -y`);
    }

    fs.rmSync(dir, { recursive: true, force: true });
    const outputUrl = `${req.protocol}://${req.get('host')}/files/${outputName}`;
    res.json({ success: true, output_url: outputUrl, message: 'Audio concatenated successfully' });

  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

app.post('/compose', async (req, res) => {
  const { image_url, audio_url, resolution = '1920x1080' } = req.body;
  if (!image_url) return res.status(400).json({ error: 'image_url required' });
  if (!audio_url) return res.status(400).json({ error: 'audio_url required' });

  const id = Date.now();
  const dir = path.join(TMP, String(id));
  fs.mkdirSync(dir, { recursive: true });

  try {
    const imgFile = path.join(dir, 'image.jpg');
    const audioFile = path.join(dir, 'audio.mp3');
    await download(image_url, imgFile);
    await download(audio_url, audioFile);

    const outputName = `video_${id}.mp4`;
    const output = path.join(OUT, outputName);
    const [w, h] = resolution.split('x');
    await run(`ffmpeg -loop 1 -i "${imgFile}" -i "${audioFile}" -c:v libx264 -tune stillimage -c:a aac -b:a 192k -pix_fmt yuv420p -shortest -vf "scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2" "${output}" -y`);

    fs.rmSync(dir, { recursive: true, force: true });
    const outputUrl = `${req.protocol}://${req.get('host')}/files/${outputName}`;
    res.json({ success: true, output_url: outputUrl, message: 'Video assembled successfully' });

  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg service running on port ${PORT}`));
