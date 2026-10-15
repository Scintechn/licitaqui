'use client'

import { useEffect, useState } from 'react'
import { Button, Select } from '@/components'
import { KeywordInput } from '@/components/keyword-input'
import { TenderPreviewList, type TenderPreviewItem } from '@/components/tender-preview-list'
import { messages } from '@/lib/messages'
import { UF_OPTIONS } from '@/lib/radar/ufs'
import { getMatchingTenders } from '@/lib/alerts/matching-tenders'
import { type AlertLimits } from '@/lib/telegram/quota'

const prefs = messages.notifications

export interface AlertsPreferencesFormProps {
  userId: number
  limits: AlertLimits
  states: string[]
  keywords: string[]
  saveAction: (formData: FormData) => void | Promise<void>
}

/**
 * Integrated alerts preferences form with live tender preview.
 *
 * Shows:
 * - State (UF) selector
 * - Tag-based keyword input
 * - Live preview of matching tenders (top 3)
 *
 * Layout:
 * - Desktop: 2 columns (form left, preview right)
 * - Mobile: Stacked (form top, preview bottom)
 */
export function AlertsPreferencesForm({
  userId,
  limits,
  states: initialStates,
  keywords: initialKeywords,
  saveAction,
}: AlertsPreferencesFormProps) {
  const [selectedState, setSelectedState] = useState(initialStates[0] ?? '')
  const [keywords, setKeywords] = useState(initialKeywords)
  const [matchingTenders, setMatchingTenders] = useState<TenderPreviewItem[]>([])
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)

  // Update preview whenever state or keywords change
  useEffect(() => {
    const updatePreview = async () => {
      if (!selectedState && !keywords.length) {
        setMatchingTenders([])
        return
      }

      setIsLoadingPreview(true)
      try {
        const results = await getMatchingTenders(userId, selectedState, keywords)
        setMatchingTenders(results)
      } catch (error) {
        console.error('Failed to fetch matching tenders:', error)
        setMatchingTenders([])
      } finally {
        setIsLoadingPreview(false)
      }
    }

    // Debounce updates (wait 500ms after last change)
    const timer = setTimeout(updatePreview, 500)
    return () => clearTimeout(timer)
  }, [userId, selectedState, keywords])

  const handleSave = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)

    // Ensure state is properly set in formData
    formData.set('uf', selectedState)

    // Ensure keywords are properly set (clear old values and add current ones)
    formData.delete('palavra')
    keywords.forEach((kw) => formData.append('palavra', kw))

    await saveAction(formData)
  }

  const keywordLimit = limits.keywords ?? 0

  return (
    <form onSubmit={handleSave} className="flex flex-col gap-4 lg:gap-6">
      {/* Container for responsive layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* LEFT: Form Section */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3">
            <p className="text-meta leading-relaxed text-muted">{prefs.digestHelp}</p>

            {/* State Select */}
            <Select
              id="alerta-uf"
              name="uf"
              label="UF onde você entrega"
              options={UF_OPTIONS}
              value={selectedState}
              onChange={(e) => setSelectedState(e.currentTarget.value)}
            />

            {/* Keyword Input */}
            {keywordLimit > 0 && (
              <div>
                <label className="block text-lead font-semibold mb-2">
                  Palavras-chave {keywordLimit > 1 && `(máx ${keywordLimit})`}
                </label>
                <KeywordInput
                  keywords={keywords}
                  maxKeywords={keywordLimit}
                  onChange={setKeywords}
                  placeholder="Digite uma palavra-chave"
                />
              </div>
            )}
          </div>

          {/* Save Button */}
          <Button type="submit" variant="secondary" className="mt-2 lg:mt-4">
            {messages.common.save}
          </Button>
        </div>

        {/* RIGHT: Preview Section */}
        <div className="flex flex-col gap-3 lg:border-l lg:border-line lg:pl-6">
          <TenderPreviewList
            tenders={matchingTenders}
            isLoading={isLoadingPreview}
            isEmpty={!selectedState && !keywords.length}
            emptyMessage={
              !selectedState && !keywords.length
                ? 'Selecione um estado ou adicione palavras-chave para ver exemplos.'
                : 'Nenhum edital compatível com sua busca.'
            }
          />
        </div>
      </div>
    </form>
  )
}
