---
id: tender-alert
channel: whatsapp
status: draft
placeholders: [nome, objeto, orgao, cidade_uf, modalidade, prazo_proposta, valor_estimado, marcador_meepp, link_edital]
flags: [tem_valor, tem_meepp]
notes: PROPOSAL - deliberately absent from README section 5. Spec section 10 promises the weekly alert on Telegram and section 9 forbids bulk WhatsApp, so this must not be wired to a per-user broadcast without Sci's decision. Written for today's text-only transport, URL inline; a title/footer/button split is additive later.
---

{{nome}}, encontrei um edital aberto que combina com as atividades do seu CNPJ.

📋 {{objeto}}
🏛️ {{orgao}} — {{cidade_uf}}
🏷️ {{modalidade}}
[[se: tem_valor]]💰 Valor estimado: {{valor_estimado}}
[[/se]]📅 Propostas até {{prazo_proposta}}
[[se: tem_meepp]]✅ {{marcador_meepp}}
[[/se]]
Ver o edital e pedir a leitura por IA:
{{link_edital}}

Para não receber mais mensagens, responda SAIR.
