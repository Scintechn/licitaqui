---
id: custom-alert-match
channel: telegram
status: draft
placeholders: [nome, alerta_nome, objeto, orgao, uf, modalidade, prazo_proposta, link_edital, marcador_meepp]
flags: [tem_nome, tem_meepp]
notes: One custom alert notification (E30). Sent when a new tender matches a user's alert. marcador_meepp is guarded by tem_meepp and uses the same ME/EPP marker logic as weekly-digest items.
---

Novo edital para seu alerta[[se: tem_nome]] {{nome}}[[/se]]!

*Alerta:* {{alerta_nome}}

*{{objeto}}*
{{orgao}} — {{uf}} · {{modalidade}}
Propostas até {{prazo_proposta}}
[[se: tem_meepp]]{{marcador_meepp}}
[[/se]]
Ler o edital: {{link_edital}}

A leitura é feita por inteligência artificial e serve para você decidir rápido. Antes de enviar proposta, confira sempre no edital.
