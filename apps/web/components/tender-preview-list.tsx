/**
 * Preview of matching tenders for the alert preferences.
 * Shows real tenders matching the selected state and keywords.
 */

export interface TenderPreviewItem {
  id: string
  title: string
  location: string
  value: string
  deadline: string
  matchType: 'compatible' | 'check' // 'compatible' for green checkmark, 'check' for verification needed
}

export interface TenderPreviewListProps {
  tenders: TenderPreviewItem[]
  isLoading?: boolean
  isEmpty?: boolean
  emptyMessage?: string
}

export function TenderPreviewList({
  tenders,
  isLoading = false,
  isEmpty = false,
  emptyMessage = 'Nenhum edital compatível com sua busca.',
}: TenderPreviewListProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 mb-2">
        <p className="font-mono text-caption uppercase text-muted">Exemplos que combinam</p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-6 text-muted">
          <p className="text-meta">Buscando editais...</p>
        </div>
      ) : isEmpty || tenders.length === 0 ? (
        <div className="flex items-center justify-center py-6 px-4 bg-fill-muted rounded-card border border-line text-muted">
          <p className="text-meta text-center">{emptyMessage}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {tenders.map((tender) => (
            <div
              key={tender.id}
              className="flex gap-3 p-3 rounded-card bg-surface border border-line hover:border-blue-line transition-colors"
            >
              {/* Icon */}
              <div className="flex-shrink-0 mt-0.5">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-blue"
                >
                  <path d="M7 3h7l5 5v13H7z" />
                  <path d="M14 3v5h5M10 13h6M10 17h6" />
                </svg>
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <p className="text-lead font-semibold line-clamp-1">{tender.title}</p>
                    <p className="text-caption text-muted mt-0.5">{tender.location}</p>
                  </div>

                  {/* Status badge */}
                  {tender.matchType === 'compatible' ? (
                    <div className="flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded-badge bg-success-soft border border-blue-line">
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        className="text-success"
                      >
                        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                      </svg>
                      <span className="text-caption font-medium text-success">Compatível</span>
                    </div>
                  ) : (
                    <div className="flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded-badge bg-attention-soft border border-attention-line">
                      <span className="text-caption font-medium text-attention">Verificar</span>
                    </div>
                  )}
                </div>

                <p className="text-caption text-muted mt-2">{tender.value} · {tender.deadline}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
