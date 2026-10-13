---
id: subscription-suspended
channel: email
status: approved
subject: Sua assinatura do LicitaQui está suspensa
placeholders: [data_cobranca, dias_suspensao, link_assinatura, nome]
partials: [partial-footer]
notes: Terms section 7's ten-day suspension and section 14's fifth notice. Copy approved by Sci on 2026-10-13, and approved is NOT sendable here. READ THIS BEFORE WIRING IT - NOTHING SENDS THIS TEMPLATE, AND THAT IS CARD F42, NOT AN OVERSIGHT. The state it announces does not exist: 'suspended' is in 0015's CHECK and in lib/asaas/subscription.ts's vocabulary and is written by no code at all, which three separate comments in this repository already say. It is drafted here with F41's other two so Sci reads the five notices of section 14 in one pass, and F42 is what makes it sendable. F42 carries the two joins that are not SQL - the plan screen has no sentence for a suspended subscription (statusLine() falls through to "Aguardando o pagamento", which for a suspended account understates what happened, and billing.status.suspended does not exist in pt-BR.json), and plan-view.tsx's `cancellable` excludes 'suspended', so writing the state would take away the one-click cancel terms section 8 promises. Both are copy or product decisions, so both are Sci's. The number of days is {{dias_suspensao}} rather than a literal, from docs/product.json's notice.suspendAfterDays through product.template_context(), because terms section 7 is the contractual floor and a template naming its own number is how two of them drift apart. There is no payment link in this body any more, and that is the ruling rather than a simplification - the charge is gone. 2026-10-13, in two steps. Sci approved this body, then ruled how a suspension ends - which falsified its revival line, so the line carried a TODO(Sci) until he chose between terminating and pausing. He chose TERMINATE: a suspension for non-payment downgrades the account to Basico AND deletes the Asaas subscription, and the way back is a new subscription. The last line is his wording from that choice. It also cost the line under it - "Para ver ou cancelar a assinatura" - which is a deletion rather than a rewording and the reason is the same ruling: there is no assinatura left to cancel, and it pointed at the identical URL twice. Asaas's own documentation says DELETE /v3/subscriptions/{id} also removes the pending or overdue charges linked to it (paid ones stay), so after that there is literally no cobranca em aberto to pay. Everything below about revival describes the behaviour BEFORE that ruling and is kept because it is still true of a subscription that is merely overdue. Revival is real for an overdue subscription and is why the last line can be written at all: lib/asaas/entitlement.ts's grant path moves any non-cancelled row back to 'active' and re-grants users.plan, so paying the open charge does restore the access.
---

Olá, {{nome}}!

A cobrança do dia {{data_cobranca}} não foi paga em {{dias_suspensao}} dias corridos, então o acesso aos recursos pagos está suspenso e sua conta voltou ao plano Básico, como diz a seção 7 dos termos de uso.

Nada foi excluído. Suas empresas, seus favoritos e seu histórico continuam na sua conta.

A assinatura foi encerrada e não haverá novas cobranças. Quando quiser voltar, você pode assinar de novo em {{link_assinatura}}.
