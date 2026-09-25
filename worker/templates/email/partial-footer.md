---
id: partial-footer
channel: email
status: approved
placeholders: [email_contato, link_privacidade, link_preferencias]
notes: Appended to every e-mail. Approved by Sci on 2026-09-25, answering the two questions that stood here as pending items. (1) The contact address is contato@licitaquiapp.com.br, the same value as `support.email` in pt-BR.json, so the sender binds `email_contato` from there rather than duplicating it. (2) The footer does carry the company identification, reusing `foundersPage.footer.company` verbatim so the CNPJ and contact details live in one place. Sci also confirmed the terms and privacy policy are validated and published (/termos and /privacidade are generated from docs/legal at build time), which is what the removed item was waiting on. One binding remains for the e-mail sender (E6): `link_preferencias` resolves to the alerts screen for Telegram (telegram_alerts.py:781), and that screen requires a session. A founder has no account, so an unsubscribe link they cannot open would not honour the sentence above it; WhatsApp answers this with 'responda SAIR' and the e-mail channel has no equivalent yet.
---

—
LicitaQui · encontre o edital que a sua empresa consegue atender.

Você recebe este e-mail porque autorizou o contato quando entrou na lista de fundadores da LicitaQui. Para parar de receber, use {{link_preferencias}}.

Para pedir a correção ou a exclusão dos seus dados, escreva para {{email_contato}}.
Política de privacidade e termos de uso: {{link_privacidade}}

LicitaQui é um produto da Scint Tecnologia Serviços Ltda · CNPJ 36.955.612/0001-85 · contato@licitaquiapp.com.br · WhatsApp (11) 96246-0678
