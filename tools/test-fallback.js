// Checks the maths of the safety-net path: a compressed file (m4a/aac, what the
// MediaRecorder hands over) -> PCM -> MP3 with lamejs.
// Inside the plugin the only different step is who decodes the container
// (decodeAudioData in Chromium; here, ffmpeg — used strictly as a decoder, so
// the ffmpeg executable is not part of the distributed plugin).
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ffmpeg = 'C:\\ffmpeg\\bin\\ffmpeg.exe';
if (!fs.existsSync(ffmpeg)) {
	console.log('skipped: ffmpeg not found at ' + ffmpeg + ' (this test needs it as a decoder)');
	process.exit(0);
}

const out = path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });
const m4a = path.join(out, 'source.m4a');
const pcmPath = path.join(out, 'decoded.pcm');
const mp3Path = path.join(out, 'converted.mp3');

execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2', '-c:a', 'aac', '-b:a', '128k', '-ac', '1', m4a], { stdio: 'ignore' });
execFileSync(ffmpeg, ['-y', '-i', m4a, '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '44100', pcmPath], { stdio: 'ignore' });

const pcmBuffer = fs.readFileSync(pcmPath);
const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, Math.floor(pcmBuffer.byteLength / 2));

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const stub = {
	Plugin: class {}, PluginSettingTab: class {}, Setting: class {}, Notice: class {},
	MarkdownView: class {}, normalizePath: (p) => p.replace(/\\/g, '/'), setIcon: () => {},
	moment: () => ({ format: () => '' }),
};
const lamejs = new Function('require', source.replace(/module\.exports[\s\S]*$/, '') + '\nreturn lamejs;')(
	(name) => (name === 'obsidian' ? stub : require(name))
);

// Same loop the plugin uses in encodeBlob(): 1152*16 sample blocks.
const encoder = new lamejs.Mp3Encoder(1, 44100, 128);
const chunks = [];
const blockSize = 1152 * 16;
for (let i = 0; i < samples.length; i += blockSize) {
	const encoded = encoder.encodeBuffer(samples.subarray(i, i + blockSize));
	if (encoded.length > 0) chunks.push(Buffer.from(encoded));
}
const tail = encoder.flush();
if (tail.length > 0) chunks.push(Buffer.from(tail));
const mp3 = Buffer.concat(chunks);
fs.writeFileSync(mp3Path, mp3);

const failures = [];
if (!(mp3[0] === 0xff && (mp3[1] & 0xe0) === 0xe0)) failures.push('valid MP3 frame');
const expected = Math.round((128 * 1000 * 2) / 8);
if (Math.abs(mp3.length - expected) > expected * 0.15) failures.push(`size out of range (${mp3.length} vs ~${expected})`);

const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', mp3Path, '-f', 'null', '-'], { encoding: 'utf8' });
const info = String(probe.stderr || '') + String(probe.stdout || '');
if (!/Audio: mp3/.test(info)) failures.push('ffmpeg recognised the MP3');
if (!/00:00:02/.test(info)) failures.push('duration of ~2s preserved');

if (failures.length) {
	console.error('FAILED: ' + failures.join(' | '));
	process.exit(1);
}
console.log(
	'fallback OK — m4a ' + fs.statSync(m4a).size + 'B -> pcm ' + pcmBuffer.length +
	'B (' + samples.length + ' samples) -> mp3 ' + mp3.length + 'B, ffmpeg decodes it as 2s'
);
