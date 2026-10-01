# VoiceComment 2.0

*Documentação em português. A versão em inglês, que é a que aparece no diretório da comunidade, está no [README.md](README.md).*

Plugin do Obsidian que **grava um áudio e plota no desenho um retângulo com a página HTML que carrega esse áudio embutido** — sempre parado, e o retângulo volta quando o desenho é reaberto.

## Uso

1. Abra um desenho do Excalidraw.
2. Clique no **microfone** da barra lateral (ou comande *VoiceComment 2.0: gravar áudio e plotar no desenho*).
3. Fale e clique em **■ Parar e plotar** (ou repita o comando).

O plugin grava o MP3, escreve ao lado uma página HTML autossuficiente (o áudio dentro dela, em base64) e plota o retângulo no centro da vista do desenho.

| Arquivo | Para que serve |
|---|---|
| `<pasta>/VoiceComment AAAA-MM-DD HH.MM.SS.mp3` | o áudio em si, reutilizável em qualquer programa |
| `<pasta>/VoiceComment AAAA-MM-DD HH.MM.SS.html` | a página que o retângulo mostra — pode ser aberta no navegador |
| o elemento no `.excalidraw.md` | guarda a URL da página; é ele que faz o retângulo voltar |

## O áudio nunca toca sozinho

Duas garantias somadas:

1. A página gerada **não** tem o atributo `autoplay`.
2. O Excalidraw cria o retângulo como um *webview* com `autoplayPolicy=document-user-activation-required` — ou seja, o próprio plugin do desenho exige um clique do usuário para liberar som.

Verificado no app, depois de fechar e reabrir o desenho: o player aparece com o áudio **carregado e pronto** (`readyState: 4`), em `currentTime: 0`, com `paused: true` e sem autoplay. Só toca quando você clica no play.

## Como funciona

```
microfone → PCM (WebAudio) → lamejs → MP3 ─┬─> <nome>.mp3  (no cofre)
                    └── MediaRecorder ─────┘
                                           └─> <nome>.html (áudio em base64)
                                                    ↑
   servidor local 127.0.0.1:8781 (só esta máquina) serve a pasta
                                                    ↑
   elemento "embeddable" no desenho aponta para http://127.0.0.1:8781/<nome>.html
   (o Excalidraw manda qualquer link de protocolo para um webview)
```

- A captura tem **dois caminhos em paralelo**: o PCM cru do WebAudio direto no lamejs (um único passo com perda) e um `MediaRecorder` de rede de segurança. Se o PCM não entregar amostras — contexto de áudio suspenso é a causa clássica, e o cronômetro continua andando, o que engana — o capturado comprimido é decodificado e reencodado. A gravação não se perde.
- O servidor sobe no `onload` do plugin e só aceita `GET`/`HEAD`, só de `127.0.0.1`, e só serve arquivos **dentro** da pasta de gravações (nada de `../`). Cada pedido é registrado no log do plugin.

## Limites (honestos)

- **Só neste PC.** O retângulo mostra uma página servida pelo plugin rodando aqui. Noutro aparelho, ou com o Obsidian fechado, o retângulo aparece vazio. O MP3 e o HTML continuam válidos em qualquer lugar.
- **Trocar a porta quebra os retângulos já plotados** (a URL deles está gravada no desenho). Se a porta estiver ocupada, o plugin tenta as 10 seguintes e avisa.
- O retângulo mostra o player do **navegador** dentro de um webview — não é o player nativo do Obsidian.

## Configurações

| Item | Descrição |
|---|---|
| Pasta dos áudios | Onde ficam o MP3 e o HTML; é a pasta servida (`VoiceComment` por padrão) |
| Qualidade do MP3 | 64 / 96 / 128 / 192 kb/s, mono |
| Largura / Altura | Tamanho do retângulo plotado (470 × 200 por padrão) |
| Cor da borda / Cor do fundo | Cores que o desenho pinta atrás da página. `transparent` (padrão) mantém o retângulo sem cor |
| Porta | Porta do servidor local (8781 por padrão) + botão *Reiniciar servidor* |
| Ícone de microfone | Mostra ou esconde o ícone da barra lateral |

## Diagnóstico

O log fica em `.obsidian/plugins/voicecomment/voicecomment.log`. Ele registra o estado do AudioContext, o tamanho do PCM, o pico, o arquivo salvo e **cada pedido ao servidor** (`servidor: GET /VoiceComment ....html -> 200`) — é assim que se confirma que o retângulo carregou a página.

Comandos disponíveis:

- *Gravar áudio e plotar no desenho*
- *Reiniciar o servidor local das páginas*
- *Plotar no desenho a última página gravada*
- *Refazer as páginas HTML desta pasta* (regenera a página de cada MP3 da pasta com o player e as cores atuais)

## Desenvolvimento

```powershell
powershell -File build.ps1                              # compila e instala no cofre
powershell -File build.ps1 -Vault "C:\caminho\do\cofre" # outro cofre
node --check main.js
```

Verificação com o app aberto (`Obsidian.exe --remote-debugging-port=9333`):

```powershell
node tools\verificar-retangulo.js 9333 "caminho\do\mp3" apagar voicecomment
node tools\limpar-teste.js 9333     # se um teste morreu no meio: apaga só arquivos zz-teste
```

`verificar-retangulo.js` grava pelo caminho real do plugin, plota, confere no log do servidor que a página foi carregada, fecha e reabre o desenho para provar que o retângulo volta — e apaga só os arquivos `zz-teste-` que ele mesmo criou. Com o cofre muito carregado, o passo de reabrir pode ficar lento: a ferramenta foi feita para não travar por causa disso — ela imprime o que conseguiu medir e ainda faz a limpeza.

## Duas instalações (principal + cópia de laboratório)

Existem **duas instalações** no cofre, cada uma com o **seu próprio fonte**:

| | Principal | Cópia de teste |
|---|---|---|
| Nome no Obsidian | `VoiceComment 2.0` | `VoiceComment 2.0 Cópia` |
| id | `voicecomment` | `voice-comment-2-0-copia` |
| Fonte | `src\audiohtml.js` | `teste\audiohtml.js` |
| Porta / pasta de gravações | 8781 / `AudioHTML` | 8782 / `AudioHTML-Teste` |
| Log | pasta do plugin | pasta do plugin (separado) |

`build.ps1` compila as duas (`main.js` da principal na raiz; o da cópia em `teste\main.js`) e instala cada uma do seu fonte — mexer na cópia **não** encosta na principal. O build avisa no fim se os dois fontes estão **idênticos** ou **divergentes**.

O `data.json` **não é reescrito** quando já existe (ele guarda as suas escolhas: cores, tamanhos, porta, pasta). Ele só é criado quando falta.

Fluxo para trabalhar na versão de teste:

```powershell
# 1) editar teste\audiohtml.js
node --check teste\audiohtml.js
powershell -File build.ps1          # compila e instala as duas
# 2) no Obsidian: Configurações → Plugins da comunidade → desligar/ligar a VoiceComment 2.0 Cópia
```

Quando a mudança na cópia estiver aprovada e você quiser levar para a principal, é copiar o trecho para `src\audiohtml.js` e rodar o build de novo (assim a principal continua funcionando enquanto a cópia é testada).

## Sobre o id `voicecomment`

O id do plugin é `voicecomment` — o mesmo que as versões 1.x usaram no diretório da comunidade. É de propósito: assim quem já tem a versão antiga instalada recebe esta como uma **atualização normal**, sem passar por uma nova análise do diretório. Como o nome mudou, a lista de plugins mostra `VoiceComment 2.0`, mas o id e a pasta continuam os mesmos — e o `data.json` antigo (que apontava para outra pasta de gravações e não tinha o campo `port`) é substituído pelo desta versão, guardando uma cópia em `data.json.antigo`.

## Licença

LGPL-3.0, por causa do `src/lame.min.js` — [lamejs](https://github.com/zhuker/lamejs) 1.2.1, baixado do npm e **sem modificação** (ver `src/lamejs-LICENSE.txt`).
