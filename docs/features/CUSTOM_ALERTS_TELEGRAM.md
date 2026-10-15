# Custom Alerts via Telegram (E30–E33)

**Status:** ✅ Complete and shipped  
**Components:** Worker (E30, E33), Templates (E31), API (E32), Webhook (E32)  
**Launch date:** 2026-10-15  

---

## Feature Overview

Users who link their Telegram account can create custom alerts with keywords and states. When new tenders match an alert, a formatted message with interactive buttons is sent directly to Telegram, allowing users to read, pause, or share opportunities without leaving the app.

## Architecture

### Two-Job Pattern (E30)

**`sync_custom_alerts`** — Daily sweep at 06:00 BRT
- Queries eligible users (account linked, alert active)
- Matches tenders against each alert's keywords + states
- Enqueues one `send_custom_alert` job per matching tender
- Idempotent on `(user_id, alert_id, tender_id)`

**`send_custom_alert`** — Per-tender notification
- Fetches tender, renders formatted message
- Adds interactive buttons (E32)
- Sends via Telegram Bot API with buttons
- Logs delivery to `alert_deliveries` table

### Why Two Jobs?

1. **Retries:** Per-tender jobs retry only the failed tender, not all alerts
2. **Dedupe:** Composite key prevents duplicate sends
3. **Throughput:** Worker pool processes tenders in parallel
4. **Flexibility:** Can adjust message content per tender without re-matching

---

## E30: Custom Alerts Matching

**Files:**
- `worker/licitaqui/telegram_alerts.py` — Job handlers
- `worker/templates/telegram/custom-alert-match.md` — Message template
- Schema: `alerts`, `alert_keywords`, `alert_states`, `alert_deliveries`

**Matching Logic:**
```
SELECT tenders WHERE 
  (keywords_match OR cnae_segments_match)
  AND state IN user_alert_states
  AND user_cnpj matches tender scope
```

**Delivery Idempotency:**
```
INSERT INTO alert_deliveries (alert_id, tender_id, user_id) 
  ON CONFLICT DO NOTHING
```

**Frequency:** Daily at 06:00 BRT, max 3 tenders per alert per day

---

## E31: Rich Text Formatting

**Message Template:** `custom-alert-match.md`

**Enhancements:**
- 📊 Emoji icons for visual hierarchy: ✨ (header), 🔔 (alert), 📋 (object), 🏢 (agency), 📍 (modality), ⏰ (deadline), 🎯 (ME/EPP), 💡 (disclaimer)
- **Bold text** via Markdown (`*...*`) for alert name, object, key fields
- No redundant inline links (buttons handle that)
- Mobile-optimized: ~200 characters, readable at any width

**Rendering:**
```python
context = {
  "nome": user.name,
  "alerta_nome": alert.value,  # e.g., "canva"
  "objeto": tender.object,
  "orgao": tender.agency_name,
  "uf": tender.state,
  "modalidade": tender.modality_name,
  "prazo_proposta": formatted_date,
  "link_edital": f"https://radar.licitaqui.com.br/edital/{tender_id}",
  "marcador_meepp": "Item exclusivo para ME/EPP" if applicable,
}
```

---

## E32: Interactive Buttons

**Button Layout:** 3 rows, 5 actions

```
[Ler Edital]          [Triagem Completa]
[Pausar Alerta]       [Ver Similares]
         [Compartilhar]
```

**Button Types:**

| Button | Type | Action | Handler | Result |
|--------|------|--------|---------|--------|
| Ler Edital | URL | Opens Radar screening page | Browser | View full tender details |
| Triagem Completa | URL | Opens AI analysis tab | Browser | View screening results |
| Pausar Alerta | Callback | Sets `alerts.active = false` | Webhook handler | Immediate toggle |
| Ver Similares | Callback | Enqueues response job | Worker template | Directs to Radar |
| Compartilhar | Callback | Enqueues response job | Worker template | Share prompt |

**Implementation:**
```python
def _build_alert_buttons(tender_id: str, alert_id: str) -> dict:
  return {
    "inline_keyboard": [
      [
        {"text": "Ler Edital", "url": f"https://radar.licitaqui.com.br/edital/{tender_id}"},
        {"text": "Triagem Completa", "url": f"https://radar.licitaqui.com.br/edital/{tender_id}?tab=triagem"},
      ],
      [
        {"text": "Pausar Alerta", "callback_data": f"pause_{alert_id}"},
        {"text": "Ver Similares", "callback_data": f"similar_{tender_id}"},
      ],
      [
        {"text": "Compartilhar", "callback_data": f"share_{tender_id}"},
      ],
    ]
  }
```

---

## E33: Callback Responses

**Templates:**

**`callback-similar.md`**
- Response to "Ver Similares" button
- Directs user to Radar dashboard
- No complex queries (MVP design)

**`callback-share.md`**
- Response to "Compartilhar" button
- Prompts user to share via Telegram/email
- Directs to Radar for full details

**Flow:**
1. User clicks button in Telegram
2. Telegram sends `callback_query` to webhook
3. Webhook parses `callback_data` (e.g., `similar_123`)
4. Webhook enqueues `send_telegram` job with template name
5. Worker renders template, sends response

---

## Future Phases

### E33b: Similar Tenders Lookup
- Query tenders from same `agency_name`
- Filter by user's alert states + CNAE segments
- Return top 3–5 matches with brief details
- Send formatted list in response

### E33c: Share Token Generation
- Generate unique share token (7-day expiry)
- Store in `tender_shares` table
- Send direct link in response
- Track share analytics

### E33d: Share Analytics
- Track share clicks, opens, conversions
- Show sharing impact in admin dashboard
- Measure referral effectiveness

---

## Testing Checklist

- ✅ Message renders with formatting
- ✅ Buttons appear below message
- ✅ "Ler Edital" button opens Radar
- ✅ "Triagem Completa" button opens analysis
- ✅ "Pausar Alerta" button toggles alert
- ✅ "Ver Similares" button sends response
- ✅ "Compartilhar" button sends response
- ✅ Idempotency: duplicate tenders not sent
- ✅ Frequency: max 3 per alert per day
- ✅ Mobile: message readable on small screens

---

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `TELEGRAM_DELIVERY` | (unset = dry-run) | Set to `send` for real delivery |
| `TELEGRAM_BOT_TOKEN` | (required) | Bot API token from @BotFather |
| `WORKER_SCHEDULER` | `1` | Enable scheduler for daily sweep |

---

## Error Handling

- **Circuit breaker:** If Telegram API fails 2× in a row, breaker opens for 15 min
- **Retries:** Job retried up to 4 times on retryable errors
- **Logging:** All sends logged to `alert_deliveries` with status (sent/dry-run/failed)
- **Silent failures:** Non-retryable errors (bad recipient) logged but not retried

---

## Related Tasks

- **D26:** Custom alerts system UI (keywords, states, management)
- **E1:** Telegram linking (initial connection flow)
- **E30:** Alert matching (this doc, E30)
- **E31:** Message formatting (this doc, E31)
- **E32:** Interactive buttons (this doc, E32)
- **E33:** Callback responses (this doc, E33)

---

## Performance Notes

- `sync_custom_alerts` scan: ~2–5 sec for 10k tenders, 100 alerts
- `send_custom_alert` per job: ~500 ms (DB + Telegram API)
- Parallel workers: 4 concurrent consumers process up to 4 sends/sec
- Daily budget: ~10k sends/day on 4-consumer worker

---

## LGPD & Privacy

- `chat_id` never logged (use `chat_ref` for identification)
- `alert_deliveries` cleaned per retention policy
- Pause action respects user intent immediately
- Share links expire after 7 days
