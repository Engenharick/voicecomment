// Lê dentro de um webview do Obsidian (no Electron cada webview é um alvo CDP
// próprio, com type "webview" — os drivers comuns, que filtram "page", não o
// enxergam). Opcionalmente recarrega a página antes e dá um clique de verdade.
//
//   node tools\ler-webview.js <porta> "<trecho-da-url>" "<expressao>" [--reload] [--click=x,y]
const PORT = process.argv[2] || "9333";
const TRECHO = process.argv[3];
const EXPRESSAO = process.argv[4] || "document.title";
const RECARREGAR = process.argv.includes("--reload");
const clique = (process.argv.find((a) => a.startsWith("--click=")) || "").replace("--click=", "");
if (!TRECHO) {
	console.error('uso: node tools\\ler-webview.js <porta> "<trecho-da-url>" "<expressao>" [--reload] [--click=x,y]');
	process.exit(1);
}

let nextId = 1;
function send(ws, method, params) {
	return new Promise((resolve, reject) => {
		const id = nextId++;
		const timer = setTimeout(() => reject(new Error("timeout em " + method)), 20000);
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

(async () => {
	const lista = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
	const alvo = lista.find((t) => t.type === "webview" && t.url.includes(TRECHO));
	if (!alvo) {
		console.error("nenhum webview com \"" + TRECHO + "\" — alvos: " + lista.map((t) => t.type).join(", "));
		process.exit(1);
	}
	const ws = new WebSocket(alvo.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.addEventListener("open", resolve, { once: true });
		ws.addEventListener("error", () => reject(new Error("falha no WebSocket")), { once: true });
	});

	if (RECARREGAR) {
		await send(ws, "Page.enable", {});
		await send(ws, "Page.reload", {});
		await sleep(2500);
	}

	if (clique) {
		const [x, y] = clique.split(",").map(Number);
		await send(ws, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
		await send(ws, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
		await sleep(60);
		await send(ws, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
		await sleep(1200);
	}

	const resultado = await send(ws, "Runtime.evaluate", { expression: EXPRESSAO, returnByValue: true, awaitPromise: true });
	ws.close();
	if (resultado.exceptionDetails) {
		console.error("exceção: " + JSON.stringify(resultado.exceptionDetails.exception));
		process.exit(1);
	}
	console.log(typeof resultado.result.value === "string" ? resultado.result.value : JSON.stringify(resultado.result.value, null, 1));
})().catch((error) => {
	console.error("FALHOU: " + error.message);
	process.exit(1);
});
