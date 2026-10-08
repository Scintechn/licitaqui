---
id: charge-reminder
channel: email
status: draft
placeholders: [data_cobranca, email_contato, link_assinatura, nome, nome_plano, valor_cobranca]
partials: [partial-footer]
notes: Spec section 10 and terms section 7. Job charge_reminder sweeps daily and enqueues send_billing_email once per (subscription, due date) - the billing_reminders primary key IS that idempotency, so this is never sent twice for one charge and never for a cancelled subscription. Asaas customer notifications are disabled because Asaas bills us per message, so this is the only warning a subscriber gets before the money leaves.
---

TODO(Sci): este arquivo está sem corpo e sem assunto de propósito. Falta a cópia, que é sua (brief jurídico §5). O aviso de 3 dias antes da cobrança é uma cláusula do contrato (termos §7) e é prometido em cinco lugares — `foundersPage.founderValue.comparisonRows.3.us`, `foundersPage.faq.columns.1.2.a`, `notifications.billingHelp`, `radar.landing.plans.body` e `radar.landing.guarantees.2.body` — além do e-mail de boas-vindas dos fundadores, que já foi entregue. São duas frases: (1) o `subject:` do front matter, e (2) o corpo, que por spec §10 precisa dizer a data e o valor da cobrança. Os seis placeholders acima já estão ligados pelo remetente (`worker/licitaqui/billing.py`, `build_context`) e testados: `{{nome}}`, `{{nome_plano}}`, `{{data_cobranca}}` (dd/mm/aaaa, no fuso do produto), `{{valor_cobranca}}` (R$ 57,00), `{{link_assinatura}}` (`/conta/plano`, onde se cancela em um clique) e `{{email_contato}}`. Enquanto este TODO estiver aqui, `Template.ready_to_send` é falso, a varredura não grava nada, não enfileira nada, registra `billing.reminder_blocked` com o número de assinantes que teriam recebido, e loga em ERROR. Ver também `docs/TO_VALIDATE.md` item B: `radar.landing.guarantees.2.body` diz "renovação" onde os termos dizem "cobrança".
