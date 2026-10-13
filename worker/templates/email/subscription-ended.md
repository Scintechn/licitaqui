---
id: subscription-ended
channel: email
status: approved
subject: Sua assinatura do LicitaQui foi encerrada
placeholders: [data_encerramento, link_assinatura, nome, nome_plano]
partials: [partial-footer]
notes: Copy approved by Sci on 2026-10-13. Terms section 14 names "encerramento" among the five notices always sent by e-mail, and this is the first thing in the repository to answer it - the word appeared in no card and no template before F41. Sent by worker/licitaqui/billing.py, expire_subscriptions, for a subscription that is 'canceled' with ends_on already past: the day the paid period actually ran out, which is also the day expire() drops the account to Basico. Deliberately NOT the day somebody cancels - terms section 8 keeps the paid plan until ends_on, the plan screen already confirms the cancellation on the spot (billing.cancel.doneTitle), and a "your subscription has ended" e-mail arriving while it is still live would be false. Idempotent on billing_reminders (subscription, ends_on, kind = 'ended'). The sweep only looks back seven days, so the day this ships it cannot mail a cohort of long-expired subscriptions; that set is empty today (E8 measured `select count(*) from subscriptions` = 0 on 2026-10-05) and the window is what makes it safe if it ever is not. Says nothing about exporting data, though terms section 12 gives thirty days for it: the policy answers that through privacidade@licitaquiapp.com.br by hand, and no screen exports anything, so naming it here would promise a button that does not exist.
---

Olá, {{nome}}!

Sua assinatura do LicitaQui {{nome_plano}} foi encerrada em {{data_encerramento}}. Não haverá novas cobranças.

Sua conta continua existindo no plano Básico, que é gratuito. Nada foi excluído: suas empresas, seus favoritos e seu histórico seguem lá.

Se quiser voltar, você pode assinar de novo em {{link_assinatura}}.

Obrigado por ter usado a LicitaQui.
