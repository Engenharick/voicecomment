// Verifica a mudança de cor: a página não pinta fundo (o fundo do retângulo
// aparece), a cor escolhida nas configurações vai para o elemento novo, e nada do
// mecanismo anterior quebrou (sem autoplay, player funcionando).
//
//   node tools\verificar-cor-retangulo.js <porta> "<mp3-de-teste>" [id-do-plugin]
const fs = require("fs");
const PORT = process.argv[2] || "9333";
const MP3 = process.argv[3];
const ID = process.argv[4] || "voicecomment";
if (!MP3) {
	console.error('uso: node tools\\verificar-cor-retangulo.js <porta> "<mp3>" [id]');
	process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nextId = 1;

function conectar(alvo) {
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

async function acharAlvo(filtro, tentativas = 15) {
	for (let i = 0; i < tentativas; i++) {
		const lista = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
		const alvo = lista.find(filtro);
		if (alvo) return alvo;
		await sleep(1000);
	}
	throw new Error("alvo não apareceu");
}

async function avaliarComRetry(web, expression, tentativas = 4) {
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
	const out = { plugin: ID };

	const pagina = await conectar(await acharAlvo((t) => t.type === "page" && t.url.includes("obsidian")));

	// 1) configura a cor de fundo e gera uma gravação/retângulo de teste
	out.montagem = JSON.parse(await avaliarComRetry(pagina, `(async () => {
		const p = app.plugins.plugins[${JSON.stringify(ID)}];
		p.settings.rectBackgroundColor = '#1f6f4a';
		p.settings.rectStrokeColor = '#ffd166';
		await p.saveSettings();
		const automate = window.ExcalidrawAutomate;
		const caminho = await automate.getAPI().create({ filename: 'zz-teste-cor', foldername: '/', onNewPane: false, silent: true });
		const arquivo = app.vault.getAbstractFileByPath(caminho);
		const folha = app.workspace.getLeaf(true);
		await folha.openFile(arquivo);
		await new Promise((r) => setTimeout(r, 2500));
		const bin = atob(${JSON.stringify(base64)});
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const salvo = await p.saveRecording(bytes);
		await p.plotPage(salvo);
		await new Promise((r) => setTimeout(r, 1500));
		const api = automate.getAPI(folha.view);
		const el = api.getViewElements().filter((e) => e.type === 'embeddable')[0];
		api.destroy();
		const html = await app.vault.read(salvo.html);
		return JSON.stringify({
			desenho: caminho, mp3: salvo.mp3.path, html: salvo.html.path,
			elemento: el ? { fundo: el.backgroundColor, borda: el.strokeColor, link: el.link } : null,
			paginaSemFundoClaro: !/background: #f5f5f7/.test(html),
			paginaTransparente: /background: transparent; color: #fff/.test(html),
			temSombraNoTitulo: /text-shadow: 0 1px 3px/.test(html),
			semControls: /<audio id="player" preload/.test(html),
		});
	})()`));

	// 2) dentro do webview: fundo de fato transparente e nada tocando
	const nome = out.montagem.html.split("/").pop().slice(0, 20);
	const web = await conectar(await acharAlvo((t) => t.type === "webview" && t.url.includes(encodeURIComponent(nome))));

	out.webview = await avaliarComRetry(web, `(function () {
		var a = document.getElementById('player');
		var b = document.getElementById('toggle');
		var fundo = getComputedStyle(document.body).backgroundColor;
		return 'fundoDoCorpo=' + fundo + ' tocando=' + (!a.paused) + ' ready=' + a.readyState +
			' autoplay=' + a.hasAttribute('autoplay') + ' botao=' + Math.round(b.getBoundingClientRect().width) +
			' sombraNoTitulo=' + (getComputedStyle(document.querySelector('h1')).textShadow !== 'none');
	})()`);
	await avaliarComRetry(web, `(function () { document.getElementById('player').muted = true; document.getElementById('toggle').click(); return 'toquei'; })()`);
	await sleep(400);
	out.tocandoDepoisDoClique = await avaliarComRetry(web, `(function () { var a = document.getElementById('player'); return 'tocando=' + (!a.paused) + ' tempo=' + (Math.round(a.currentTime * 10) / 10); })()`);
	await avaliarComRetry(web, `(function () { var a = document.getElementById('player'); a.pause(); a.muted = false; a.currentTime = 0; return 'ok'; })()`).catch(() => {});
	web.ws.close();

	// 3) limpeza: só o que este teste criou (desenho zz-teste-cor*, e a gravação de teste pelo tamanho)
	out.limpeza = JSON.parse(await avaliarComRetry(pagina, `(async () => {
		const p = app.plugins.plugins[${JSON.stringify(ID)}];
		const pasta = p.folderPath();
		const apagados = [];
		const alvos = app.vault.getFiles().filter((f) => /^zz-teste-cor/.test(f.name)).map((f) => f.path)
			.concat(app.vault.getFiles().filter((f) => f.path.startsWith(pasta + '/') && f.stat.size < 20000).map((f) => f.path));
		for (const caminho of alvos) {
			const f = app.vault.getAbstractFileByPath(caminho);
			if (!f) continue;
			await app.vault.delete(f);
			apagados.push(caminho);
		}
		// devolve as cores padrão para não deixar configuração de teste
		p.settings.rectBackgroundColor = 'transparent';
		p.settings.rectStrokeColor = 'transparent';
		await p.saveSettings();
		return JSON.stringify({ apagados, sobraramZZ: app.vault.getFiles().filter((f) => /zz-teste/i.test(f.name)).length, coresRestauradas: p.settings.rectBackgroundColor });
	})()`));
	pagina.ws.close();

	console.log(JSON.stringify(out, null, 1));
	const m = out.montagem;
	const w = String(out.webview || "");
	const ok = m.elemento && m.elemento.fundo === "#1f6f4a" && m.elemento.borda === "#ffd166"
		&& m.paginaTransparente && m.semControls && m.temSombraNoTitulo
		&& /fundoDoCorpo=rgba\(0, 0, 0, 0\)/.test(w) && /tocando=false/.test(w) && /autoplay=false/.test(w)
		&& /tocando=true/.test(String(out.tocandoDepoisDoClique || ""));
	console.log(ok
		? "OK: o retângulo recebeu a cor, a página não pinta fundo (a cor aparece), nada toca sozinho e o player funciona."
		: "FALHOU: ver os campos acima.");
	process.exit(ok ? 0 : 1);
}

main().catch((error) => {
	console.error("FALHOU: " + error.message);
	process.exit(1);
});
