# Marca LicitaQui

Marca vencedora: **M9a** (barras desencontradas, azul curta no alto).

## Geometria
Grade de 64. Barras de altura 11, vaos de 4:
- azul  x34 y12 l22
- ink   x8  y27 l48
- ink   x14 y42 l42

Nunca alinhar as barras pela direita nem ordenar os comprimentos: o desencontro e o movimento da marca.

## Cores
- Grafite `#171717` (barras escuras)
- Azul `#2457D6` (barra curta e o "Qui")
- Azul claro `#5C86EC` (somente sobre fundo escuro)
- Ivory `#FBF7F3` (fundo)

## Tipografia
- Marca e titulos: **Archivo** — peso 800, largura (wdth) 85%, entreletras -3%
- Texto: **IBM Plex Sans** 400/500/600
- Rotulos e dados: **IBM Plex Mono** 400/500

Google Fonts:
`https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..100,500..800&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap`

## Nome
Sempre `LicitaQui` — junto, L e Q maiusculos. Archivo 800, largura 85%, entreletras -3%.
Nunca licitaqui, Licitaqui ou LICITAQUI. So o "Qui" recebe o azul.

## Respiro
Minimo em volta da marca: o dobro da altura de uma barra (22 na grade de 64).

## Arquivos
- `licitaqui-simbolo.svg` / `-escuro` / `-mono` — simbolo sem fundo
- `licitaqui-icone-claro.svg` / `-escuro.svg` — simbolo com fundo
- `licitaqui-assinatura.svg` — simbolo + nome. O texto depende da fonte Archivo (o SVG faz @import do Google Fonts, que funciona no navegador mas nao no Figma/Illustrator nem em PDF). **Converter o texto em contornos** antes de enviar para terceiros ou imprimir — sem Archivo instalada, ele cai em serif.
- `icone-192.png`, `icone-512.png`, `icone-512-escuro.png` — manifest do PWA
- `icone-maskable-512.png` — purpose="maskable", com a area segura de 22%
- `favicon-16.png`, `favicon-32.png`
- `avatar-bot-512.png` — Telegram, tudo em Ivory sobre azul (azul sobre azul desaparece)
