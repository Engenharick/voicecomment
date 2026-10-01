/*
 * VoiceComment 2.0 — grava um áudio e plota no desenho um retângulo (embeddable)
 * que mostra uma página HTML autossuficiente com o áudio dentro.
 *
 * Copyright (C) 2026 Engenharick
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Lesser General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version. This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE. See the LICENSE file for details.
 *
 * lamejs (LGPL-3.0) goes bundled, unmodified, inside the distributed main.js —
 * see src/lamejs-LICENSE.txt. build.ps1 concatenates it with this file.
 *
 * Como funciona:
 *   1. o microfone é capturado por dois caminhos (PCM→lamejs, preferido, e
 *      MediaRecorder como rede de segurança) e vira MP3;
 *   2. o MP3 é gravado na pasta de gravações junto de uma página HTML
 *      autossuficiente com o áudio em base64 (o áudio não precisa de outro
 *      arquivo para tocar);
 *   3. o plugin sobe um servidor local (127.0.0.1, só esta máquina) que serve
 *      aquela pasta;
 *   4. no desenho, um elemento "embeddable" aponta para
 *      http://127.0.0.1:<porta>/<arquivo>.html — o Excalidraw renderiza links
 *      como web view (um webview com autoplayPolicy=document-user-activation-
 *      required, isto é: não toca sem clique) e o elemento fica salvo no
 *      .excalidraw.md, então o retângulo volta quando o desenho é reaberto.
 */
const obsidian = require("obsidian");
const { Plugin, PluginSettingTab, Setting, Notice, TFile, normalizePath, setIcon } = obsidian;
const http = require("http");
const fs = require("fs");
const path = require("path");

const DEFAULT_SETTINGS = {
	folder: "VoiceComment",
	bitrate: 128,
	port: 8781,
	rectWidth: 470,
	rectHeight: 200,
	// Cores do retângulo plotado (o que o Excalidraw pinta atrás da página). A
	// página não pinta fundo próprio, então a cor aparece. "transparent" (padrão)
	// mantém o comportamento antigo: retângulo sem cor nenhuma.
	rectStrokeColor: "transparent",
	rectBackgroundColor: "transparent",
	// Desenho do ícone na barra lateral (nome de ícone do Lucide). A cópia usa um
	// desenho diferente para dar para distinguir os dois sem passar o mouse.
	ribbonIconName: "mic",
	showRibbonIcon: true,
};

const PAGE_MARKER = "<!-- AudioHtmlEmbed: página com áudio embutido -->";

const MIME_BY_EXTENSION = {
	".html": "text/html; charset=utf-8",
	".mp3": "audio/mpeg",
	".m4a": "audio/mp4",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".webm": "audio/webm",
};

// ---- utilidades ------------------------------------------------------------

function formatDuration(ms) {
	const total = Math.max(0, Math.floor(ms / 1000));
	return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function stamp() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

function safeFileName(name) {
	return String(name || "")
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[.\s]+|[.\s]+$/g, "");
}

function escapeHtml(text) {
	return String(text)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

// btoa em fatias: uma chamada só, num arquivo longo, estoura a lista de argumentos.
function bytesToBase64(bytes) {
	let binary = "";
	const slice = 0x8000;
	for (let i = 0; i < bytes.length; i += slice) {
		binary += String.fromCharCode.apply(null, bytes.subarray(i, i + slice));
	}
	return btoa(binary);
}

function joinChunks(chunks) {
	let total = 0;
	for (const chunk of chunks) total += chunk.byteLength;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function floatToPcm(input) {
	const pcm = new Int16Array(input.length);
	let peak = 0;
	for (let i = 0; i < input.length; i++) {
		let sample = input[i];
		const magnitude = sample < 0 ? -sample : sample;
		if (magnitude > peak) peak = magnitude;
		if (sample > 1) sample = 1;
		else if (sample < -1) sample = -1;
		pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
	}
	return { pcm, peak };
}

// A página do retângulo: compacta (cabe no elemento), sem CDN, sem autoplay e com
// player próprio — o botão do player nativo vive numa shadow root fechada e não
// aceita ser aumentado por CSS.
function buildRectanglePage(name, mime, base64, byteLength) {
	const title = escapeHtml(name);
	const dataUri = `data:${mime};base64,${base64}`;
	const size = byteLength >= 1048576
		? `${(byteLength / 1048576).toFixed(1)} MB`
		: `${(byteLength / 1024).toFixed(1)} KB`;
	return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>${title}</title>
${PAGE_MARKER}
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; display: flex; align-items: center; justify-content: center;
	font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
	background: transparent; color: #fff; }
.card { width: 100%; padding: 12px 16px; }
/* Texto claro com sombra escura: legível sobre qualquer cor de fundo que o
   retângulo receba (a página não pinta fundo próprio). */
h1 { margin: 0 0 8px; font-size: 12px; font-weight: 600; text-align: center;
	word-break: break-word; text-shadow: 0 1px 3px rgba(0,0,0,.65), 0 0 8px rgba(0,0,0,.4); }
.player { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.play {
	width: 84px; height: 84px; padding: 0; border: 0; border-radius: 50%;
	background: #4b4bd6; color: #fff; cursor: pointer; display: grid; place-items: center;
	box-shadow: 0 4px 14px rgba(0,0,0,.35), 0 0 0 2px rgba(255,255,255,.4);
	transition: transform .08s ease, background .15s ease;
}
.play:hover { background: #3f3fc0; transform: scale(1.04); }
.play:active { transform: scale(.97); }
.play:focus-visible { outline: 3px solid #a5a5ff; outline-offset: 3px; }
.play svg { width: 42px; height: 42px; fill: currentColor; display: block; }
.play .icon-pause { display: none; }
.play.playing .icon-play { display: none; }
.play.playing .icon-pause { display: block; }
/* Barra com trilho escuro e preenchimento branco: aparece tanto em fundo claro
   quanto escuro. */
.bar { width: 100%; height: 8px; border-radius: 5px; background: rgba(0,0,0,.35);
	border: 1px solid rgba(255,255,255,.35); cursor: pointer; overflow: hidden; }
.fill { height: 100%; width: 0; background: #fff; border-radius: 5px; }
.time { font-size: 11px; font-variant-numeric: tabular-nums;
	text-shadow: 0 1px 3px rgba(0,0,0,.65), 0 0 8px rgba(0,0,0,.4); }
.row { margin-top: 8px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
/* O link vira uma "pastilha" escura translúcida, para não sumir em fundo escuro. */
a { font-size: 11px; color: #fff; text-decoration: none; padding: 3px 8px; border-radius: 6px;
	background: rgba(0,0,0,.38); }
a:hover { background: rgba(0,0,0,.55); }
.meta { font-size: 11px; text-shadow: 0 1px 3px rgba(0,0,0,.65), 0 0 8px rgba(0,0,0,.4); }
audio { display: none; }
@media (prefers-color-scheme: dark) {
	.play { background: #6d6de8; }
	.play:hover { background: #7f7ff0; }
}
</style>
</head>
<body>
<div class="card">
	<h1>${title}</h1>
	<div class="player">
		<button id="toggle" class="play" type="button" aria-label="Tocar" title="Tocar / pausar">
			<svg class="icon-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
			<svg class="icon-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
		</button>
		<div class="bar" id="bar" title="Avançar"><div class="fill" id="fill"></div></div>
		<div class="time"><span id="now">0:00</span> / <span id="total">0:00</span></div>
	</div>
	<div class="row">
		<a id="download" download="${title}" href="#">baixar o mp3</a>
		<span class="meta">${size}</span>
	</div>
	<audio id="player" preload="metadata" src="${dataUri}"></audio>
</div>
<script>
var player = document.getElementById("player");
var toggle = document.getElementById("toggle");
var fill = document.getElementById("fill");
var bar = document.getElementById("bar");
var now = document.getElementById("now");
var total = document.getElementById("total");
var download = document.getElementById("download");

function fmt(segundos) {
	if (!isFinite(segundos)) return "0:00";
	var m = Math.floor(segundos / 60);
	var s = Math.floor(segundos % 60);
	return m + ":" + (s < 10 ? "0" + s : s);
}

toggle.addEventListener("click", function () {
	// Nunca há autoplay: o som só começa por este clique.
	if (player.paused) player.play(); else player.pause();
});
player.addEventListener("play", function () {
	toggle.classList.add("playing");
	toggle.setAttribute("aria-label", "Pausar");
});
player.addEventListener("pause", function () {
	toggle.classList.remove("playing");
	toggle.setAttribute("aria-label", "Tocar");
});
player.addEventListener("ended", function () {
	toggle.classList.remove("playing");
	fill.style.width = "0%";
	now.textContent = "0:00";
});
player.addEventListener("loadedmetadata", function () { total.textContent = fmt(player.duration); });
player.addEventListener("timeupdate", function () {
	if (player.duration) fill.style.width = (player.currentTime / player.duration) * 100 + "%";
	now.textContent = fmt(player.currentTime);
});
bar.addEventListener("click", function (evento) {
	if (!player.duration) return;
	var area = bar.getBoundingClientRect();
	var fracao = Math.min(1, Math.max(0, (evento.clientX - area.left) / area.width));
	player.currentTime = fracao * player.duration;
});
// O botão de baixar usa a mesma fonte do player: o áudio aparece uma vez só.
if (player.src) download.href = player.src;
</script>
</body>
</html>
`;
}

// ---- gravador --------------------------------------------------------------

const MIN_BYTES = 2000;
const MIN_PEAK = 0.0005;

class Recorder {
	constructor(logger) {
		this.log = logger || (() => {});
		this.reset();
	}

	reset() {
		this.stream = null;
		this.ctx = null;
		this.source = null;
		this.analyser = null;
		this.processor = null;
		this.sink = null;
		this.encoder = null;
		this.chunks = [];
		this.spectrum = null;
		this.mediaRecorder = null;
		this.mediaChunks = [];
		this.mimeType = "";
		this.bitrate = 128;
		this.pcmPeak = 0;
		this.startedAt = 0;
	}

	get active() {
		return this.ctx !== null || this.mediaRecorder !== null;
	}

	elapsedMs() {
		return this.startedAt ? Math.max(0, performance.now() - this.startedAt) : 0;
	}

	pickMimeType() {
		if (typeof MediaRecorder === "undefined") return "";
		for (const candidate of ["audio/mp4", 'audio/webm;codecs="opus"', "audio/webm", "audio/ogg"]) {
			if (MediaRecorder.isTypeSupported(candidate)) return candidate;
		}
		return "";
	}

	async start(bitrate) {
		this.bitrate = bitrate || 128;
		this.stream = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
		});

		this.mimeType = this.pickMimeType();
		this.mediaChunks = [];
		try {
			this.mediaRecorder = new MediaRecorder(this.stream, this.mimeType ? { mimeType: this.mimeType } : undefined);
			this.mediaRecorder.addEventListener("dataavailable", (event) => {
				if (event.data && event.data.size > 0) this.mediaChunks.push(event.data);
			});
			this.mediaRecorder.start(1000);
		} catch (error) {
			this.mediaRecorder = null;
			this.log("MediaRecorder indisponível: " + (error && error.message ? error.message : error));
		}

		let ctx;
		try {
			ctx = new AudioContext({ sampleRate: 44100 });
		} catch (error) {
			ctx = new AudioContext();
		}
		this.ctx = ctx;
		// Contexto criado sem ativação do usuário nasce suspenso: sem retomar, o
		// grafo não roda e onaudioprocess nunca dispara (e o cronômetro engana).
		if (ctx.state === "suspended") {
			try {
				await ctx.resume();
			} catch (error) {
				this.log("ctx.resume() falhou: " + (error && error.message ? error.message : error));
			}
		}
		this.log(`captura: AudioContext=${ctx.state} taxa=${ctx.sampleRate}Hz mime=${this.mimeType || "(padrão)"} kbps=${this.bitrate}`);

		this.source = ctx.createMediaStreamSource(this.stream);
		this.analyser = ctx.createAnalyser();
		this.analyser.fftSize = 1024;
		this.spectrum = new Float32Array(this.analyser.fftSize);
		this.source.connect(this.analyser);

		this.processor = ctx.createScriptProcessor(4096, 1, 1);
		this.analyser.connect(this.processor);
		this.sink = ctx.createGain();
		this.sink.gain.value = 0;
		this.processor.connect(this.sink);
		this.sink.connect(ctx.destination);

		this.encoder = new lamejs.Mp3Encoder(1, ctx.sampleRate, this.bitrate);
		this.chunks = [];
		this.pcmPeak = 0;

		this.processor.onaudioprocess = (event) => {
			if (!this.encoder) return;
			const { pcm, peak } = floatToPcm(event.inputBuffer.getChannelData(0));
			if (peak > this.pcmPeak) this.pcmPeak = peak;
			const encoded = this.encoder.encodeBuffer(pcm);
			if (encoded.length > 0) this.chunks.push(new Uint8Array(encoded));
		};

		this.startedAt = performance.now();
	}

	readLevel() {
		if (!this.analyser || !this.spectrum) return 0;
		this.analyser.getFloatTimeDomainData(this.spectrum);
		let sum = 0;
		for (let i = 0; i < this.spectrum.length; i++) sum += this.spectrum[i] * this.spectrum[i];
		return Math.min(1, Math.sqrt(sum / this.spectrum.length) * 4);
	}

	async stop() {
		if (!this.active) return null;
		const durationMs = this.elapsedMs();
		const bitrate = this.bitrate;

		let pcm = null;
		if (this.encoder) {
			try {
				const tail = this.encoder.flush();
				if (tail.length > 0) this.chunks.push(new Uint8Array(tail));
				pcm = joinChunks(this.chunks);
			} catch (error) {
				this.log("flush do PCM falhou: " + (error && error.message ? error.message : error));
			}
		}

		const blob = await this.stopMediaRecorder();
		const pcmBytes = pcm ? pcm.byteLength : 0;
		const peak = this.pcmPeak;
		this.teardown();
		this.log(`stop: ${Math.round(durationMs)}ms pcm=${pcmBytes}B pico=${peak.toFixed(4)} media=${blob ? blob.size : 0}B`);

		if (pcmBytes > MIN_BYTES && peak > MIN_PEAK) return { data: pcm, durationMs, source: "pcm" };
		if (blob) {
			try {
				const converted = await this.encodeBlob(blob, bitrate);
				if (converted.byteLength > MIN_BYTES) return { data: converted, durationMs, source: "media" };
			} catch (error) {
				this.log("conversão do MediaRecorder falhou: " + (error && error.message ? error.message : error));
			}
		}
		if (pcmBytes > 0) return { data: pcm, durationMs, source: "pcm-silencioso" };
		return null;
	}

	async encodeBlob(blob, bitrate) {
		const arrayBuffer = await blob.arrayBuffer();
		const decodeCtx = new OfflineAudioContext(1, 1, 44100);
		const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
		const samples = audioBuffer.getChannelData(0);
		const encoder = new lamejs.Mp3Encoder(1, audioBuffer.sampleRate, bitrate || 128);
		const chunks = [];
		const blockSize = 1152 * 16;
		for (let i = 0; i < samples.length; i += blockSize) {
			const { pcm } = floatToPcm(samples.subarray(i, i + blockSize));
			const encoded = encoder.encodeBuffer(pcm);
			if (encoded.length > 0) chunks.push(new Uint8Array(encoded));
		}
		const tail = encoder.flush();
		if (tail.length > 0) chunks.push(new Uint8Array(tail));
		return joinChunks(chunks);
	}

	stopMediaRecorder() {
		return new Promise((resolve) => {
			const recorder = this.mediaRecorder;
			this.mediaRecorder = null;
			if (!recorder || recorder.state === "inactive") return resolve(null);
			recorder.addEventListener("stop", () => {
				const blob = this.mediaChunks.length > 0
					? new Blob(this.mediaChunks, { type: this.mimeType || "audio/webm" })
					: null;
				this.mediaChunks = [];
				resolve(blob);
			}, { once: true });
			try {
				recorder.stop();
			} catch (error) {
				resolve(null);
			}
		});
	}

	discard() {
		this.stopMediaRecorder();
		this.teardown();
	}

	teardown() {
		try {
			if (this.processor) {
				this.processor.onaudioprocess = null;
				this.processor.disconnect();
			}
		} catch (error) { /* noop */ }
		try { if (this.source) this.source.disconnect(); } catch (error) { /* noop */ }
		try { if (this.analyser) this.analyser.disconnect(); } catch (error) { /* noop */ }
		try { if (this.sink) this.sink.disconnect(); } catch (error) { /* noop */ }
		try { if (this.stream) this.stream.getTracks().forEach((track) => track.stop()); } catch (error) { /* noop */ }
		try { if (this.ctx) this.ctx.close(); } catch (error) { /* noop */ }
		this.reset();
	}
}

// ---- painel de gravação ----------------------------------------------------

class RecorderPanel {
	constructor(handlers) {
		this.handlers = handlers;
		this.levels = [];
		this.el = document.body.createDiv({ cls: "ahembed-panel is-hidden" });
		this.targetName = this.el.createDiv({ cls: "ahembed-target", text: "Gravando…" });
		this.canvas = this.el.createEl("canvas", { cls: "ahembed-meter", attr: { width: 240, height: 40 } });
		this.meter = this.canvas.getContext("2d");
		this.timeEl = this.el.createDiv({ cls: "ahembed-time", text: "00:00" });
		const controls = this.el.createDiv({ cls: "ahembed-controls" });
		this.stopBtn = this.button(controls, "square", "Parar e plotar", () => this.handlers.onStop());
		this.stopBtn.addClass("mod-record");
		this.discardBtn = this.button(controls, "trash-2", "Descartar", () => this.handlers.onDiscard());
	}

	button(parent, icon, label, onClick) {
		const el = parent.createEl("button", { cls: "ahembed-control" });
		setIcon(el, icon);
		el.setAttribute("aria-label", label);
		el.addEventListener("click", onClick);
		return el;
	}

	show(targetName) {
		this.targetName.setText(targetName);
		this.levels = [];
		this.timeEl.setText("00:00");
		this.el.removeClass("is-hidden");
		this.render();
	}

	hide() {
		this.el.addClass("is-hidden");
	}

	setTime(ms) {
		this.timeEl.setText(formatDuration(ms));
	}

	pushLevel(level) {
		this.levels.push(level);
		if (this.levels.length > 64) this.levels.splice(0, this.levels.length - 64);
		this.render();
	}

	render() {
		const ctx = this.meter;
		const style = getComputedStyle(document.body);
		ctx.fillStyle = style.getPropertyValue("--background-secondary") || "#222";
		ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
		const capacity = Math.floor(this.canvas.width / 6);
		const levels = this.levels.slice(-capacity);
		levels.forEach((level, index) => {
			const height = Math.max(3, level * (this.canvas.height - 8));
			ctx.fillStyle = style.getPropertyValue("--interactive-accent") || "#888";
			ctx.fillRect(index * 6, (this.canvas.height - height) / 2, 4, height);
		});
	}

	destroy() {
		this.el.remove();
	}
}

// ---- o plugin --------------------------------------------------------------

class AudioHtmlEmbedPlugin extends Plugin {
	async onload() {
		await this.loadSettings();
		this.recorder = new Recorder((message) => this.log(message));
		this.panel = new RecorderPanel({
			onStop: () => this.stopAndPlot(),
			onDiscard: () => this.discardRecording(),
		});
		this.ribbonIcon = null;
		this.server = null;
		this.effectivePort = null;

		this.statusBar = this.addStatusBarItem();
		this.addSettingTab(new AudioHtmlEmbedSettingTab(this.app, this));
		this.refreshRibbonIcon();
		this.addCommands();
		this.registerInterval(window.setInterval(() => this.tick(), 60));

		this.startServer();
		this.log(`plugin carregado — pasta "${this.folderPath()}"`);
	}

	async onunload() {
		this.stopServer();
		if (this.recorder) this.recorder.discard();
		if (this.panel) this.panel.destroy();
		if (this.statusBar) this.statusBar.setText("");
	}

	addCommands() {
		this.addCommand({
			id: "record-and-plot",
			name: "Gravar áudio e plotar no desenho",
			callback: () => this.toggleRecording(),
		});
		this.addCommand({
			id: "restart-server",
			name: "Reiniciar o servidor local das páginas",
			callback: () => {
				this.stopServer();
				this.startServer();
			},
		});
		this.addCommand({
			id: "insert-page-here",
			name: "Plotar no desenho a última página gravada",
			checkCallback: (checking) => {
				if (!this.lastPage) return false;
				if (!checking) this.plotPage(this.lastPage);
				return true;
			},
		});
		this.addCommand({
			id: "rebuild-pages",
			name: "Refazer as páginas das gravações (player novo)",
			callback: () => this.rebuildPages(),
		});
	}

	// Reescreve a página de cada MP3 da pasta, para gravações antigas passarem a
	// usar o player novo. Só mexe em página que o plugin escreveu (tem o marcador).
	async rebuildPages() {
		const folder = this.folderPath();
		const mp3s = this.app.vault.getFiles()
			.filter((file) => file.path.startsWith(`${folder}/`) && /\.mp3$/i.test(file.name));
		if (!mp3s.length) {
			this.aviso(`AudioHtmlEmbed: nenhum MP3 em "${folder}".`);
			return;
		}
		let feitas = 0;
		let falhas = 0;
		for (const mp3 of mp3s) {
			try {
				const bytes = new Uint8Array(await this.app.vault.readBinary(mp3));
				const page = buildRectanglePage(mp3.name, "audio/mpeg", bytesToBase64(bytes), bytes.length);
				const caminho = normalizePath(mp3.path.replace(/\.mp3$/i, ".html"));
				const existente = this.app.vault.getAbstractFileByPath(caminho);
				if (existente instanceof TFile) {
					const atual = await this.app.vault.read(existente);
					if (!atual.includes(PAGE_MARKER)) {
						falhas++;
						this.log(`refazer páginas: ${caminho} não é página do plugin, deixei como está`);
						continue;
					}
					await this.app.vault.modify(existente, page);
				} else {
					await this.app.vault.create(caminho, page);
				}
				feitas++;
			} catch (error) {
				falhas++;
				this.log("refazer páginas falhou em " + mp3.path + ": " + (error && error.message ? error.message : error));
			}
		}
		this.log(`refazer páginas: ${feitas} refeita(s), ${falhas} falha(s)`);
		this.aviso(`AudioHtmlEmbed: ${feitas} página(s) refeita(s) com o player novo${falhas ? `, ${falhas} sem mexer` : ""}.`);
	}

	// O log fica na pasta do próprio plugin — assim a cópia de teste tem o dela,
	// sem escrever no log da principal.
	logPath() {
		return `.obsidian/plugins/${this.manifest.id}/voicecomment.log`;
	}

	async log(message) {
		try {
			const adapter = this.app.vault.adapter;
			const caminho = this.logPath();
			let info = null;
			try {
				info = await adapter.stat(caminho);
			} catch (error) {
				info = null;
			}
			if (info && info.size > 120000) await adapter.write(caminho, "");
			await adapter.append(caminho, `[${stamp()}] ${message}\n`);
		} catch (error) { /* o log nunca pode atrapalhar */ }
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	refreshRibbonIcon() {
		const titulo = `${this.nome()}: gravar áudio e plotar no desenho`;
		const desenho = this.settings.ribbonIconName || "mic";
		// Um ícone pode ter sobrado de uma instância anterior (ou de uma versão com
		// outro nome): se o rótulo não bate, ele é refeito em vez de reaproveitado.
		if (this.ribbonIcon && this.ribbonIcon.getAttribute("aria-label") !== titulo) {
			this.ribbonIcon.remove();
			this.ribbonIcon = null;
		}
		if (this.settings.showRibbonIcon && !this.ribbonIcon) {
			this.ribbonIcon = this.addRibbonIcon(desenho, titulo, () => this.toggleRecording());
		} else if (!this.settings.showRibbonIcon && this.ribbonIcon) {
			this.ribbonIcon.remove();
			this.ribbonIcon = null;
		}
	}

	folderPath() {
		return normalizePath(this.settings.folder || DEFAULT_SETTINGS.folder).replace(/\/+$/, "");
	}

	// O nome sai do manifest: a principal e a cópia aparecem com nomes distintos no
	// ícone da barra lateral e nas mensagens.
	nome() {
		return (this.manifest && this.manifest.name) || "Voice_Comment_2.0";
	}

	aviso(texto) {
		new Notice(String(texto).replace(/^AudioHtmlEmbed\b/, this.nome()));
	}

	serviceBase() {
		return `http://127.0.0.1:${this.effectivePort || this.settings.port}`;
	}

	tick() {
		if (!this.recorder.active) return;
		const elapsed = this.recorder.elapsedMs();
		this.panel.setTime(elapsed);
		this.statusBar.setText(`🔴 ${formatDuration(elapsed)}`);
		this.panel.pushLevel(this.recorder.readLevel());
	}

	targetDrawingView() {
		const leaf = this.app.workspace.activeLeaf;
		if (!leaf || !leaf.view || typeof leaf.view.getViewType !== "function") return null;
		return leaf.view.getViewType() === "excalidraw" ? leaf.view : null;
	}

	/* ---- servidor local ---------------------------------------------------- */

	startServer() {
		const folder = this.folderPath();
		this.server = http.createServer((request, response) => {
			try {
				const url = decodeURIComponent((request.url || "/").split("?")[0]);
				const name = path.basename(url);
				const extension = path.extname(name).toLowerCase();
				const full = path.join(this.app.vault.adapter.getBasePath(), folder, name);
				const inside = path.resolve(full).startsWith(path.resolve(this.app.vault.adapter.getBasePath(), folder));
				if (request.method !== "GET" && request.method !== "HEAD") {
					response.writeHead(405).end("method not allowed");
					this.log(`servidor: ${request.method} ${url} -> 405`);
					return;
				}
				if (!inside || !MIME_BY_EXTENSION[extension] || !fs.existsSync(full)) {
					response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("não encontrado");
					this.log(`servidor: GET ${url} -> 404`);
					return;
				}
				const bytes = fs.readFileSync(full);
				response.writeHead(200, {
					"Content-Type": MIME_BY_EXTENSION[extension],
					"Content-Length": bytes.length,
					"Cache-Control": "no-store",
				});
				if (request.method === "HEAD") response.end();
				else response.end(bytes);
				this.log(`servidor: GET ${url} -> 200 (${bytes.length}B)`);
			} catch (error) {
				response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("erro");
				this.log("servidor: erro -> " + (error && error.message ? error.message : error));
			}
		});

		// Porta ocupada não pode derrubar o plugin: tenta as seguintes e avisa.
		const base = Number(this.settings.port) || DEFAULT_SETTINGS.port;
		let attempt = 0;
		const tentar = () => {
			const porta = base + attempt;
			this.server.once("error", (error) => {
				if (error && error.code === "EADDRINUSE" && attempt < 10) {
					attempt++;
					this.log(`porta ${porta} ocupada, tentando ${base + attempt}`);
					tentar();
					return;
				}
				this.log("servidor: falhou -> " + (error && error.message ? error.message : error));
				this.aviso("AudioHtmlEmbed: não consegui subir o servidor local (veja o log).");
			});
			this.server.listen(porta, "127.0.0.1", () => {
				this.effectivePort = porta;
				this.log(`servidor no ar em 127.0.0.1:${porta}, servindo "${folder}"`);
				if (porta !== base) this.aviso(`AudioHtmlEmbed: a porta ${base} estava ocupada — usando ${porta}. Retângulos antigos podem não carregar.`);
			});
		};
		tentar();
	}

	stopServer() {
		if (!this.server) return;
		try {
			this.server.close();
		} catch (error) { /* noop */ }
		this.server = null;
		this.effectivePort = null;
	}

	/* ---- gravação ---------------------------------------------------------- */

	async toggleRecording() {
		try {
			if (this.recorder.active) await this.stopAndPlot();
			else await this.startRecording();
		} catch (error) {
			this.log("erro no toggle: " + (error && error.stack ? error.stack : error));
			this.aviso("AudioHtmlEmbed: erro inesperado (veja o log do plugin).");
		}
	}

	async startRecording() {
		if (this.recorder.active) return;
		if (!this.targetDrawingView()) {
			this.aviso("AudioHtmlEmbed: abra um desenho do Excalidraw para gravar e plotar.");
			return;
		}
		if (typeof lamejs === "undefined" || typeof lamejs.Mp3Encoder !== "function") {
			this.aviso("AudioHtmlEmbed: codificador MP3 ausente (o lamejs não entrou no main.js).");
			return;
		}
		try {
			await this.recorder.start(this.settings.bitrate);
		} catch (error) {
			this.log("microfone: " + (error && error.stack ? error.stack : error));
			const denied = error && error.name === "NotAllowedError";
			this.aviso(denied
				? "AudioHtmlEmbed: permissão de microfone negada. Libere o microfone para o Obsidian."
				: "AudioHtmlEmbed: não consegui acessar o microfone.");
			return;
		}
		this.panel.show(`${this.nome()}: gravando… (o retângulo entra no desenho ao parar)`);
		this.statusBar.setText("🔴 00:00");
		this.tick();
	}

	discardRecording() {
		if (this.recorder.active) {
			this.recorder.discard();
		}
		this.panel.hide();
		this.statusBar.setText("");
		this.aviso("AudioHtmlEmbed: gravação descartada.");
	}

	async stopAndPlot() {
		if (!this.recorder.active) return;
		let result = null;
		try {
			result = await this.recorder.stop();
		} catch (error) {
			this.log("erro ao parar: " + (error && error.stack ? error.stack : error));
		}
		this.panel.hide();
		this.statusBar.setText("");
		if (!result) {
			this.aviso("AudioHtmlEmbed: nada foi gravado (veja o log do plugin).");
			return;
		}
		try {
			const saved = await this.saveRecording(result.data);
			this.log(`gravado: ${saved.mp3.path} + ${saved.html.path} (${result.data.byteLength}B, ${result.durationMs}ms, via ${result.source})`);
			await this.plotPage(saved);
		} catch (error) {
			this.log("erro ao salvar/plotar: " + (error && error.stack ? error.stack : error));
			this.aviso("AudioHtmlEmbed: não consegui salvar ou plotar a gravação.");
		}
	}

	async ensureFolder(folder) {
		const parts = normalizePath(folder).split("/").filter(Boolean);
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				try {
					await this.app.vault.createFolder(current);
				} catch (error) { /* pode ter sido criada em paralelo */ }
			}
		}
	}

	// Grava o MP3 e, ao lado, a página com o áudio embutido.
	async saveRecording(bytes) {
		const folder = this.folderPath();
		await this.ensureFolder(folder);
		const base = safeFileName(`VoiceComment ${stamp()}`);
		let mp3Path = normalizePath(`${folder}/${base}.mp3`);
		let suffix = 2;
		while (this.app.vault.getAbstractFileByPath(mp3Path)) {
			mp3Path = normalizePath(`${folder}/${base} (${suffix}).mp3`);
			suffix++;
		}
		const name = mp3Path.split("/").pop();
		const htmlPath = normalizePath(`${folder}/${name.replace(/\.mp3$/i, ".html")}`);
		const page = buildRectanglePage(name, "audio/mpeg", bytesToBase64(bytes), bytes.length);

		const mp3 = await this.app.vault.createBinary(mp3Path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
		const html = await this.app.vault.create(htmlPath, page);
		return { mp3, html, base };
	}

	/* ---- plotar no desenho ------------------------------------------------- */

	// O elemento é um "embeddable" apontando para http://127.0.0.1:<porta>/<html>.
	// O Excalidraw manda qualquer link com protocolo para um webview, e o próprio
	// plugin o configura com autoplayPolicy=document-user-activation-required —
	// ou seja, o áudio só toca se o usuário clicar.
	async plotPage(saved, view) {
		const alvo = view || this.targetDrawingView();
		if (!alvo) {
			this.aviso("AudioHtmlEmbed: abra o desenho para plotar o retângulo.");
			return false;
		}
		const automate = window.ExcalidrawAutomate;
		if (!automate || typeof automate.getAPI !== "function") {
			this.aviso("AudioHtmlEmbed: o plugin do Excalidraw não está disponível.");
			return false;
		}
		let ea = null;
		try {
			ea = automate.getAPI(alvo);
		} catch (error) {
			this.log("sem API do desenho: " + (error && error.message ? error.message : error));
		}
		if (!ea) return false;

		const width = Number(this.settings.rectWidth) || DEFAULT_SETTINGS.rectWidth;
		const height = Number(this.settings.rectHeight) || DEFAULT_SETTINGS.rectHeight;
		const url = `${this.serviceBase()}/${encodeURIComponent(saved.html.name)}`;
		try {
			if (typeof ea.setStyle === "function") {
				// A página não pinta fundo: a cor que aparece é a do elemento, escolhida
				// aqui (padrão para os novos) ou no painel do Excalidraw, retângulo a
				// retângulo. "transparent" mantém o visual antigo.
				ea.setStyle({
					strokeColor: this.settings.rectStrokeColor || "transparent",
					backgroundColor: this.settings.rectBackgroundColor || "transparent",
				});
			}
			let point = null;
			if (typeof ea.getViewCenterPosition === "function") {
				try {
					point = ea.getViewCenterPosition();
				} catch (error) {
					point = null;
				}
			}
			const x = point ? point.x - width / 2 : 0;
			const y = point ? point.y - height / 2 : 0;
			const id = ea.addEmbeddable(x, y, width, height, url, undefined, undefined);
			const saved_ = await ea.addElementsToView(false, true, true);
			if (saved_ === false) return false;

			const api = (typeof ea.getExcalidrawAPI === "function" ? ea.getExcalidrawAPI() : null) || alvo.excalidrawAPI;
			const element = id && typeof ea.getViewElements === "function" ? ea.getViewElements().find((item) => item.id === id) : null;
			if (api && element) {
				try {
					if (typeof api.selectElements === "function") api.selectElements([element]);
					api.updateScene({
						appState: { activeEmbeddable: { element, state: "active" } },
						captureUpdate: "NEVER",
					});
				} catch (error) { /* o elemento já está no desenho */ }
			}
			this.lastPage = saved;
			this.aviso(`AudioHtmlEmbed: retângulo plotado (${saved.html.name}).`);
			this.log(`plotado: ${url}`);
			return true;
		} catch (error) {
			this.log("erro ao plotar: " + (error && error.stack ? error.stack : error));
			this.aviso("AudioHtmlEmbed: não consegui plotar o retângulo.");
			return false;
		} finally {
			if (typeof ea.destroy === "function") ea.destroy();
		}
	}
}

// ---- configurações ---------------------------------------------------------

class AudioHtmlEmbedSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// O seletor de cor do Obsidian só aceita hex; o padrão "transparent" não é hex,
	// então o seletor mostra um tom de referência sem esconder o valor guardado
	// (que continua transparente até você escolher uma cor).
	corValida(valor, referencia) {
		return /^#[0-9a-fA-F]{6}$/.test(String(valor || "")) ? valor : referencia;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Gravação").setHeading();

		new Setting(containerEl)
			.setName("Pasta dos áudios")
			.setDesc("Onde ficam o MP3 e a página HTML. É esta pasta que o servidor local serve.")
			.addText((text) => text
				.setPlaceholder(DEFAULT_SETTINGS.folder)
				.setValue(this.plugin.settings.folder)
				.onChange(async (value) => {
					this.plugin.settings.folder = value.trim() || DEFAULT_SETTINGS.folder;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Qualidade do MP3")
			.setDesc("Mono. 128 kb/s é folgado para voz.")
			.addDropdown((dropdown) => dropdown
				.addOptions({ "64": "64 kb/s", "96": "96 kb/s", "128": "128 kb/s", "192": "192 kb/s" })
				.setValue(String(this.plugin.settings.bitrate))
				.onChange(async (value) => {
					this.plugin.settings.bitrate = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl).setName("Retângulo no desenho").setHeading();

		new Setting(containerEl)
			.setName("Largura")
			.addText((text) => text
				.setValue(String(this.plugin.settings.rectWidth))
				.onChange(async (value) => {
					const n = Number(value);
					if (Number.isFinite(n) && n > 80) {
						this.plugin.settings.rectWidth = n;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName("Altura")
			.addText((text) => text
				.setValue(String(this.plugin.settings.rectHeight))
				.onChange(async (value) => {
					const n = Number(value);
					if (Number.isFinite(n) && n > 60) {
						this.plugin.settings.rectHeight = n;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName("Cor de fundo do retângulo")
			.setDesc("A página não pinta fundo: esta é a cor padrão dos retângulos novos (dá para mudar cada um depois, no painel do Excalidraw). O texto do player se adapta com sombra.")
			.addColorPicker((picker) => picker
				.setValue(this.corValida(this.plugin.settings.rectBackgroundColor, "#e8e8ef"))
				.onChange(async (value) => {
					this.plugin.settings.rectBackgroundColor = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Cor da borda do retângulo")
			.addColorPicker((picker) => picker
				.setValue(this.corValida(this.plugin.settings.rectStrokeColor, "#4b4bd6"))
				.onChange(async (value) => {
					this.plugin.settings.rectStrokeColor = value;
					await this.plugin.saveSettings();
				}))
			.addButton((button) => button
				.setButtonText("Sem cor (transparente)")
				.onClick(async () => {
					this.plugin.settings.rectBackgroundColor = "transparent";
					this.plugin.settings.rectStrokeColor = "transparent";
					await this.plugin.saveSettings();
					this.display();
				}));

		new Setting(containerEl).setName("Servidor local").setHeading();

		new Setting(containerEl)
			.setName("Porta")
			.setDesc(`Hoje: ${this.plugin.serviceBase()}. Só esta máquina acessa (127.0.0.1). Trocar a porta quebra os retângulos já plotados.`)
			.addText((text) => text
				.setValue(String(this.plugin.settings.port))
				.onChange(async (value) => {
					const n = Number(value);
					if (Number.isInteger(n) && n > 1023 && n < 65536) {
						this.plugin.settings.port = n;
						await this.plugin.saveSettings();
					}
				}))
			.addButton((button) => button
				.setButtonText("Reiniciar servidor")
				.onClick(() => {
					this.plugin.stopServer();
					this.plugin.startServer();
					this.plugin.aviso("AudioHtmlEmbed: servidor reiniciado.");
				}));

		new Setting(containerEl)
			.setName("Ícone de microfone na barra lateral")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.showRibbonIcon)
				.onChange(async (value) => {
					this.plugin.settings.showRibbonIcon = value;
					await this.plugin.saveSettings();
					this.plugin.refreshRibbonIcon();
				}))
			.addText((text) => text
				.setPlaceholder("mic")
				.setValue(this.plugin.settings.ribbonIconName || "mic")
				.onChange(async (value) => {
					this.plugin.settings.ribbonIconName = value.trim() || "mic";
					await this.plugin.saveSettings();
					this.plugin.refreshRibbonIcon();
				}));
	}
}

module.exports = AudioHtmlEmbedPlugin;
