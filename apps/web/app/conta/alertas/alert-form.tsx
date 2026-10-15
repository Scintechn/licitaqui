'use client'

import { useEffect, useState } from 'react'
import { Button, Select } from '@/components'
import { KeywordInput } from '@/components/keyword-input'
import { messages } from '@/lib/messages'
import { UF_CODES } from '@/lib/radar/ufs'
import type { Alert, AlertFormData } from '@/lib/alerts/types'
import { TenderPreviewList, type TenderPreviewItem } from '@/components/tender-preview-list'
import { getMatchingTenders } from '@/lib/alerts/matching-tenders'

const ufNames = messages.radar.ufNames

interface AlertFormProps {
  userId: number
  alert?: Alert | null
  limits: { keywords: number }
  onSubmit: (data: AlertFormData) => Promise<void>
  onCancel: () => void
  isLoading?: boolean
}

const FREQUENCY_OPTIONS = [
  { value: 'weekly', label: 'Semanal' },
]

export function AlertForm({
  userId,
  alert,
  limits,
  onSubmit,
  onCancel,
  isLoading = false,
}: AlertFormProps) {
  const [selectedStates, setSelectedStates] = useState<string[]>(alert?.states ?? [])
  const [keywords, setKeywords] = useState<string[]>(alert?.keywords ?? [])
  const [frequency, setFrequency] = useState(alert?.frequency ?? 'weekly')
  const [matchingTenders, setMatchingTenders] = useState<TenderPreviewItem[]>([])
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // Update preview whenever state or keywords change
  useEffect(() => {
    const updatePreview = async () => {
      if (selectedStates.length === 0 && keywords.length === 0) {
        setMatchingTenders([])
        return
      }

      setIsLoadingPreview(true)
      try {
        // For multiple states, we'd need to combine results or let the API handle it
        const results = await getMatchingTenders(
          userId,
          selectedStates[0] ?? '',
          keywords
        )
        setMatchingTenders(results)
      } catch (error) {
        console.error('Failed to fetch matching tenders:', error)
        setMatchingTenders([])
      } finally {
        setIsLoadingPreview(false)
      }
    }

    const timer = setTimeout(updatePreview, 800)
    return () => clearTimeout(timer)
  }, [userId, selectedStates, keywords])

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setFormError(null)

    // Validation
    if (keywords.length === 0) {
      setFormError('Adicione pelo menos uma palavra-chave')
      return
    }

    try {
      await onSubmit({
        keywords,
        states: selectedStates,
        frequency: frequency as 'daily' | 'weekly' | 'telegram',
        channel: 'telegram',
      })
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Erro ao salvar alerta')
    }
  }

  const keywordLimit = limits.keywords ?? 10

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      {formError && (
        <div className="rounded-control bg-error-soft border border-error-soft px-4 py-3">
          <p className="text-meta text-error">{formError}</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* LEFT: Form Section */}
        <div className="flex flex-col gap-4">
          {/* Frequency */}
          <div>
            <Select
              id="alert-frequency"
              name="frequency"
              label="Frequência"
              options={FREQUENCY_OPTIONS}
              value={frequency}
              onChange={(e) => setFrequency(e.currentTarget.value as 'daily' | 'weekly' | 'telegram')}
            />
            <p className="text-caption text-muted mt-1">
              Com que frequência você quer receber notificações
            </p>
          </div>

          {/* States Multi-Select */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <label className="block text-lead font-semibold">
                Estados (UF)
              </label>
              <span className="text-meta text-muted text-meta">
                {selectedStates.length === 0
                  ? 'Nenhum = Todo o Brasil'
                  : selectedStates.length === UF_CODES.length
                  ? 'Todos selecionados'
                  : `${selectedStates.length} selecionados`}
              </span>
              <button
                type="button"
                onClick={() => {
                  if (selectedStates.length === UF_CODES.length) {
                    setSelectedStates([])
                  } else {
                    setSelectedStates([...UF_CODES])
                  }
                }}
                className="text-blue text-meta font-semibold hover:text-blue-hover"
              >
                {selectedStates.length === UF_CODES.length ? 'Limpar' : 'Todos'}
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {UF_CODES.map((code) => (
                <label key={code} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    value={code}
                    checked={selectedStates.includes(code)}
                    onChange={(e) => {
                      if (e.currentTarget.checked) {
                        setSelectedStates([...selectedStates, code])
                      } else {
                        setSelectedStates(selectedStates.filter(s => s !== code))
                      }
                    }}
                    className="w-4 h-4 rounded border border-field-line"
                  />
                  <span className="text-meta">{ufNames[code as keyof typeof ufNames] || code}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Keywords Input */}
          <div>
            <label className="block text-lead font-semibold mb-2">
              Palavras-chave {keywordLimit > 1 && `(máx ${keywordLimit})`}
            </label>
            <KeywordInput
              keywords={keywords}
              maxKeywords={keywordLimit}
              onChange={setKeywords}
              placeholder="Digite uma palavra-chave e pressione Enter"
            />
            <p className="text-caption text-muted mt-1">
              O alerta vai buscar qualquer um desses termos nos editais
            </p>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-2 pt-4">
            <Button type="submit" disabled={isLoading}>
              {isLoading ? 'Salvando...' : alert ? 'Atualizar alerta' : 'Criar alerta'}
            </Button>
            <Button type="button" variant="secondary" onClick={onCancel}>
              Cancelar
            </Button>
          </div>
        </div>

        {/* RIGHT: Preview Section */}
        <div className="flex flex-col gap-3 lg:border-l lg:border-line lg:pl-6">
          <p className="text-caption font-mono uppercase text-muted">Preview</p>
          <TenderPreviewList
            tenders={matchingTenders}
            isLoading={isLoadingPreview}
            isEmpty={selectedStates.length === 0 && keywords.length === 0}
            emptyMessage={
              selectedStates.length === 0 && keywords.length === 0
                ? 'Configure o estado e palavras-chave para ver exemplos de editais.'
                : 'Nenhum edital compatível com sua busca.'
            }
          />
        </div>
      </div>
    </form>
  )
}
