// Smoke test: runs the generated main.js with a controlled `require`, checking
// that the bundle loads, that lamejs was inlined into the module scope, that the
// plugin class is exported, and that the MP3 encoder actually produces frames.
const fs = require('fs');
const path = require('path');

const mainJs = path.join(__dirname, '..', 'main.js');
const source = fs.readFileSync(mainJs, 'utf8');

const stub = {
	Plugin: class Plugin {},
	PluginSettingTab: class PluginSettingTab {},
	Setting: class Setting {},
	Notice: class Notice {},
	MarkdownView: class MarkdownView {},
	normalizePath: (p) => p.replace(/\\/g, '/'),
	setIcon: () => {},
	moment: () => ({ format: () => '2026-09-25 18.20.33' }),
};

const failures = [];
if (!source.includes('function lamejs()')) failures.push('lamejs bundled into main.js');
if (!source.includes('ExcalidrawAutomate')) failures.push('Excalidraw path present (window.ExcalidrawAutomate)');
if (!source.includes('addEmbeddable')) failures.push('addEmbeddable insertion present');
if (!source.includes('activeEmbeddable')) failures.push('activeEmbeddable activation present');
if (!source.includes('voicecomment.log')) failures.push('diagnostic log path present');

// Same shape as Obsidian's plugin loader: CommonJS with a controlled require.
const factory = new Function(
	'require',
	'module',
	'exports',
	source + '\n;return { exported: module.exports, lame: typeof lamejs === "undefined" ? null : lamejs };'
);
const fakeModule = { exports: {} };
const runtime = factory(
	(name) => {
		if (name === 'obsidian') return stub;
		return require(name);
	},
	fakeModule,
	fakeModule.exports
);

const exported = runtime.exported;
if (typeof exported !== 'function') failures.push('module.exports is a class');
else if (exported.name !== 'VoiceCommentPlugin') failures.push('exported class must be VoiceCommentPlugin, got "' + exported.name + '"');

const lame = runtime.lame;
if (!lame || typeof lame.Mp3Encoder !== 'function') failures.push('lamejs.Mp3Encoder reachable from inside the bundle');

let mp3Bytes = 0;
if (lame && typeof lame.Mp3Encoder === 'function') {
	const enc = new lame.Mp3Encoder(1, 44100, 128);
	const pcm = new Int16Array(44100);
	for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * 300 * i) / 44100) * 8000);
	const chunks = [];
	for (let i = 0; i < pcm.length; i += 1152) {
		const b = enc.encodeBuffer(pcm.subarray(i, i + 1152));
		if (b.length) chunks.push(Buffer.from(b));
	}
	const tail = enc.flush();
	if (tail.length) chunks.push(Buffer.from(tail));
	const mp3 = Buffer.concat(chunks);
	mp3Bytes = mp3.length;
	if (!(mp3[0] === 0xff && (mp3[1] & 0xe0) === 0xe0)) failures.push('valid MP3 frame (0xFFEx sync)');
}

if (failures.length) {
	console.error('SMOKE FAILED: ' + failures.join(' | '));
	process.exit(1);
}
console.log(
	'smoke OK — bundle ' + source.length + ' chars, class "' + exported.name +
	'", 1 s of MP3 at 128 kbps = ' + mp3Bytes + ' bytes'
);
