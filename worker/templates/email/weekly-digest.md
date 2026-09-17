---
id: weekly-digest
channel: email
subject: "{{nome_empresa}}: os editais abertos desta semana"
preheader: "Até 3 editais que combinam com o que a sua empresa faz."
status: draft
placeholders: [nome, nome_empresa, lista_editais, link_radar, link_conexao]
partials: [partial-digest-item, partial-footer]
notes: Email version of the weekly digest, for users who have not linked Telegram.
---

Oi, {{nome}}.

Estes são os editais abertos desta semana que combinam com o que a {{nome_empresa}} faz:

{{lista_editais}}

Ver todos no Radar: {{link_radar}}

A leitura é feita por inteligência artificial e serve para você decidir rápido se vale a pena disputar. Antes de enviar proposta, confira sempre no edital.

Prefere receber isso no Telegram, no seu celular? Conecte em {{link_conexao}}.

Equipe LicitaQui
