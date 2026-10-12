---
id: charge-reminder
channel: email
status: approved
subject: Sua cobrança do LicitaQui é dia {{data_cobranca}}
placeholders: [data_cobranca, fim_ciclo, inicio_ciclo, nome, nome_plano, valor_cobranca]
partials: [partial-footer]
notes: Spec section 10 and terms section 7. Copy approved by Sci on 2026-10-12, with three things asked of it - print the subscriber's name, state the new cycle from-date to-date, and no "toque no botao", which is redundant beside a visible button and exists in the reference repo only because their button sometimes vanished. Job charge_reminder sweeps daily and enqueues send_billing_email once per (subscription, due date) - the billing_reminders primary key IS that idempotency, so this is never sent twice for one charge and never for a cancelled subscription. Asaas customer notifications are disabled because Asaas bills us per message, so this is the only warning a subscriber gets before the money leaves. The WhatsApp copy of this notice is whatsapp/charge-reminder.md and carries the same sentences plus one url button; terms section 7 makes e-mail the required channel and WhatsApp additive. All six placeholders are bound by worker/licitaqui/billing.py, build_context, and partial-footer's three are bound there too - see the link_preferencias comment, which is the defect that would otherwise have cost one cohort of reminders on the day this copy landed. Open against this file: docs/TO_VALIDATE.md item B (radar.landing.guarantees.2.body says "renovacao" where the terms say "cobranca"), item C (notifications.billingHelp lists two un-disableable billing messages and this is a third) and item H (the footer's unsubscribe sentence, which is wrong for a notice that cannot be switched off). F22 is the open correctness dependency: data_cobranca binds from subscriptions.next_charge_on.
---

Olá, {{nome}}!

Sua próxima cobrança do LicitaQui {{nome_plano}} é no dia {{data_cobranca}}.

Valor: {{valor_cobranca}}
Período: {{inicio_ciclo}} a {{fim_ciclo}}
