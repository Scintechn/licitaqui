export type AlertFrequency = 'daily' | 'weekly' | 'telegram'
export type AlertChannel = 'telegram' | 'email' | 'webhook'
export type AlertKind = 'keyword' | 'cnae' | null

export interface Alert {
  id: number
  userId: number
  kind: AlertKind
  keywords: string[]
  states: string[]
  channel: string
  frequency: AlertFrequency
  active: boolean
}

export interface AlertFormData {
  keywords: string[]
  states: string[]
  frequency: AlertFrequency
  channel: AlertChannel
}

export interface AlertLimits {
  keywords: number
  perWeek?: number
}
