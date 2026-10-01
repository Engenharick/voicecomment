param(
	[string]$Vault = 'C:\Obsidian\Infinity Sistem 8'
)
$ErrorActionPreference = 'Stop'

# Um build, duas instalações — cada uma com o SEU fonte:
#   principal : src\audiohtml.js   -> main.js        -> VoiceComment 2.0        (id voicecomment)
#   cópia     : teste\audiohtml.js -> teste\main.js  -> VoiceComment 2.0 Cópia  (id voice-comment-2-0-copia)
#
# A cópia é o laboratório: mexer em teste\audiohtml.js não encosta na principal.
# O lame.min.js é o mesmo para as duas (é biblioteca de terceiros, não código nosso).
# Cada instalação tem porta e pasta próprias (o data.json de cada uma), senão as duas
# brigariam pela mesma porta e pelos mesmos arquivos.
#
# O id "voicecomment" é o que o diretório da comunidade já conhece: assim o 2.0 chega
# aos que já instalaram o plugin antigo como uma atualização normal, sem passar por
# uma nova análise.
#
# ⚠️ O data.json NÃO é reescrito quando já existe — ele guarda as suas escolhas (cores,
# tamanhos, porta, pasta). Ele só é criado quando falta, e é substituído (com uma cópia
# de segurança ao lado) quando vem do plugin antigo, cujo data.json não tinha "port".
#
# ⚠️ Set-Content -Encoding UTF8 no PowerShell 5.1 grava BOM e o Obsidian rejeita
# manifest/data.json com BOM. Gravar UTF-8 sem BOM pelo .NET.

$root = $PSScriptRoot
$pluginsDir = Join-Path $Vault '.obsidian\plugins'
$utf8SemBom = New-Object System.Text.UTF8Encoding($false)

$lame = [IO.File]::ReadAllBytes((Join-Path $root 'src\lame.min.js'))
$base = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json

$alvos = @(
	[pscustomobject]@{
		Id = 'voicecomment'; Nome = 'VoiceComment 2.0'
		Fonte = (Join-Path $root 'src\audiohtml.js'); Saida = (Join-Path $root 'main.js')
		Config = [pscustomobject]@{ folder = 'AudioHTML'; port = 8781 }
		Legado = 'prefix'   # chave que só o data.json do plugin antigo tinha
	},
	[pscustomobject]@{
		Id = 'voice-comment-2-0-copia'; Nome = 'VoiceComment 2.0 Cópia'
		Fonte = (Join-Path $root 'teste\audiohtml.js'); Saida = (Join-Path $root 'teste\main.js')
		Config = [pscustomobject]@{ folder = 'AudioHTML-Teste'; port = 8782; ribbonIconName = 'flask-conical' }
		Legado = ''; Opcional = $true   # laboratório local: não existe no repositório público
	}
)

$instalar = Test-Path (Join-Path $Vault '.obsidian')

foreach ($alvo in $alvos) {
	if (-not (Test-Path $alvo.Fonte)) {
		if ($alvo.PSObject.Properties.Name -contains 'Opcional' -and $alvo.Opcional) {
			Write-Output ("pulado (fonte ausente, é o laboratório local): " + $alvo.Fonte.Replace($root + '\', ''))
			continue
		}
		throw ("fonte não encontrada: " + $alvo.Fonte)
	}

	# main.js = lame.min.js + \n + fonte  (bytes exatos, sem BOM)
	$mine = [IO.File]::ReadAllBytes($alvo.Fonte)
	$all  = New-Object byte[] ($lame.Length + 1 + $mine.Length)
	[Array]::Copy($lame, 0, $all, 0, $lame.Length)
	$all[$lame.Length] = 0x0A
	[Array]::Copy($mine, 0, $all, $lame.Length + 1, $mine.Length)
	[IO.File]::WriteAllBytes($alvo.Saida, $all)

	Write-Output ("compilado: " + $alvo.Fonte.Replace($root + '\', '') + " -> " + $alvo.Saida.Replace($root + '\', '') + "  (" + (Get-Item $alvo.Saida).Length + " bytes)")
	if (-not $instalar) { continue }

	$dst = Join-Path $pluginsDir $alvo.Id
	New-Item -ItemType Directory -Force -Path $dst | Out-Null

	$manifest = $base.PSObject.Copy()
	$manifest.id = $alvo.Id
	$manifest.name = $alvo.Nome
	[IO.File]::WriteAllText((Join-Path $dst 'manifest.json'), ($manifest | ConvertTo-Json -Depth 5), $utf8SemBom)

	Copy-Item $alvo.Saida (Join-Path $dst 'main.js') -Force
	Copy-Item (Join-Path $root 'styles.css') (Join-Path $dst 'styles.css') -Force

	# data.json: cria se faltar; troca se ainda for o do plugin antigo.
	$caminhoConfig = Join-Path $dst 'data.json'
	$criar = -not (Test-Path $caminhoConfig)
	if (-not $criar -and $alvo.Legado) {
		$atual = Get-Content $caminhoConfig -Raw | ConvertFrom-Json
		if (-not ($atual.PSObject.Properties.Name -contains 'port')) {
			Copy-Item $caminhoConfig ($caminhoConfig + '.antigo') -Force
			Write-Output ("data.json do plugin antigo guardado como data.json.antigo em " + $alvo.Id)
			$criar = $true
		}
	}
	if ($criar) {
		[IO.File]::WriteAllText($caminhoConfig, ($alvo.Config | ConvertTo-Json), $utf8SemBom)
		Write-Output ("data.json criado: " + $alvo.Id + "  " + ($alvo.Config | ConvertTo-Json -Compress))
	}

	Get-ChildItem $dst | Unblock-File
	Write-Output ("instalado: " + $alvo.Id + "  (" + $alvo.Nome + ")")
}

if ($instalar) {
	# A instalação que ficou obsoleta (o antigo principal, id voice-comment-2-0) sai de
	# cena: o principal agora é o id voicecomment. Sem isso, sobrariam dois plugins
	# iguais disputando a mesma porta.
	$obsoleto = Join-Path $pluginsDir 'voice-comment-2-0'
	if (Test-Path $obsoleto) {
		Remove-Item $obsoleto -Recurse -Force
		Write-Output 'removida a instalação obsoleta: voice-comment-2-0'
	}

	# community-plugins.json: o id obsoleto sai, os dois alvos ficam habilitados
	$cp = Join-Path $Vault '.obsidian\community-plugins.json'
	$lista = [System.Collections.ArrayList]@()
	foreach ($item in (Get-Content $cp -Raw | ConvertFrom-Json)) { [void]$lista.Add([string]$item) }
	[void]$lista.Remove('voice-comment-2-0')
	foreach ($alvo in $alvos) { if (-not $lista.Contains($alvo.Id)) { [void]$lista.Add($alvo.Id) } }
	$corpo = ($lista | ForEach-Object { '  "' + $_ + '"' }) -join ",`r`n"
	Set-Content -Path $cp -Value ("[`r`n" + $corpo + "`r`n]`r`n") -Encoding ASCII
}

# Compara os dois fontes: se estiverem iguais, a cópia ainda não divergiu.
$principal = Join-Path $root 'src\audiohtml.js'
$copia = Join-Path $root 'teste\audiohtml.js'
if (-not (Test-Path $copia)) {
	Write-Output 'fontes: sem laboratório local (teste\audiohtml.js não existe)'
} elseif ((Get-FileHash $principal).Hash -eq (Get-FileHash $copia).Hash) {
	Write-Output 'fontes: principal e cópia IDÊNTICOS (a cópia ainda não divergiu)'
} else {
	Write-Output 'fontes: principal e cópia DIFERENTES (a cópia tem código próprio)'
}
