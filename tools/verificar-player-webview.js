// Verifica o player novo dentro do webview, num desenho de teste criado aqui:
// geometria do botão (grande e centralizado), nada tocando ao carregar, e o
// clique de verdade (com o áudio mudo) disparando a reprodução. No fim apaga o
// desenho e os arquivos do teste.
//
//   node tools\verificar-player-webview.js <porta> "<mp3-de-teste>"
const fs = require("fs");
const PORT = process.argv[2] || "9333";
const MP3 = process.argv[3];
if (!MP3) {
	console.error('uso: node tools\\verificar-player-webview.js <porta> "<mp3>"');
	process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function conectar(alvo) {
	let nextId = 1;
	const ws = new WebSocket(alvo.webSocketDebuggerUrl);
	return new Promise((resolve, reject) => {
		ws.addEventListener("open", () => {
			const enviar = (method, params) => new Promise((res, rej) => {
				const id = nextId++;
				const timer = setTimeout(() => rej(new Error("timeout em " + method)), 90000);
				const onMessage = (event) => {
					const msg = JSON.parse(event.data);
					if (msg.id !== id) return;
					clearTimeout(timer);
					ws.removeEventListener("message", onMessage);
					if (msg.error) rej(new Error(method + ": " + JSON.stringify(msg.error)));
					else res(msg.result);
				};
				ws.addEventListener("message", onMessage);
				ws.send(JSON.stringify({ id, method, params }));
			});
			resolve({
				ws,
				enviar,
				avaliar: async (expression) => {
					const r = await enviar("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
					if (r.exceptionDetails) throw new Error("excecao: " + JSON.stringify(r.exceptionDetails.exception));
					return r.result ? r.result.value : undefined;
				},
			});
		});
		ws.addEventListener("error", () => reject(new Error("falha no WebSocket")), { once: true });
	});
}

async function acharAlvo(filtro, tentativas = 12) {
	for (let i = 0; i < tentativas; i++) {
		const lista = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
		const alvo = lista.find(filtro);
		if (alvo) return alvo;
		await sleep(1000);
	}
	throw new Error("alvo não apareceu");
}

// Repete a avaliação: webview recém-montado pode não responder na primeira.
async function avaliarComRetry(web, expression, tentativas = 5) {
	for (let i = 1; i <= tentativas; i++) {
		try {
			return await web.avaliar(expression);
		} catch (error) {
			if (i === tentativas) throw error;
			await sleep(1500);
		}
	}
}

async function main() {
	const base64 = fs.readFileSync(MP3).toString("base64");
	const out = {};

	const paginaAlvo = await acharAlvo((t) => t.type === "page" && t.url.includes("obsidian"));
	const pagina = await conectar(paginaAlvo);

	// desenho de teste + gravação sintética plotada
	out.montagem = JSON.parse(await avaliarComRetry(pagina, `(async () => {
		const automate = window.ExcalidrawAutomate;
		const p = app.plugins.plugins['voicecomment'];
		const caminho = await automate.getAPI().create({ filename: 'zz-teste-player', foldername: '/', onNewPane: false, silent: true });
		const arquivo = app.vault.getAbstractFileByPath(caminho);
		const folha = app.workspace.getLeaf(true);
		await folha.openFile(arquivo);
		await new Promise((r) => setTimeout(r, 2500));
		const bin = atob(${JSON.stringify(base64)});
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const salvo = await p.saveRecording(bytes);
		const plotou = await p.plotPage(salvo);
		return JSON.stringify({ desenho: caminho, html: salvo.html.path, mp3: salvo.mp3.path, plotou, viewAtiva: folha.view.getViewType() });
	})()`));

	// o webview do retângulo acabou de carregar a página nova
	const nomeHtml = out.montagem.html.split("/").pop().slice(0, 24);
	const webviewAlvo = await acharAlvo((t) => t.type === "webview" && t.url.includes(encodeURIComponent(nomeHtml)) || (t.type === "webview" && t.url.includes(nomeHtml)));
	const web = await conectar(webviewAlvo);

	out.botao = await avaliarComRetry(web, `(function () {
		var b = document.getElementById('toggle');
		var a = document.getElementById('player');
		if (!b || !a) return 'SEM BOTAO';
		var r = b.getBoundingClientRect();
		return 'tamanho=' + Math.round(r.width) + 'x' + Math.round(r.height) +
			' centro=' + Math.round(r.left + r.width / 2) + ',' + Math.round(r.top + r.height / 2) +
			' janela=' + innerWidth + 'x' + innerHeight +
			' centralizadoX=' + (Math.abs((r.left + r.width / 2) - innerWidth / 2) <= 2) +
			' cursor=' + getComputedStyle(b).cursor;
	})()`);

	out.estadoInicial = await avaliarComRetry(web, `(function () {
		var a = document.getElementById('player');
		var b = document.getElementById('toggle');
		a.muted = true;
		return 'tocando=' + (!a.paused) + ' tempo=' + a.currentTime + ' ready=' + a.readyState +
			' autoplay=' + a.hasAttribute('autoplay') + ' controls=' + a.hasAttribute('controls') +
			' duracao=' + (Math.round(a.duration * 10) / 10) + ' rotulo=' + b.getAttribute('aria-label') +
			' iconeVisivel=' + (getComputedStyle(b.querySelector('.icon-play')).display !== 'none');
	})()`);

	// clique de verdade no centro do botão (áudio mudo: sem barulho)
	const m = /centro=(\d+),(\d+)/.exec(String(out.botao) || "");
	if (!m) {
		out.erro = "não achei o centro do botão";
	} else {
		const x = Number(m[1]);
		const y = Number(m[2]);
		await web.enviar("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
		await web.enviar("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
		await sleep(60);
		await web.enviar("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
		// Leitura imediata: o áudio de teste é curto (1 s) e pode terminar antes.
		await sleep(300);
		out.depoisDoClique = await avaliarComRetry(web, `(function () {
			var a = document.getElementById('player');
			var b = document.getElementById('toggle');
			return 'tocando=' + (!a.paused) + ' tempo=' + (Math.round(a.currentTime * 10) / 10) +
				' classePlaying=' + b.classList.contains('playing') + ' rotulo=' + b.getAttribute('aria-label') +
				' iconePauseVisivel=' + (getComputedStyle(b.querySelector('.icon-pause')).display !== 'none') +
				' progresso=' + document.getElementById('fill').style.width + ' tempoMostrado=' + document.getElementById('now').textContent + ' de ' + document.getElementById('total').textContent;
		})()`);
		// E o fim do áudio: progresso volta a zero e o ícone volta a "tocar".
		await sleep(1500);
		out.depoisDoFim = await avaliarComRetry(web, `(function () {
			var a = document.getElementById('player');
			var b = document.getElementById('toggle');
			return 'tempo=' + (Math.round(a.currentTime * 10) / 10) + ' duracao=' + (Math.round(a.duration * 10) / 10) +
				' parouNoFim=' + a.paused + ' classePlaying=' + b.classList.contains('playing') +
				' progresso=' + document.getElementById('fill').style.width + ' mostrado=' + document.getElementById('now').textContent;
		})()`);
	}

	// devolve o player ao estado parado e limpa o teste
	await avaliarComRetry(web, `(function () { var a = document.getElementById('player'); a.pause(); a.muted = false; a.currentTime = 0; return 'parado'; })()`).catch(() => {});
	web.ws.close();

	out.limpeza = JSON.parse(await avaliarComRetry(pagina, `(async () => {
		const alvos = [${JSON.stringify(out.montagem.desenho)}, ${JSON.stringify(out.montagem.mp3)}, ${JSON.stringify(out.montagem.html)}]
			.concat(app.vault.getFiles().filter((f) => /^zz-teste-player/.test(f.name)).map((f) => f.path));
		const feitos = [];
		for (const caminho of alvos) {
			const f = app.vault.getAbstractFileByPath(caminho);
			if (!f) continue;
			await app.vault.delete(f);
			feitos.push(caminho);
		}
		return JSON.stringify({ apagados: feitos, sobraramZZ: app.vault.getFiles().filter((f) => /zz-teste/i.test(f.name)).map((f) => f.path) });
	})()`));
	pagina.ws.close();

	console.log(JSON.stringify(out, null, 1));
	const botao = String(out.botao || "");
	const inicial = String(out.estadoInicial || "");
	const depois = String(out.depoisDoClique || "");
	const fim = String(out.depoisDoFim || "");
	const ok = /tamanho=8[0-9]x8[0-9]/.test(botao) && /centralizadoX=true/.test(botao)
		&& /tocando=false/.test(inicial) && /autoplay=false/.test(inicial) && /controls=false/.test(inicial)
		&& /tocando=true/.test(depois) && /classePlaying=true/.test(depois) && /iconePauseVisivel=true/.test(depois)
		&& /parouNoFim=true/.test(fim) && /mostrado=0:00/.test(fim);
	console.log(ok
		? "OK: botão 84x84 centralizado, nada toca sozinho, o clique toca (ícone vira pausa) e ao terminar ele volta sozinho ao início."
		: "FALHOU: ver os campos acima.");
	process.exit(ok ? 0 : 1);
}

main().catch((error) => {
	console.error("FALHOU: " + error.message);
	process.exit(1);
});
