---
id: subscription-suspended
channel: email
status: approved
subject: Sua assinatura do LicitaQui está suspensa
placeholders: [data_cobranca, dias_suspensao, link_assinatura, link_pagamento, nome]
flags: [tem_link]
partials: [partial-footer]
notes: Terms section 7's ten-day suspension and section 14's fifth notice. Copy approved by Sci on 2026-10-13, and approved is NOT sendable here. READ THIS BEFORE WIRING IT - NOTHING SENDS THIS TEMPLATE, AND THAT IS CARD F42, NOT AN OVERSIGHT. The state it announces does not exist: 'suspended' is in 0015's CHECK and in lib/asaas/subscription.ts's vocabulary and is written by no code at all, which three separate comments in this repository already say. It is drafted here with F41's other two so Sci reads the five notices of section 14 in one pass, and F42 is what makes it sendable. F42 carries the two joins that are not SQL - the plan screen has no sentence for a suspended subscription (statusLine() falls through to "Aguardando o pagamento", which for a suspended account understates what happened, and billing.status.suspended does not exist in pt-BR.json), and plan-view.tsx's `cancellable` excludes 'suspended', so writing the state would take away the one-click cancel terms section 8 promises. Both are copy or product decisions, so both are Sci's. The number of days is {{dias_suspensao}} rather than a literal, from docs/product.json's notice.suspendAfterDays through product.template_context(), because terms section 7 is the contractual floor and a template naming its own number is how two of them drift apart. The payment link is a [[se: tem_link]] block (templates/README.md section 8) because a null subscriptions.checkout_url is a state and a blank declared value is a MissingPlaceholder by design. Revival is real and is why the last line can be written at all: lib/asaas/entitlement.ts's grant path moves any non-cancelled row back to 'active' and re-grants users.plan, so paying the open charge does restore the access.
---

Olá, {{nome}}!

A cobrança do dia {{data_cobranca}} não foi paga em {{dias_suspensao}} dias corridos, então o acesso aos recursos pagos está suspenso e sua conta voltou ao plano Básico, como diz a seção 7 dos termos de uso.

Nada foi excluído. Suas empresas, seus favoritos e seu histórico continuam na sua conta.

Pagando a cobrança em aberto, o acesso volta[[se: tem_link]]: {{link_pagamento}}[[/se]].

Para ver ou cancelar a assinatura: {{link_assinatura}}
