---
id: charge-reminder
channel: whatsapp
status: approved
subject: Sua cobrança do LicitaQui é dia {{data_cobranca}}
placeholders: [data_cobranca, fim_ciclo, inicio_ciclo, nome, nome_plano, valor_cobranca]
notes: The additive WhatsApp copy of the charge notice, authorised by terms section 7 - "Se voce tiver conectado WhatsApp ou Telegram, avisamos tambem por la" - with e-mail the required channel and section 12 the official one. Same sentences as email/charge-reminder.md, approved by Sci on 2026-10-12, with asterisk bold on the two labels because WhatsApp renders it and an inbox does not. Sent by worker/licitaqui/billing.py (send_charge_notice_whatsapp) as one Evolution sendButtons message - subject becomes the message title, this body the description, and the single type url button points at the Asaas invoiceUrl with the label in WHATSAPP_BUTTON_TEXT. Deliberately no "toque no botao": Sci called it redundant beside a visible button, and it is the exact sentence rpatinacao's customer received on 2026-06-09 with no button under it. Deliberately no "responda SAIR" either - this notice is a term of the contract and notifications.billingHelp says the billing messages cannot be switched off, so promising an opt-out here would be a sentence the product does not mean; a recorded SAIR still suppresses this copy, and the e-mail still goes. Only a Pix subscriber receives it: a card charges itself. Open against it: docs/TO_VALIDATE.md item G (consent.whatsapp names the founder seat and editais, not billing).
---

Olá, {{nome}}!

Sua próxima cobrança do LicitaQui {{nome_plano}} é no dia {{data_cobranca}}.

*Valor:* {{valor_cobranca}}
*Período:* {{inicio_ciclo}} a {{fim_ciclo}}
