# Architecture decision records

One file per decision, named `NNNN-short-slug.md`, numbered in the order they were accepted
and never renumbered. Each records the context, the decision, its consequences, and what
would change it later. A decision that is later replaced stays in place with its status
changed to `Superseded by ADR-NNNN`; ADRs are a log, not a wiki.

Decisions backed by a measurement must quote the measured numbers and the sample size, so a
reader can tell a result from an opinion.

| ADR | Date | Status | Decision |
|---|---|---|---|
| [0001](0001-pncp-incremental-sync-endpoint.md) | 2026-09-17 | Accepted | The PNCP incremental sync is built on the Consulta API's `/v1/contratacoes/atualizacao`, with the search API as the fallback (gap G7) |
| [0002](0002-cnpj-lookup-via-brasilapi.md) | 2026-09-17 | Accepted | Company lookup uses BrasilAPI's CNPJ endpoint, with the manual CNAE form as the fallback (gap G8) |
