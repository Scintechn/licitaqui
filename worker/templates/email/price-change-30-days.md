---
id: price-change-30-days
channel: email
subject: "Aviso: em {{data_mudanca}} sua mensalidade da LicitaQui passa de R$ 26,00 para R$ 57,00"
preheader: "Aviso com 30 dias de antecedência. Se não quiser continuar, dá para cancelar em um clique."
status: draft
placeholders: [nome, data_mudanca, data_ultima_cobranca_26, data_primeira_cobranca_57, link_cancelamento, link_assinatura, email_contato]
partials: [partial-footer]
notes: Legal obligation. Job promo_price_change, 30 days before promo_ends_on. The value may NEVER change before this email is confirmed as sent (spec section 10).
---

Oi, {{nome}}.

Este é o aviso, com 30 dias de antecedência, de que o preço da sua assinatura da LicitaQui vai mudar. Nada muda hoje. Leia com calma, são poucas linhas.

O QUE MUDA

- Hoje você paga R$ 26,00 por mês. Esse é o preço Promocional de fundador, combinado para os 6 primeiros meses.
- A partir de {{data_mudanca}}, a mensalidade passa a ser R$ 57,00 por mês, que é o preço do plano Essencial.
- Sua última cobrança de R$ 26,00 é em {{data_ultima_cobranca_26}}.
- Sua primeira cobrança de R$ 57,00 é em {{data_primeira_cobranca_57}}.
- Continua sendo mensal e sem fidelidade. Os recursos da sua conta são exatamente os mesmos: nada é adicionado nem retirado por causa dessa mudança.

SE VOCÊ NÃO QUISER CONTINUAR

Cancele até {{data_mudanca}} em {{link_cancelamento}}. É um clique, não precisa falar com ninguém e não tem multa. Cancelando dentro desse prazo, você não é cobrado no valor novo.

Se cancelar, sua conta volta para o plano Básico, que é gratuito.

SE VOCÊ NÃO FIZER NADA

A assinatura continua, e a partir de {{data_mudanca}} a cobrança passa a ser de R$ 57,00 por mês.

Você pode ver e alterar sua assinatura a qualquer momento em {{link_assinatura}}. Dúvidas sobre este aviso: responda este e-mail ou escreva para {{email_contato}}.

Obrigado por ter entrado no começo. O preço de R$ 26 existiu justamente porque você entrou antes de a LicitaQui estar pronta.

Equipe LicitaQui

TODO(Sci): revisão jurídica obrigatória deste texto. Ele precisa bater palavra por palavra com a cláusula de mudança de preço dos termos de uso (gap G3) e com o que a página de oferta prometeu ao fundador.
TODO(Sci): decidir se o aviso também vai por WhatsApp (rascunho em whatsapp/price-change-30-days.md). Se for, o e-mail continua sendo o canal oficial e o registro de envio.
TODO(Sci): confirmar com o Asaas o texto exato das datas de cobrança (o ciclo da assinatura define se data_primeira_cobranca_57 cai em data_mudanca ou depois).
