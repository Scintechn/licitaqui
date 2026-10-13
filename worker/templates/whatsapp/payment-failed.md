---
id: payment-failed
channel: whatsapp
status: approved
subject: Não recebemos o pagamento da sua assinatura
placeholders: [data_cobranca, nome, valor_cobranca]
flags: [cartao, conta_liberada, pix]
notes: The additive WhatsApp copy of the payment notice. Sci, 2026-10-13 - "The payment notification should be send by email and whatsapp", and he approved this body the same day. Card F41. Same sentences as email/payment-failed.md, minus the two links - this goes as one Evolution sendButtons message, so the subject becomes the title, this body the description, and the single type url button points at the Asaas invoiceUrl with the label in WHATSAPP_BUTTON_TEXT. Asterisk bold on the label because WhatsApp renders it and an inbox does not. The payment link is NOT in this body - it is the button, which is the whole shape of this message, and Sci rejected a sentence pointing at it ("toque no botao") on 2026-10-12 as redundant beside a visible button. The method sentence matches email/payment-failed.md. IT IS NOT PIX ONLY, and that is the one way it differs from the charge reminder beyond the wording - Notice.whatsapp_pix_only is False here. The reminder skips a card subscriber because a card charges itself, which is the whole reason that gate exists; a card that FAILED is the opposite case, and the subscriber has to act either way. DELIVERY IS GATED OFF until F40 - politica-de-privacidade.md section 6 promises that replying SAIR stops this channel, the opt-out is keyed on a founders_list id and nothing enqueues the inbound job, so billing.py refuses the whole WhatsApp channel with no_optout_path. The e-mail is unaffected and is the channel terms section 14 obliges. Open against it - F40 (the SAIR path, which gates this), and section 14 itself, which says all five notices go by WhatsApp and needs a sentence from Sci saying which actually do.
---

Olá, {{nome}}!

A cobrança do dia {{data_cobranca}} ainda não foi paga.

*Valor:* {{valor_cobranca}}

[[se: conta_liberada]]Sua conta continua liberada.
[[/se]][[se: pix]]A cobrança por pix continua disponível para pagamento.
[[/se]][[se: cartao]]Vamos tentar novamente no seu cartão e avisamos você.

[[/se]]Se você já pagou, pode ignorar este aviso.
