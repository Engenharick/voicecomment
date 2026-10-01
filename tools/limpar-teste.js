// Limpa o que sobra de um teste que falhou no meio: apaga os arquivos zz-teste
// que as ferramentas criam e os caminhos de gravação passados na linha.
//
// Só apaga por nome zz-teste (nunca toca em arquivo do usuário) ou por caminho
// exato informado. Sempre fecha antes a aba do desenho de teste: apagar um
// arquivo aberto é o que costuma travar o app.
//
//   node tools\limpar-teste.js <porta> ["caminho/exato.mp3" ...]
const fs = require("fs");
const PORT = process.argv[2] || "9333";
const EXATOS = process.argv.slice(3).map((p) => String(p).replace(/\\/g, "/"));

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

(async () => {
	const lista = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
	const alvo = lista.filter((t) => t.type === "page" && t.url.includes("obsidian"))[0];
	if (!alvo) throw new Error("nenhuma aba do Obsidian na porta " + PORT);
	const ws = new WebSocket(alvo.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.addEventListener("open", resolve, { once: true });
		ws.addEventListener("error", () => reject(new Error("falha no WebSocket")), { once: true });
	});
	await send(ws, "Runtime.enable", {});

	const avaliar = async (expressao) => {
		const res = await send(ws, "Runtime.evaluate", { expression: expressao, returnByValue: true, awaitPromise: true });
		if (res.exceptionDetails) throw new Error("excecao: " + JSON.stringify(res.exceptionDetails.exception));
		return res.result ? res.result.value : undefined;
	};

	// 1) o que existe hoje
	const antes = await avaliar(`JSON.stringify(app.vault.getFiles().filter(function (f) { return /zz-teste/i.test(f.name); }).map(function (f) { return f.path; }))`);
	console.log("arquivos zz-teste antes: " + antes);

	const alvos = JSON.parse(antes).concat(EXATOS);

	// 2) fecha as abas desses arquivos
	const fechou = await avaliar(`(function () {
		const alvos = ${JSON.stringify(alvos)};
		let n = 0;
		app.workspace.getLeavesOfType('excalidraw').forEach(function (l) {
			const caminho = l.view && l.view.file ? l.view.file.path : '';
			if (alvos.indexOf(caminho) >= 0) { l.detach(); n++; }
		});
		return n;
	})()`);
	console.log("abas fechadas: " + fechou);
	await new Promise((r) => setTimeout(r, 2000));

	// 3) apaga um por um, devagar (apagar em lote é o que estoura o tempo)
	for (const caminho of alvos) {
		try {
			const r = await avaliar(`(async function () {
				const f = app.vault.getAbstractFileByPath(${JSON.stringify(caminho)});
				if (!f) return 'ausente';
				await app.vault.delete(f);
				return 'apagado';
			})()`);
			console.log("  " + caminho + " -> " + r);
		} catch (erro) {
			console.log("  " + caminho + " -> FALHOU: " + erro.message);
		}
		await new Promise((r) => setTimeout(r, 700));
	}

	const depois = await avaliar(`JSON.stringify(app.vault.getFiles().filter(function (f) { return /zz-teste/i.test(f.name); }).map(function (f) { return f.path; }))`);
	console.log("arquivos zz-teste depois: " + depois);
	ws.close();
})().catch((erro) => {
	console.error("FALHOU: " + erro.message);
	process.exit(1);
});
