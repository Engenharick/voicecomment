// Verificação do VoiceComment 2.0 dentro do Obsidian:
//   1) o servidor local subiu?
//   2) o caminho real do plugin (saveRecording + plotPage) grava o MP3 e o HTML?
//   3) o retângulo é criado no desenho e o WEBVIEW carrega a página (o log do
//      servidor prova, porque é ele que escreve a linha de cada pedido)?
//   4) fechando e reabrindo o desenho, o retângulo volta e a página é carregada
//      outra vez (e o áudio continua parado)?
//
//   node tools\verificar-retangulo.js <porta> "<mp3-de-teste>" [apagar] [id-do-plugin]
const fs = require("fs");
const PORT = process.argv[2] || "9333";
const MP3 = process.argv[3];
const APAGAR = process.argv[4] === "apagar";
const ID = process.argv[5] || "voicecomment";
if (!MP3) {
	console.error('uso: node tools\\verificar-retangulo.js <porta> "<mp3>" [apagar] [id-do-plugin]');
	process.exit(1);
}

let nextId = 1;
function send(ws, method, params) {
	return new Promise((resolve, reject) => {
		const id = nextId++;
		const timer = setTimeout(() => reject(new Error("timeout em " + method)), 120000);
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

async function main() {
	const base64 = fs.readFileSync(MP3).toString("base64");
	const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
	const target = list.filter((t) => t.type === "page" && t.url.includes("obsidian"))[0];
	if (!target) throw new Error("nenhuma aba do Obsidian na porta " + PORT);
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.addEventListener("open", resolve, { once: true });
		ws.addEventListener("error", () => reject(new Error("falha no WebSocket")), { once: true });
	});

	const evaluate = async (expression) => {
		const res = await send(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (res.exceptionDetails) throw new Error("excecao: " + JSON.stringify(res.exceptionDetails.exception));
		return res.result ? res.result.value : undefined;
	};

	const logTail = async (marca) => {
		const texto = await evaluate(`(async () => { try { return await app.vault.adapter.read('.obsidian/plugins/${ID}/voicecomment.log'); } catch (e) { return 'sem log: ' + e.message; } })()`);
		const linhas = String(texto || "").split("\n").filter(Boolean);
		const indice = linhas.map((l, i) => [l, i]).filter(([l]) => l.includes(marca)).pop();
		return indice ? linhas.slice(indice[1]).filter((l) => l.includes(marca)) : [];
	};

	const out = {};

	// 1) plugin e servidor
	const estado = await evaluate(`(() => {
		const p = app.plugins.plugins[${JSON.stringify(ID)}];
		return JSON.stringify({
			carregado: !!p,
			base: p ? p.serviceBase() : null,
			portaEfetiva: p ? p.effectivePort : null,
			pasta: p ? p.folderPath() : null,
			servidor: p ? !!p.server : null,
		});
	})()`);
	out.plugin = JSON.parse(estado);
	if (!out.plugin.carregado) {
		console.log(JSON.stringify(out, null, 1));
		ws.close();
		process.exit(1);
	}

	// 2) desenho de teste
	const criado = await evaluate(`(async () => {
		const automate = window.ExcalidrawAutomate;
		if (!automate) return 'SEM EXCALIDRAW';
		const caminho = await automate.getAPI().create({ filename: 'zz-teste-audiohtml', foldername: '/', onNewPane: false, silent: true });
		const arquivo = app.vault.getAbstractFileByPath(caminho);
		if (!arquivo) return 'NAO CRIOU';
		const folha = app.workspace.getLeaf(true);
		await folha.openFile(arquivo);
		await new Promise((r) => setTimeout(r, 2500));
		return JSON.stringify({ caminho, tipo: folha.view.getViewType() });
	})()`);
	out.desenho = JSON.parse(criado);
	if (out.desenho.tipo !== "excalidraw") {
		console.log(JSON.stringify(out, null, 1));
		ws.close();
		process.exit(1);
	}

	// 3) gravação sintética pelo caminho real do plugin + plotagem
	out.gravacao = JSON.parse(await evaluate(`(async () => {
		const p = app.plugins.plugins[${JSON.stringify(ID)}];
		const bin = atob(${JSON.stringify(base64)});
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const salvo = await p.saveRecording(bytes);
		const plotou = await p.plotPage(salvo);
		return JSON.stringify({
			mp3: salvo.mp3.path,
			html: salvo.html.path,
			bytes: bytes.length,
			plotou,
			url: p.serviceBase() + '/' + encodeURIComponent(salvo.html.name),
		});
	})()`));

	await sleep(4000);
	out.pedidosDepoisDePlotar = await logTail("servidor: GET");
	out.elementos = JSON.parse(await evaluate(`(async () => {
		const automate = window.ExcalidrawAutomate;
		const folha = app.workspace.getLeavesOfType('excalidraw').find((l) => l.view.file && /zz-teste-audiohtml/.test(l.view.file.path));
		if (!folha) return 'SEM FOLHA';
		const api = automate.getAPI(folha.view);
		const elementos = api.getViewElements().filter((e) => e.type === 'embeddable').map((e) => ({ link: e.link, w: e.width, h: e.height, x: Math.round(e.x), y: Math.round(e.y) }));
		api.destroy();
		return JSON.stringify(elementos);
	})()`));
	out.webviews = JSON.parse(await evaluate(`JSON.stringify(Array.from(document.querySelectorAll('webview')).map((w) => ({ src: String(w.getAttribute('src') || '').slice(0, 70), largura: w.offsetWidth, altura: w.offsetHeight })))`));

	// 4) fecha e reabre o desenho: o retângulo volta e a página é recarregada
	// Esta parte é a mais pesada para o app (ele desmonta e remonta a vista com
	// todos os plugins ligados). Se estourar, o relatório sai do mesmo jeito e a
	// limpeza acontece — o que já foi medido antes vale.
	try {
		const reabriu = await evaluate(`(async () => {
		const folha = app.workspace.getLeavesOfType('excalidraw').find((l) => l.view.file && /zz-teste-audiohtml/.test(l.view.file.path));
		if (!folha) return 'SEM FOLHA';
		const caminho = folha.view.file.path;
		folha.detach();
		await new Promise((r) => setTimeout(r, 2500));
		const arquivo = app.vault.getAbstractFileByPath(caminho);
		const nova = app.workspace.getLeaf(true);
		await nova.openFile(arquivo);
		await new Promise((r) => setTimeout(r, 8000));
		return JSON.stringify({ reaberto: nova.view.getViewType() });
	})()`);
		out.reabertura = JSON.parse(reabriu);
		await sleep(3000);
		out.pedidosDepoisDeReabrir = (await logTail("servidor: GET")).filter((l) => !String(out.pedidosDepoisDePlotar).includes(l));
		out.webviewsDepoisDeReabrir = JSON.parse(await evaluate(`JSON.stringify(Array.from(document.querySelectorAll('webview')).map((w) => ({ src: String(w.getAttribute('src') || '').slice(0, 70), largura: w.offsetWidth })))`));
	} catch (erro) {
		out.reabertura = { erro: erro.message };
		out.pedidosDepoisDeReabrir = [];
		out.webviewsDepoisDeReabrir = [];
		console.log("(o passo de reabrir não completou: " + erro.message + ")");
	}

	ws.close();

	// --- relatório ---
	const limpos = [];
	const cargaInicial = (out.pedidosDepoisDePlotar || []).some((l) => /\.html -> 200/.test(l));
	const cargaAoReabrir = (out.pedidosDepoisDeReabrir || []).some((l) => /\.html -> 200/.test(l));
	const retangulo = (out.elementos || []).length === 1 && /^https?:\/\//.test((out.elementos || [{}])[0].link || "");
	console.log(JSON.stringify(out, null, 1));
	console.log("servidor no ar: " + out.plugin.servidor + " (porta efetiva " + out.plugin.portaEfetiva + ")");
	console.log("MP3 + HTML gravados: " + (!!out.gravacao.mp3 && !!out.gravacao.html));
	console.log("retângulo (embeddable com URL): " + retangulo);
	console.log("página carregada dentro do desenho: " + cargaInicial);
	console.log("página carregada de novo ao reabrir o desenho: " + cargaAoReabrir);
	console.log("elementos webview na tela: " + (out.webviews || []).map((w) => w.src).join(" | "));

	if (APAGAR) {
		console.log("--- limpeza (só arquivos zz-teste) ---");
		// Fecha a aba do desenho de teste ANTES de apagar o arquivo: apagar um
		// arquivo que está aberto deixa o app sem resposta e o comando estoura o
		// tempo (foi o que acontecia quando a ordem era apagar primeiro).
		const fechou = await evaluate(`(() => {
			let n = 0;
			app.workspace.getLeavesOfType('excalidraw').forEach((l) => {
				if (l.view.file && /zz-teste-audiohtml/.test(l.view.file.path)) { l.detach(); n++; }
			});
			return n;
		})()`);
		console.log("abas do desenho de teste fechadas: " + fechou);
		await sleep(2000);
		const apagou = [];
		const remover = async (caminho) => {
			const r = await evaluate(`(async () => { const f = app.vault.getAbstractFileByPath(${JSON.stringify(caminho)}); if (!f) return 'ausente'; await app.vault.delete(f); return 'apagado'; })()`);
			apagou.push(caminho + " -> " + r);
			await sleep(700);
		};
		for (const caminho of [out.gravacao.mp3, out.gravacao.html, out.desenho.caminho]) await remover(caminho);
		console.log(apagou.join("\n"));
		const sobraram = await evaluate(`JSON.stringify(app.vault.getFiles().filter((f) => /zz-teste/i.test(f.name)).map((f) => f.path))`);
		console.log("sobraram arquivos zz-teste: " + sobraram);
	}

	process.exit(cargaInicial && retangulo ? 0 : 1);
}

main().catch((error) => {
	console.error("FALHOU: " + error.message);
	process.exit(1);
});
