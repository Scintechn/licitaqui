---
id: payment-failed
channel: email
status: approved
subject: Não recebemos o pagamento da sua assinatura do LicitaQui
placeholders: [data_cobranca, link_assinatura, link_pagamento, nome, nome_plano, valor_cobranca]
flags: [cartao, conta_liberada, pix, tem_link]
partials: [partial-footer]
notes: Terms section 7 ("Falha no pagamento: tentaremos novamente e avisaremos voce") and section 14, which names this notice as one of the five always sent by e-mail. Card F41. Sent by worker/licitaqui/billing.py, overdue_notice, a daily sweep over subscriptions.status = 'overdue' with the charge at next_charge_on still payable - the status is written by the Asaas webhook on PAYMENT_OVERDUE (lib/asaas/entitlement.ts), so this notice follows Asaas's own judgement of a missed due date rather than a clock of ours. Idempotent on billing_reminders (subscription, due_on, kind = 'payment_failed'), the key 0015 already anticipated. One omission is deliberate and is NOT a later left in a comment - it is card F42. Terms section 7 also promises that ten days after the vencimento the access is suspended and the account returns to Basico, and NOTHING WRITES THAT STATE: 0015's CHECK has it, lib/asaas/subscription.ts names it, and the plan screen has no sentence for it. Naming a suspension date in this message would be the register's own defect - a message promising a thing the product does not do, with a date on it. So this body states what is true today (the charge is open, the account is not), and F42 adds the sentence when it adds the behaviour. Copy approved by Sci on 2026-10-13, in the same pass as subscription-ended and subscription-suspended. One state to know about now that it sends - link_pagamento is subscriptions.checkout_url and is BLANK when no payable charge has been announced yet, and templates.py refuses a blank as hard as a missing one, so that subscriber's notice is unrenderable rather than wrong. The sweep is built for exactly that - nothing is claimed, the reason is logged as a placeholder name, and the row is swept again tomorrow, which is why this sweep's refusals are loud but never lost. F28 is the per-charge URL. Sci, 2026-10-13 - "For pix we need to notify the costomer for then proceed to the payment we only can notify it and send the payment link". So the middle sentence is per METHOD, flat rather than nested because CONDITIONAL_RE is non-greedy and a nested [[/se]] would close the outer block. pix says the charge is still open and why nothing will be debited; cartao keeps section 7's "tentaremos novamente", which is true of a tokenised card and false of a pix. An unknown method renders neither, and the notice still says the charge is unpaid and where to pay it. Four sentences are [[se]] blocks rather than always-on, which is templates/README.md section 8's rule and not a rewording - each one is byte-identical to the text Sci approved whenever its condition holds. (1) conta_liberada is false for a subscription that has never been paid, which after review's cohort fix is the whole of opening day - a pix founder who never pays is 'pending' for ever - and telling somebody their account is still unlocked when it was never unlocked is this register's own defect. (2) tem_link is false when subscriptions.checkout_url is null, which checkout.ts documents as a state rather than a fault; a blank is a MissingPlaceholder by design, so without the block that subscriber's notice would be refused every day and section 14's notice would never arrive. Also open against it: TO_VALIDATE H, because partial-footer tells the reader they are receiving this "porque autorizou o contato quando entrou na lista de fundadores", which is wrong for a notice terms section 7 obliges us to send.
---

Olá, {{nome}}!

A cobrança do LicitaQui {{nome_plano}} do dia {{data_cobranca}} ainda não foi paga.

Valor: {{valor_cobranca}}

[[se: conta_liberada]]Sua conta continua liberada.
[[/se]][[se: pix]]A cobrança por pix continua disponível para pagamento — o pix não é debitado automaticamente, então ela só é quitada quando você paga.
[[/se]][[se: cartao]]Vamos tentar novamente no seu cartão e avisamos você.
[[/se]][[se: tem_link]]Pagar agora: {{link_pagamento}}

[[/se]]Se você já pagou, pode ignorar este aviso.

Para ver ou cancelar a assinatura: {{link_assinatura}}
