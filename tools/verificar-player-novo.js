// Recarrega o plugin, refaz as páginas das gravações e verifica o player novo
// dentro do webview do desenho: tamanho e posição do botão, ausência de autoplay
// e o clique funcionando (com o áudio mudo, para não fazer barulho).
//
//   node tools\verificar-player-novo.js [porta]
const PORT = process.argv[2] || "9333";

let nextId = 1;
function send(ws, method, params) {
	return new Promise((resolve, reject) => {
		const id = nextId++;
		const timer = setTimeout(() => reject(new Error("timeout em " + method)), 60000);
		const onMessage = (event) => {
			const msg = JSON.parse(event.data);
			if (msg.id !== id) return;
			clearTimeout(timer);
			ws.removeEventListener("message", onMessage);
			if (msg.error) reject(new Error(method + ": " + JSON.stringify(msg.error)));
			else resolve(msg.result);
		};
		ws.addEventListener("message", onMessage);
		ws.send(JSON.stringify({ id, method, params }));
	});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function conectar(filtro) {
	const lista = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
	const alvo = lista.find(filtro);
	if (!alvo) throw new Error("alvo não encontrado");
	const ws = new WebSocket(alvo.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.addEventListener("open", resolve, { once: true });
		ws.addEventListener("error", () => reject(new Error("falha no WebSocket")), { once: true });
	});
	const evaluate = async (expression) => {
		const res = await send(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (res.exceptionDetails) throw new Error("excecao: " + JSON.stringify(res.exceptionDetails.exception));
		return res.result ? res.result.value : undefined;
	};
	return { ws, evaluate, alvo };
}

async function main() {
	const out = {};

	// --- 1) o plugin já está com o código novo? (o recarregar é feito à parte,
	// porque o disable/enable por CDP pode não retornar) ---
	const pagina = await conectar((t) => t.type === "page" && t.url.includes("obsidian"));
	out.plugin = await pagina.evaluate(`(() => { const p = app.plugins.plugins['voicecomment']; return JSON.stringify({ ativo: !!p, servidor: p ? p.serviceBase() : null, codigoNovo: p ? typeof p.rebuildPages === 'function' : false }); })()`);
	out.paginas = await pagina.evaluate(`(async () => {
		const htmls = app.vault.getFiles().filter((f) => f.path.startsWith('AudioHTML/') && /\\.html$/.test(f.name));
		let novo = 0;
		for (const h of htmls) {
			const texto = await app.vault.read(h);
			if (texto.includes('id="toggle"')) novo++;
		}
		const log = await app.vault.adapter.read('.obsidian/plugins/voicecomment/voicecomment.log').catch(() => '');
		return JSON.stringify({ htmlsNaPasta: htmls.length, comPlayerNovo: novo, ultimaLinhaRebuild: log.split('\\n').filter((l) => l.includes('refazer páginas')).pop() || null });
	})()`);
	pagina.ws.close();

	// --- 2) verifica dentro do webview do desenho ---
	const webview = await conectar((t) => t.type === "webview" && t.url.includes("127.0.0.1:8781"));
	await send(webview.ws, "Page.enable", {}).catch(() => {});
	await send(webview.ws, "Page.reload", {}).catch(() => {});
	await sleep(2500);

	const estado = await webview.evaluate(`(() => {
		const botao = document.getElementById('toggle');
		const audio = document.getElementById('player');
		if (!botao || !audio) return JSON.stringify({ erro: 'sem botao/audio' });
		const r = botao.getBoundingClientRect();
		const janela = { largura: window.innerWidth, altura: window.innerHeight };
		return JSON.stringify({
			janela,
			botao: { largura: Math.round(r.width), altura: Math.round(r.height), x: Math.round(r.left), centroX: Math.round(r.left + r.width / 2), centroY: Math.round(r.top + r.height / 2) },
			centralizadoX: Math.abs((r.left + r.width / 2) - janela.largura / 2) <= 2,
			audioEscondido: getComputedStyle(audio).display === 'none',
			naTocando: audio.paused,
			tempoAtual: audio.currentTime,
			readyState: audio.readyState,
			autoplay: audio.hasAttribute('autoplay'),
			controls: audio.hasAttribute('controls'),
			toca: Math.round(audio.duration * 10) / 10,
		});
	})()`);
	out.webviewAntes = JSON.parse(estado);

	// clica no botão, com o áudio mudo (o teste não faz barulho)
	const clique = await webview.evaluate(`(async () => {
		const audio = document.getElementById('player');
		audio.muted = true;
		return JSON.stringify({ mudo: audio.muted });
	})()`);
	const alvo = out.webviewAntes.botao;
	await send(webview.ws, "Input.dispatchMouseEvent", { type: "mouseMoved", x: alvo.centroX, y: alvo.centroY, button: "none" });
	await send(webview.ws, "Input.dispatchMouseEvent", { type: "mousePressed", x: alvo.centroX, y: alvo.centroY, button: "left", clickCount: 1 });
	await sleep(60);
	await send(webview.ws, "Input.dispatchMouseEvent", { type: "mouseReleased", x: alvo.centroX, y: alvo.centroY, button: "left", clickCount: 1 });
	await sleep(1200);

	out.webviewDepoisDoClique = JSON.parse(await webview.evaluate(`(() => {
		const botao = document.getElementById('toggle');
		const audio = document.getElementById('player');
		return JSON.stringify({ tocando: !audio.paused, tempoAtual: Math.round(audio.currentTime * 10) / 10, classePlaying: botao.classList.contains('playing'), rotulo: botao.getAttribute('aria-label') });
	})()`));

	// pausa de novo e tira o mudo, para deixar como estava
	await webview.evaluate(`(() => { const audio = document.getElementById('player'); audio.pause(); audio.muted = false; audio.currentTime = 0; return 'ok'; })()`);
	out.webviewFinal = JSON.parse(await webview.evaluate(`(() => { const audio = document.getElementById('player'); return JSON.stringify({ tocando: !audio.paused, tempo: audio.currentTime, mudo: audio.muted }); })()`));
	webview.ws.close();

	console.log(JSON.stringify(out, null, 1));
	const w = out.webviewAntes;
	const d = out.webviewDepoisDoClique;
	const ok = w.botao.largura >= 80 && w.centralizadoX && w.naTocando && !w.autoplay && !w.controls && d.tocando && d.classePlaying;
	console.log(ok
		? "OK: botão grande e centralizado, nada toca sozinho e o clique toca (e o rótulo vira pausar)."
		: "FALHOU: ver os campos acima.");
	process.exit(ok ? 0 : 1);
}

main().catch((error) => {
	console.error("FALHOU: " + error.message);
	process.exit(1);
});
