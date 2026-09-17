---
id: weekly-digest
channel: telegram
status: draft
placeholders: [nome, nome_empresa, lista_editais, link_radar]
partials: [partial-digest-item]
notes: Up to 3 tenders (task E1). {{lista_editais}} is the joined render of partial-digest-item, separated by a blank line.
---

Bom dia, {{nome}}. Estes são os editais abertos desta semana para a *{{nome_empresa}}*:

{{lista_editais}}

Ver todos no Radar: {{link_radar}}

A leitura é feita por inteligência artificial e serve para você decidir rápido. Antes de enviar proposta, confira sempre no edital.
