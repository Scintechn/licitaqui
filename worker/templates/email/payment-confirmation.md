---
id: payment-confirmation
channel: email
subject: "Pagamento confirmado — plano {{nome_plano}} da LicitaQui"
preheader: "Recebemos {{valor_pago}}. Sua assinatura está ativa."
status: draft
placeholders: [data_pagamento, data_proxima_cobranca, email_contato, forma_pagamento, link_app, link_assinatura, meses_promocionais, nome, nome_plano, preco_essencial_exato, preco_promocional_exato, valor_pago]
partials: [partial-footer]
flags: [plano_promocional]
notes: Asaas webhook PAYMENT_CONFIRMED / PAYMENT_RECEIVED. Must be idempotent - one email per payment id.
---

Oi, {{nome}}.

Recebemos seu pagamento. Sua assinatura da LicitaQui está ativa.

- Plano: {{nome_plano}}
- Valor pago: {{valor_pago}}
- Forma de pagamento: {{forma_pagamento}}
- Data do pagamento: {{data_pagamento}}
- Próxima cobrança: {{data_proxima_cobranca}}

[[se: plano_promocional]]
Lembrando do combinado do preço de fundador: são {{preco_promocional_exato}} por mês nos {{meses_promocionais}} primeiros meses. Depois disso a mensalidade passa a {{preco_essencial_exato}} por mês, e a gente te avisa por e-mail 30 dias antes de qualquer mudança.
[[/se]]

Continua sendo mensal e sem fidelidade: você pode cancelar quando quiser, em um clique, em {{link_assinatura}}.

Sua conta já está liberada: {{link_app}}

Qualquer dúvida sobre a cobrança, responda este e-mail ou escreva para {{email_contato}}.

Equipe LicitaQui

TODO(Sci): decidir se este e-mail menciona nota fiscal. Hoje ele não menciona nada, de propósito — a emissão de NF é gap G13, ainda indefinida com o contador, e o produto não promete NF.
TODO(Sci): confirmar se o recibo do Asaas vai anexado ou linkado aqui, ou se o cliente só vê o recibo dentro da própria plataforma de pagamento.
