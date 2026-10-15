---
id: custom-alert-match
channel: telegram
status: active
placeholders: [nome, alerta_nome, objeto, orgao, uf, modalidade, prazo_proposta, link_edital, marcador_meepp]
flags: [tem_nome, tem_meepp]
notes: One custom alert notification (E31 – rich text formatting). Sent when a new tender matches a user's alert. Enhanced with emojis and bold text for better visual hierarchy and mobile readability. marcador_meepp is guarded by tem_meepp and uses the same ME/EPP marker logic as weekly-digest items.
---

✨ *Novo edital para seu alerta*[[se: tem_nome]] {{nome}}[[/se]]!

🔔 *Alerta:* {{alerta_nome}}

📋 *{{objeto}}*

🏢 {{orgao}} — {{uf}}
📍 {{modalidade}}
⏰ Propostas até {{prazo_proposta}}
[[se: tem_meepp]]🎯 {{marcador_meepp}}
[[/se]]

👁️ <a href="{{link_edital}}">Ler o edital completo</a>

💡 A leitura é feita por inteligência artificial e serve para você decidir rápido. Antes de enviar proposta, confira sempre no edital.
