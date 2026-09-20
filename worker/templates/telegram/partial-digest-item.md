---
id: partial-digest-item
channel: telegram
status: draft
placeholders: [objeto, orgao, uf, modalidade, prazo_proposta, marcador_meepp, link_edital]
flags: [tem_meepp]
notes: One tender inside telegram/weekly-digest. marcador_meepp is a ready line such as "Item exclusivo para ME/EPP" - the worker decides the wording from me_epp_summary (exclusive/quota/mixed), the template does not. It is guarded by tem_meepp because a blank placeholder raises; with the flag false the line is removed before substitution and the worker passes nothing.
---

*{{objeto}}*
{{orgao}} — {{uf}} · {{modalidade}}
Propostas até {{prazo_proposta}}
[[se: tem_meepp]]{{marcador_meepp}}
[[/se]]Ler o edital: {{link_edital}}
