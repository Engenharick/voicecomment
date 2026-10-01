// Testa a gravação pelo microfone de ponta a ponta, pelo caminho real do plugin:
// abre um desenho de teste, começa a gravar, espera N segundos e para (o que
// salva o MP3, escreve a página e plota o retângulo). Lê o log do plugin para
// saber o tamanho do PCM e o pico capturado, e (por padrão) apaga tudo.
//
//   node tools\testar-microfone.js <porta> <segundos> [manter]
const PORT = process.argv[2] || "9333";
const SEGUNDOS = Number(process.argv[3] || 8);
const MANTER = process.argv[4] === "manter";

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

	const out = {};

	// abre um desenho de teste (o microfone só grava com um desenho ativo)
	out.desenho = JSON.parse(await evaluate(`(async () => {
		const automate = window.ExcalidrawAutomate;
		if (!automate) return JSON.stringify({ erro: 'sem Excalidraw' });
		const caminho = await automate.getAPI().create({ filename: 'zz-teste-microfone', foldername: '/', onNewPane: false, silent: true });
		const arquivo = app.vault.getAbstractFileByPath(caminho);
		const folha = app.workspace.getLeaf(true);
		await folha.openFile(arquivo);
		await new Promise((r) => setTimeout(r, 2500));
		return JSON.stringify({ caminho, tipo: folha.view.getViewType() });
	})()`));
	if (out.desenho.tipo !== "excalidraw") {
		console.log(JSON.stringify(out, null, 1));
		ws.close();
		process.exit(1);
	}

	// começa a gravar
	out.inicio = await evaluate(`(async () => {
		const p = app.plugins.plugins['voicecomment'];
		await p.startRecording();
		return JSON.stringify({ gravando: p.recorder.active, estadoDoContexto: p.recorder.ctx ? p.recorder.ctx.state : null, taxa: p.recorder.ctx ? p.recorder.ctx.sampleRate : null });
	})()`);
	console.log("gravando: " + out.inicio);
	console.log(`FALE AGORA — gravando ${SEGUNDOS} segundos…`);

	await sleep(SEGUNDOS * 1000);

	const nivel = await evaluate(`(() => { const p = app.plugins.plugins['voicecomment']; return JSON.stringify({ nivelNoFim: Number(p.recorder.readLevel().toFixed(3)), decorridoMs: Math.round(p.recorder.elapsedMs()) }); })()`);
	out.fim = JSON.parse(nivel);

	// para (salva + plota)
	out.parada = await evaluate(`(async () => {
		const p = app.plugins.plugins['voicecomment'];
		const antes = await app.vault.adapter.read('.obsidian/plugins/voicecomment/voicecomment.log').catch(() => '');
		await p.stopAndPlot();
		await new Promise((r) => setTimeout(r, 2500));
		const depois = await app.vault.adapter.read('.obsidian/plugins/voicecomment/voicecomment.log').catch(() => '');
		const novas = depois.split('\\n').filter(Boolean).filter((l) => !antes.includes(l));
		const salvo = novas.find((l) => l.includes('gravado:')) || null;
		const pedido = novas.find((l) => l.includes('servidor: GET')) || null;
		const elemento = (() => {
			const automate = window.ExcalidrawAutomate;
			const folha = app.workspace.getLeavesOfType('excalidraw').find((l) => l.view.file && /zz-teste-microfone/.test(l.view.file.path));
			if (!folha) return null;
			const api = automate.getAPI(folha.view);
			const itens = api.getViewElements().filter((e) => e.type === 'embeddable').map((e) => e.link);
			api.destroy();
			return itens;
		})();
		return JSON.stringify({ novasLinhas: novas.slice(-4), salvo, pedidoDoServidor: pedido, elementosNoDesenho: elemento });
	})()`);

	out.logCompleto = await evaluate(`(async () => { const t = await app.vault.adapter.read('.obsidian/plugins/voicecomment/voicecomment.log').catch(() => ''); return t.split('\\n').filter(Boolean).slice(-6).join('\\n'); })()`);

	// tamanho do arquivo gravado (para provar que saiu áudio de verdade)
	out.arquivos = await evaluate(`JSON.stringify(app.vault.getFiles().filter((f) => f.path.startsWith('AudioHTML/')).map((f) => ({ path: f.path, bytes: f.stat.size })))`);

	if (!MANTER) {
		out.limpeza = await evaluate(`(async () => {
			const alvos = ['zz-teste-microfone.excalidraw.md'].concat(app.vault.getFiles().filter((f) => /^AudioHTML\\/Áudio /.test(f.path)).map((f) => f.path));
			const feitos = [];
			for (const caminho of alvos) {
				const f = app.vault.getAbstractFileByPath(caminho);
				if (!f) continue;
				await app.vault.delete(f);
				feitos.push(caminho);
			}
			return JSON.stringify({ apagados: feitos, sobraramZZ: app.vault.getFiles().filter((f) => /zz-teste/i.test(f.name)).map((f) => f.path) });
		})()`);
	}

	ws.close();
	console.log(JSON.stringify(out, null, 1));

	const parada = JSON.parse(out.parada);
	const pico = parada.salvo && /pico=([0-9.]+)/.exec(parada.salvo);
	const pcm = parada.salvo && /pcm=(\d+)B/.exec(parada.salvo);
	console.log("--- resumo ---");
	console.log("gravou: " + (out.fim.decorridoMs / 1000).toFixed(1) + "s | PCM capturado: " + (pcm ? pcm[1] : "?") + " bytes | pico: " + (pico ? pico[1] : "?"));
	console.log("retângulo plotado: " + ((parada.elementosNoDesenho || []).length > 0) + " | página carregada: " + !!parada.pedidoDoServidor);
	process.exit(parada.salvo && pico && Number(pico[1]) > 0.0005 ? 0 : 1);
}

main().catch((error) => {
	console.error("FALHOU: " + error.message);
	process.exit(1);
});
