'use client'

import { useRef, useState } from 'react'

export interface KeywordInputProps {
  keywords: string[]
  maxKeywords: number
  onChange: (keywords: string[]) => void
  placeholder?: string
}

/**
 * Tag-based keyword input component.
 * Users type and press Enter or click Add to add keywords.
 * Keywords shown as removable pills/chips.
 */
export function KeywordInput({
  keywords,
  maxKeywords,
  onChange,
  placeholder = 'Digite uma palavra-chave',
}: KeywordInputProps) {
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const remaining = maxKeywords - keywords.length

  const handleAddKeyword = () => {
    const trimmed = input.trim().toLowerCase()
    if (
      trimmed &&
      !keywords.includes(trimmed) &&
      keywords.length < maxKeywords
    ) {
      onChange([...keywords, trimmed])
      setInput('')
      inputRef.current?.focus()
    }
  }

  const handleRemoveKeyword = (index: number) => {
    onChange(keywords.filter((_, i) => i !== index))
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleAddKeyword()
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2 items-end">
        <div className="flex-1">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={remaining === 0}
            className="w-full px-3 py-2 rounded-control border border-field-line bg-surface text-body leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue focus:border-transparent disabled:bg-fill-muted disabled:text-muted"
            maxLength={50}
          />
        </div>
        <button
          type="button"
          onClick={handleAddKeyword}
          disabled={!input.trim() || remaining === 0}
          className="px-4 py-2 rounded-control bg-blue text-white font-semibold text-lead hover:bg-blue-hover disabled:bg-fill-muted disabled:text-muted transition-colors"
        >
          +
        </button>
      </div>

      {/* Keyword pills */}
      {keywords.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {keywords.map((keyword, index) => (
            <div
              key={index}
              className="flex items-center gap-2 px-3 py-1 rounded-pill bg-blue-soft border border-blue-line"
            >
              <span className="text-meta font-medium text-blue">{keyword}</span>
              <button
                type="button"
                onClick={() => handleRemoveKeyword(index)}
                className="flex items-center justify-center w-5 h-5 rounded-pill hover:bg-blue-line text-blue transition-colors"
                aria-label={`Remover ${keyword}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Remaining count */}
      <p className="text-caption text-muted">
        {remaining === maxKeywords
          ? `Até ${maxKeywords} palavras-chave`
          : `${remaining} ${remaining === 1 ? 'palavra-chave' : 'palavras-chave'} restante${remaining === 1 ? '' : 's'}`}
      </p>
    </div>
  )
}
