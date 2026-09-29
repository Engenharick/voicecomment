/*
 * VoiceComment — record a voice note and drop the MP3 player right where you
 * started recording: in a Markdown note, or inside an Excalidraw drawing.
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
 * Bundles lamejs (LGPL-3.0) unmodified — see THIRD-PARTY-NOTICES.md.
 *
 * This file is concatenated AFTER lame.min.js (which declares the `lamejs`
 * identifier in the module scope) to produce the distributed main.js.
 * See build.ps1.
 *
 * Audio is captured through two parallel paths:
 *   1) PCM via WebAudio -> lamejs   (single lossy step, best quality)
 *   2) MediaRecorder                (same path as Obsidian's built-in recorder;
 *      if WebAudio does not deliver samples, the compressed capture is decoded
 *      and re-encoded, so a recording is never lost)
 */
const obsidian = require("obsidian");
const { Plugin, PluginSettingTab, Setting, Notice, MarkdownView, normalizePath, setIcon } = obsidian;

const DEFAULT_SETTINGS = {
	folder: "VoiceComment",
	prefix: "VoiceComment",
	bitrate: 128,
	insertPosition: "cursor",
	showRibbonIcon: true,
};

// A zero-sample WAV: only used so an offscreen <audio controls> has a height.
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
const EMBED_WIDTH = 500;
const LOG_PATH = ".obsidian/plugins/voicecomment/voicecomment.log";
const LOG_MAX_BYTES = 120000;
const PCM_MIN_BYTES = 2000;
const PCM_MIN_PEAK = 0.0005;

function formatDuration(ms) {
	const total = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function timestamp() {
	const momentApi = obsidian.moment || window.moment;
	if (momentApi) return momentApi().format("YYYY-MM-DD HH.mm.ss");
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
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

class VoiceRecorder {
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
		this.bitrate = DEFAULT_SETTINGS.bitrate;
		this.pcmPeak = 0;
		this.paused = false;
		this.startedAt = 0;
		this.pausedAt = 0;
		this.pausedTotal = 0;
	}

	get active() {
		return this.ctx !== null || this.mediaRecorder !== null;
	}

	elapsedMs() {
		if (!this.startedAt) return 0;
		const reference = this.paused ? this.pausedAt : performance.now();
		return Math.max(0, reference - this.startedAt - this.pausedTotal);
	}

	pickMimeType() {
		if (typeof MediaRecorder === "undefined") return "";
		const candidates = ["audio/mp4", 'audio/webm;codecs="opus"', "audio/webm", "audio/ogg"];
		for (const candidate of candidates) {
			if (MediaRecorder.isTypeSupported(candidate)) return candidate;
		}
		return "";
	}

	async start(bitrate) {
		this.bitrate = bitrate;
		this.stream = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
		});

		// Path 2 (safety net): MediaRecorder, the same capture the built-in recorder uses.
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
			this.log("MediaRecorder unavailable: " + (error && error.message ? error.message : error));
		}

		// Path 1 (preferred): raw PCM straight into lamejs.
		let ctx;
		try {
			ctx = new AudioContext({ sampleRate: 44100 });
		} catch (error) {
			ctx = new AudioContext();
		}
		this.ctx = ctx;
		// A context created without user activation starts suspended: the graph
		// never runs and onaudioprocess never fires. Resuming is not optional.
		if (ctx.state === "suspended") {
			try {
				await ctx.resume();
			} catch (error) {
				this.log("ctx.resume() failed: " + (error && error.message ? error.message : error));
			}
		}
		this.log(`capture: AudioContext=${ctx.state} sampleRate=${ctx.sampleRate}Hz mime=${this.mimeType || "(default)"} kbps=${bitrate}`);

		this.source = ctx.createMediaStreamSource(this.stream);
		this.analyser = ctx.createAnalyser();
		this.analyser.fftSize = 1024;
		this.spectrum = new Float32Array(this.analyser.fftSize);
		this.source.connect(this.analyser);

		// ScriptProcessor remains the most portable option in Obsidian's Chromium.
		this.processor = ctx.createScriptProcessor(4096, 1, 1);
		this.analyser.connect(this.processor);
		// It only fires when the chain reaches the destination; a zero gain node
		// avoids feedback through the speakers.
		this.sink = ctx.createGain();
		this.sink.gain.value = 0;
		this.processor.connect(this.sink);
		this.sink.connect(ctx.destination);

		this.encoder = new lamejs.Mp3Encoder(1, ctx.sampleRate, bitrate);
		this.chunks = [];
		this.pcmPeak = 0;

		this.processor.onaudioprocess = (event) => {
			if (this.paused || !this.encoder) return;
			const { pcm, peak } = floatToPcm(event.inputBuffer.getChannelData(0));
			if (peak > this.pcmPeak) this.pcmPeak = peak;
			const encoded = this.encoder.encodeBuffer(pcm);
			if (encoded.length > 0) this.chunks.push(new Uint8Array(encoded));
		};

		this.startedAt = performance.now();
		this.pausedAt = 0;
		this.pausedTotal = 0;
		this.paused = false;
	}

	readLevel() {
		if (!this.analyser || !this.spectrum) return 0;
		this.analyser.getFloatTimeDomainData(this.spectrum);
		let sum = 0;
		for (let i = 0; i < this.spectrum.length; i++) sum += this.spectrum[i] * this.spectrum[i];
		return Math.min(1, Math.sqrt(sum / this.spectrum.length) * 4);
	}

	pause() {
		if (this.paused) return;
		if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
			try { this.mediaRecorder.pause(); } catch (error) { /* noop */ }
		}
		this.paused = true;
		this.pausedAt = performance.now();
	}

	resume() {
		if (!this.paused) return;
		if (this.mediaRecorder && this.mediaRecorder.state === "paused") {
			try { this.mediaRecorder.resume(); } catch (error) { /* noop */ }
		}
		this.pausedTotal += performance.now() - this.pausedAt;
		this.pausedAt = 0;
		this.paused = false;
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
				this.log("PCM flush failed: " + (error && error.message ? error.message : error));
			}
		}

		const blob = await this.stopMediaRecorder();
		const pcmBytes = pcm ? pcm.byteLength : 0;
		const mediaBytes = blob ? blob.size : 0;
		const peak = this.pcmPeak;
		this.teardown();
		this.log(`stop: ${Math.round(durationMs)}ms pcm=${pcmBytes}B peak=${peak.toFixed(4)} media=${mediaBytes}B`);

		if (pcmBytes > PCM_MIN_BYTES && peak > PCM_MIN_PEAK) {
			return { data: pcm, durationMs, source: "pcm" };
		}
		if (blob) {
			try {
				const converted = await this.encodeBlob(blob, bitrate);
				this.log(`converted from MediaRecorder: ${converted.byteLength}B`);
				if (converted.byteLength > PCM_MIN_BYTES) return { data: converted, durationMs, source: "media" };
			} catch (error) {
				this.log("MediaRecorder conversion failed: " + (error && error.message ? error.message : error));
			}
		}
		if (pcmBytes > 0) return { data: pcm, durationMs, source: "pcm-silent" };
		return null;
	}

	// Decodes the MediaRecorder capture and re-encodes it as MP3. Used when the
	// PCM path produced no audio (e.g. a suspended AudioContext).
	async encodeBlob(blob, bitrate) {
		const arrayBuffer = await blob.arrayBuffer();
		const decodeCtx = new OfflineAudioContext(1, 1, 44100);
		const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
		const samples = audioBuffer.getChannelData(0);
		const encoder = new lamejs.Mp3Encoder(1, audioBuffer.sampleRate, bitrate || DEFAULT_SETTINGS.bitrate);
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

class RecorderPanel {
	constructor(handlers) {
		this.handlers = handlers;
		this.levels = [];

		this.el = document.body.createDiv({ cls: "voicecomment-panel is-hidden" });

		const target = this.el.createDiv({ cls: "voicecomment-target" });
		target.createSpan({ cls: "voicecomment-target-label", text: "Recording into" });
		this.targetName = target.createSpan({ cls: "voicecomment-target-name", text: "" });

		this.canvas = this.el.createEl("canvas", { cls: "voicecomment-meter", attr: { width: 240, height: 44 } });
		this.meter = this.canvas.getContext("2d");

		this.timeEl = this.el.createDiv({ cls: "voicecomment-time", text: "00:00" });

		const controls = this.el.createDiv({ cls: "voicecomment-controls" });
		this.pauseBtn = this.button(controls, "pause", "Pause", () => this.handlers.onPauseToggle());
		this.stopBtn = this.button(controls, "square", "Stop and save", () => this.handlers.onStop());
		this.stopBtn.addClass("mod-record");
		this.discardBtn = this.button(controls, "trash-2", "Discard recording", () => this.handlers.onDiscard());
	}

	button(parent, icon, label, onClick) {
		const el = parent.createEl("button", { cls: "voicecomment-control" });
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
		this.el.removeClass("is-paused");
		setIcon(this.pauseBtn, "pause");
		this.renderMeter();
	}

	hide() {
		this.el.addClass("is-hidden");
	}

	setTime(ms) {
		this.timeEl.setText(formatDuration(ms));
	}

	setPaused(paused) {
		this.el.toggleClass("is-paused", paused);
		setIcon(this.pauseBtn, paused ? "play" : "pause");
	}

	pushLevel(level) {
		this.levels.push(level);
		if (this.levels.length > 64) this.levels.splice(0, this.levels.length - 64);
		this.renderMeter();
	}

	renderMeter() {
		const canvas = this.canvas;
		const ctx = this.meter;
		const style = getComputedStyle(document.body);
		const background = style.getPropertyValue("--background-secondary") || "#222";
		const accent = style.getPropertyValue("--interactive-accent") || "#888";

		ctx.fillStyle = background;
		ctx.fillRect(0, 0, canvas.width, canvas.height);

		const barWidth = 4;
		const gap = 2;
		const capacity = Math.floor(canvas.width / (barWidth + gap));
		const levels = this.levels.slice(-capacity);
		levels.forEach((level, index) => {
			const height = Math.max(3, level * (canvas.height - 8));
			const x = canvas.width - (levels.length - index) * (barWidth + gap);
			ctx.fillStyle = accent;
			ctx.fillRect(x, (canvas.height - height) / 2, barWidth, height);
		});
	}

	destroy() {
		this.el.remove();
	}
}

class VoiceCommentSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("File").setHeading();

		new Setting(containerEl)
			.setName("Recordings folder")
			.setDesc("Created automatically if it doesn't exist.")
			.addText((text) => text
				.setPlaceholder("VoiceComment")
				.setValue(this.plugin.settings.folder)
				.onChange(async (value) => {
					this.plugin.settings.folder = value.trim() || DEFAULT_SETTINGS.folder;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("File name prefix")
			.setDesc("The date and time are appended to it, for example: VoiceComment 2026-09-25 18.20.33.mp3")
			.addText((text) => text
				.setPlaceholder("VoiceComment")
				.setValue(this.plugin.settings.prefix)
				.onChange(async (value) => {
					this.plugin.settings.prefix = value.trim() || DEFAULT_SETTINGS.prefix;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("MP3 quality")
			.setDesc("Mono. 128 kb/s is plenty for voice.")
			.addDropdown((dropdown) => dropdown
				.addOptions({ "64": "64 kb/s", "96": "96 kb/s", "128": "128 kb/s", "192": "192 kb/s" })
				.setValue(String(this.plugin.settings.bitrate))
				.onChange(async (value) => {
					this.plugin.settings.bitrate = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl).setName("Insertion").setHeading();

		new Setting(containerEl)
			.setName("Insert the recording")
			.setDesc("At the cursor when the note is in edit mode; at the end of the note otherwise.")
			.addDropdown((dropdown) => dropdown
				.addOption("cursor", "At the cursor position")
				.addOption("end", "At the end of the note")
				.setValue(this.plugin.settings.insertPosition)
				.onChange(async (value) => {
					this.plugin.settings.insertPosition = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl).setName("Interface").setHeading();

		new Setting(containerEl)
			.setName("Microphone icon in the sidebar")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.showRibbonIcon)
				.onChange(async (value) => {
					this.plugin.settings.showRibbonIcon = value;
					await this.plugin.saveSettings();
					this.plugin.refreshRibbonIcon();
				}));

		new Setting(containerEl)
			.setName("Diagnostic log")
			.setDesc(LOG_PATH)
			.addButton((button) => button
				.setButtonText("Open")
				.onClick(() => this.plugin.openLog()));
	}
}

class VoiceCommentPlugin extends Plugin {
	async onload() {
		await this.loadSettings();

		this.recorder = new VoiceRecorder((message) => this.log(message));
		this.panel = new RecorderPanel({
			onPauseToggle: () => this.togglePause(),
			onStop: () => this.stopRecording(true),
			onDiscard: () => this.stopRecording(false),
		});
		this.targetFile = null;
		this.ribbonIcon = null;

		this.statusBar = this.addStatusBarItem();
		this.statusBar.addClass("voicecomment-statusbar");

		this.addSettingTab(new VoiceCommentSettingTab(this.app, this));
		this.refreshRibbonIcon();

		this.addCommand({
			id: "start-stop-recording",
			name: "Start/stop recording",
			callback: () => this.toggleRecording(),
		});
		this.addCommand({
			id: "start-recording",
			name: "Start recording",
			checkCallback: (checking) => {
				if (this.recorder.active) return false;
				if (!checking) this.startRecording();
				return true;
			},
		});
		this.addCommand({
			id: "pause-resume-recording",
			name: "Pause/resume recording",
			checkCallback: (checking) => {
				if (!this.recorder.active) return false;
				if (!checking) this.togglePause();
				return true;
			},
		});
		this.addCommand({
			id: "stop-save-recording",
			name: "Stop and save recording",
			checkCallback: (checking) => {
				if (!this.recorder.active) return false;
				if (!checking) this.stopRecording(true);
				return true;
			},
		});
		this.addCommand({
			id: "discard-recording",
			name: "Discard recording",
			checkCallback: (checking) => {
				if (!this.recorder.active) return false;
				if (!checking) this.stopRecording(false);
				return true;
			},
		});
		this.addCommand({
			id: "activate-latest-player",
			name: "Activate the latest player in the drawing",
			checkCallback: (checking) => {
				const leaf = this.app.workspace.activeLeaf;
				const inDrawing = !!(leaf && leaf.view && typeof leaf.view.getViewType === "function"
					&& leaf.view.getViewType() === "excalidraw");
				if (!inDrawing) return false;
				if (!checking) this.activateLatestPlayer();
				return true;
			},
		});

		// Excalidraw renders an embeddable only while it is the active one, and that
		// state is not restored when a drawing is reopened — the player falls back to
		// a placeholder until it is clicked. Re-activate the newest player whenever a
		// drawing becomes the active view.
		this.playerTimer = null;
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.schedulePlayerActivation()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.schedulePlayerActivation()));
		this.schedulePlayerActivation();

		this.registerInterval(window.setInterval(() => this.tick(), 60));
		this.log("plugin loaded");
	}

	onunload() {
		if (this.playerTimer) window.clearTimeout(this.playerTimer);
		this.playerTimer = null;
		this.recorder.discard();
		this.panel.destroy();
		this.statusBar.setText("");
	}

	async log(message) {
		await this.appendLog(`[${timestamp()}] ${message}`);
	}

	// Only real failures reach the developer console; routine entries stay in the file.
	async logError(message, error) {
		const detail = error && error.stack ? error.stack : error;
		console.error(`VoiceComment: ${message}`, detail === undefined ? "" : detail);
		await this.appendLog(`[${timestamp()}] ${message} ${detail === undefined ? "" : detail}`);
	}

	async appendLog(line) {
		try {
			const adapter = this.app.vault.adapter;
			let info = null;
			try {
				info = await adapter.stat(LOG_PATH);
			} catch (error) {
				info = null;
			}
			if (info && info.size > LOG_MAX_BYTES) await adapter.write(LOG_PATH, "");
			await adapter.append(LOG_PATH, `${line}\n`);
		} catch (error) { /* the log must never get in the way of the plugin */ }
	}

	async openLog() {
		try {
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(LOG_PATH))) {
				new Notice("VoiceComment: no log yet.");
				return;
			}
			// The vault index does not see .obsidian, so the file is opened through
			// the OS instead of the workspace.
			require("electron").shell.openPath(adapter.getFullPath(LOG_PATH));
		} catch (error) {
			new Notice(`VoiceComment: log at ${LOG_PATH}`);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	refreshRibbonIcon() {
		if (this.settings.showRibbonIcon && !this.ribbonIcon) {
			this.ribbonIcon = this.addRibbonIcon("mic", "VoiceComment: start/stop recording", () => this.toggleRecording());
		} else if (!this.settings.showRibbonIcon && this.ribbonIcon) {
			this.ribbonIcon.remove();
			this.ribbonIcon = null;
		}
	}

	tick() {
		if (!this.recorder.active) return;
		const elapsed = this.recorder.elapsedMs();
		this.panel.setTime(elapsed);
		this.statusBar.setText(`${this.recorder.paused ? "⏸" : "🔴"} ${formatDuration(elapsed)}`);
		if (!this.recorder.paused) this.panel.pushLevel(this.recorder.readLevel());
	}

	getTargetNote() {
		const file = this.app.workspace.getActiveFile();
		if (file && file.extension === "md") return file;
		return null;
	}

	async toggleRecording() {
		try {
			if (this.recorder.active) await this.stopRecording(true);
			else await this.startRecording();
		} catch (error) {
			await this.logError("error in toggleRecording: " + (error && error.stack ? error.stack : error));
			new Notice(`VoiceComment: unexpected error (see ${LOG_PATH}).`);
		}
	}

	async startRecording() {
		if (this.recorder.active) return;
		if (typeof lamejs === "undefined" || typeof lamejs.Mp3Encoder !== "function") {
			new Notice("VoiceComment: MP3 encoder missing (lamejs was not bundled into main.js).");
			return;
		}
		const target = this.getTargetNote();
		if (!target) {
			new Notice("VoiceComment: open a note or a drawing to record into.");
			return;
		}
		try {
			await this.recorder.start(this.settings.bitrate);
		} catch (error) {
			await this.logError("microphone failure: " + (error && error.stack ? error.stack : error));
			if (error && error.name === "NotAllowedError") {
				new Notice("VoiceComment: microphone permission denied. Allow microphone access for Obsidian.");
			} else if (error && error.name === "NotFoundError") {
				new Notice("VoiceComment: no microphone found.");
			} else {
				new Notice("VoiceComment: could not access the microphone.");
			}
			return;
		}
		this.targetFile = target;
		this.panel.show(target.name);
		this.statusBar.setText("🔴 00:00");
		this.tick();
	}

	togglePause() {
		if (!this.recorder.active) return;
		if (this.recorder.paused) this.recorder.resume();
		else this.recorder.pause();
		this.panel.setPaused(this.recorder.paused);
		this.tick();
	}

	async stopRecording(save) {
		if (!this.recorder.active) return;
		const target = this.targetFile;
		let result = null;
		try {
			result = save ? await this.recorder.stop() : (this.recorder.discard(), null);
		} catch (error) {
			await this.logError("error stopping the recording: " + (error && error.stack ? error.stack : error));
		}
		this.panel.hide();
		this.statusBar.setText("");
		this.targetFile = null;

		if (!save) {
			new Notice("VoiceComment: recording discarded.");
			return;
		}
		if (!result) {
			new Notice("VoiceComment: nothing was recorded. See " + LOG_PATH);
			return;
		}
		try {
			const file = await this.saveMp3(result.data);
			const destination = await this.insertEmbed(file, target);
			await this.log(`saved: ${file.path} (${result.data.byteLength}B via ${result.source}) ${destination}`);
			new Notice(`VoiceComment: ${file.name} (${formatDuration(result.durationMs)}) ${destination}`);
		} catch (error) {
			await this.logError("error saving/inserting: " + (error && error.stack ? error.stack : error));
			new Notice("VoiceComment: could not save the recording.");
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
				} catch (error) { /* it may have been created in parallel */ }
			}
		}
	}

	async saveMp3(data) {
		const folder = normalizePath(this.settings.folder || DEFAULT_SETTINGS.folder);
		await this.ensureFolder(folder);
		const base = `${this.settings.prefix || DEFAULT_SETTINGS.prefix} ${timestamp()}`;
		let path = normalizePath(`${folder}/${base}.mp3`);
		let suffix = 2;
		while (this.app.vault.getAbstractFileByPath(path)) {
			path = normalizePath(`${folder}/${base} (${suffix}).mp3`);
			suffix++;
		}
		const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
		return await this.app.vault.createBinary(path, buffer);
	}

	measureAudioPlayerHeight() {
		try {
			const probe = document.body.createEl("audio", { cls: "voicecomment-probe" });
			probe.controls = true;
			probe.src = SILENT_WAV;
			const height = probe.offsetHeight;
			probe.remove();
			return height > 0 ? height : 54;
		} catch (error) {
			return 54;
		}
	}

	schedulePlayerActivation(delay = 800) {
		if (this.playerTimer) window.clearTimeout(this.playerTimer);
		this.playerTimer = window.setTimeout(() => {
			this.playerTimer = null;
			this.activateLatestPlayer();
		}, delay);
	}

	// Excalidraw keeps a single active embeddable (appState.activeEmbeddable), so
	// only one player can render at a time: the newest one wins. Returns 1 when a
	// player was activated, 0 when there was nothing to do.
	async activateLatestPlayer() {
		const leaf = this.app.workspace.activeLeaf;
		if (!leaf || !leaf.view || typeof leaf.view.getViewType !== "function") return 0;
		if (leaf.view.getViewType() !== "excalidraw") return 0;
		const automate = window.ExcalidrawAutomate;
		if (!automate || typeof automate.getAPI !== "function") return 0;

		let ea = null;
		try {
			ea = automate.getAPI(leaf.view);
		} catch (error) {
			return 0;
		}
		if (!ea) return 0;

		try {
			const prefix = `${this.settings.prefix || DEFAULT_SETTINGS.prefix} `;
			const players = (typeof ea.getViewElements === "function" ? ea.getViewElements() : [])
				.filter((item) => item && item.type === "embeddable" && typeof item.link === "string"
					&& /\.mp3\]\]$/i.test(item.link) && item.link.includes(prefix));
			if (!players.length) return 0;

			players.sort((a, b) => (a.link < b.link ? 1 : -1));
			const player = players[0];
			const api = (typeof ea.getExcalidrawAPI === "function" ? ea.getExcalidrawAPI() : null) || leaf.view.excalidrawAPI;
			if (!api || typeof api.updateScene !== "function") return 0;

			// Never fight the user's own selection: select the player only when
			// nothing else is selected.
			const state = typeof api.getAppState === "function" ? api.getAppState() : null;
			const hasSelection = !!(state && state.selectedElementIds && Object.keys(state.selectedElementIds).length > 0);
			if (!hasSelection && typeof api.selectElements === "function") api.selectElements([player]);

			api.updateScene({
				appState: { activeEmbeddable: { element: player, state: "active" } },
				captureUpdate: "NEVER",
			});
			return 1;
		} catch (error) {
			await this.logError("could not re-activate the player in the drawing: " + (error && error.message ? error.message : error));
			return 0;
		} finally {
			if (typeof ea.destroy === "function") ea.destroy();
		}
	}

	// Excalidraw exposes window.ExcalidrawAutomate.getAPI(view), which returns a
	// NEW instance bound to that view — the global instance can be plugin-less
	// (setView then throws "Cannot read properties of null (reading 'app')").
	// An MP3 becomes an "embeddable" element, rendered with Obsidian's audio player.
	async insertIntoExcalidraw(audioFile, noteFile) {
		const automate = window.ExcalidrawAutomate;
		if (!noteFile || !automate || typeof automate.getAPI !== "function") return false;

		const leaf = this.app.workspace.getLeavesOfType("excalidraw")
			.find((candidate) => candidate.view && candidate.view.file && candidate.view.file.path === noteFile.path);
		if (!leaf) return false;

		let ea = null;
		try {
			ea = automate.getAPI(leaf.view);
		} catch (error) {
			await this.logError("could not get the Excalidraw API: " + (error && error.message ? error.message : error));
		}
		if (!ea) return false;

		try {
			if (typeof ea.setStyle === "function") {
				ea.setStyle({ strokeColor: "transparent", backgroundColor: "transparent" });
			}
			const height = this.measureAudioPlayerHeight();
			let center = null;
			if (typeof ea.getViewCenterPosition === "function") {
				try {
					center = ea.getViewCenterPosition();
				} catch (error) {
					center = null;
				}
			}
			if (!center && leaf.view.currentPosition) center = leaf.view.currentPosition;
			const x = center ? center.x - EMBED_WIDTH / 2 : 0;
			const y = center ? center.y - height / 2 : 0;

			const elementId = ea.addEmbeddable(x, y, EMBED_WIDTH, height, `[[${audioFile.path}]]`, undefined);
			const saved = await ea.addElementsToView(false, true, true);
			if (saved === false) return false;

			// Selecting the element and marking it active is what makes the player
			// render instead of staying a placeholder.
			const api = (typeof ea.getExcalidrawAPI === "function" ? ea.getExcalidrawAPI() : null) || leaf.view.excalidrawAPI;
			const element = elementId && typeof ea.getViewElements === "function"
				? ea.getViewElements().find((item) => item.id === elementId)
				: null;
			if (api && element) {
				try {
					if (typeof api.selectElements === "function") api.selectElements([element]);
					api.updateScene({
						appState: { activeEmbeddable: { element, state: "active" } },
						captureUpdate: "NEVER",
					});
				} catch (error) {
					await this.logError("inserted into the drawing, but could not activate the player: " + (error && error.message ? error.message : error));
				}
			}
			return true;
		} catch (error) {
			await this.logError("failed to insert into the drawing: " + (error && error.stack ? error.stack : error));
			return false;
		} finally {
			if (typeof ea.destroy === "function") ea.destroy();
		}
	}

	async insertEmbed(audioFile, noteFile) {
		if (await this.insertIntoExcalidraw(audioFile, noteFile)) return "in the drawing";

		const notePath = noteFile && noteFile.path ? noteFile.path : "";
		const link = this.app.fileManager.generateMarkdownLink(audioFile, notePath || "/");
		const embed = `!${link}`;

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (this.settings.insertPosition === "cursor" && view && view.getMode() === "source") {
			view.editor.replaceSelection(`${embed}\n`);
			return "in the note (cursor)";
		}

		const target = (view && view.file) || noteFile || this.app.workspace.getActiveFile();
		if (target && target.extension === "md") {
			await this.app.vault.process(target, (content) => {
				const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
				return `${content}${separator}${embed}\n`;
			});
			return "in the note (end)";
		}

		return `at ${audioFile.path}`;
	}
}

module.exports = VoiceCommentPlugin;
