---
id: partial-digest-item
channel: telegram
status: draft
placeholders: [objeto, orgao, uf, modalidade, prazo_proposta, marcador_meepp, link_edital]
notes: One tender inside telegram/weekly-digest. marcador_meepp is a ready line such as "Item exclusivo para ME/EPP", or an empty string - the worker decides, the template does not.
---

*{{objeto}}*
{{orgao}} — {{uf}} · {{modalidade}}
Propostas até {{prazo_proposta}}
{{marcador_meepp}}
Ler o edital: {{link_edital}}
