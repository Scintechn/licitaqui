---
id: charge-reminder
channel: whatsapp
status: approved
subject: Sua cobrança do LicitaQui é dia {{data_cobranca}}
placeholders: [data_cobranca, fim_ciclo, inicio_ciclo, nome, nome_plano, valor_cobranca]
notes: The additive WhatsApp copy of the charge notice, authorised by terms section 7 - "Se voce tiver informado um celular com WhatsApp, avisamos tambem por la" (v1.4, 13/10/2026; it said "conectado" until then, a condition nothing in the product could satisfy) - with e-mail the required channel and section 14 the official one. Same sentences as email/charge-reminder.md, approved by Sci on 2026-10-12, with asterisk bold on the two labels because WhatsApp renders it and an inbox does not. Sent by worker/licitaqui/billing.py (send_charge_notice_whatsapp) as one Evolution sendButtons message - subject becomes the message title, this body the description, and the single type url button points at the Asaas invoiceUrl with the label in WHATSAPP_BUTTON_TEXT. Deliberately no "toque no botao": Sci called it redundant beside a visible button, and it is the exact sentence rpatinacao's customer received on 2026-06-09 with no button under it. No "responda SAIR" in the body, and that reasoning is now inverted rather than merely absent: it said an opt-out "would be a sentence the product does not mean", and since 13/10/2026 politica-de-privacidade.md section 6 promises exactly that opt-out - "Voce pode pedir para parar de recebe-los no WhatsApp respondendo SAIR". Review then found the promise is undeliverable: the opt-out is keyed on a founders_list id and nothing enqueues the inbound job, so a SAIR reaches no code at all. The channel is therefore gated off (billing.py, _optout_is_enforceable, skip reason no_optout_path) until F40 builds it. Whether this body should then carry the word SAIR is a copy decision for Sci, not an omission to fix here - a subscriber reading only this message would otherwise never learn it. Only a Pix subscriber receives it: a card charges itself. Open against it: F40 (the SAIR path, which gates this channel) and F37 (consent.whatsapp still renders nowhere). TO_VALIDATE item G is resolved - the charge notice rests on execucao de contrato now, so no consent string governs it.
---

Olá, {{nome}}!

Sua próxima cobrança do LicitaQui {{nome_plano}} é no dia {{data_cobranca}}.

*Valor:* {{valor_cobranca}}
*Período:* {{inicio_ciclo}} a {{fim_ciclo}}
