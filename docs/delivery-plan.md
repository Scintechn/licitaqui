# LicitaQui Login & Account UX/UI Redesign
## Delivery Plan

**Status:** Ready for Implementation  
**Total Effort:** 42–55 hours (1.5 weeks with 3 engineers, or 2–3 weeks with 1 engineer)  
**Date:** 2026-10-14  

---

## Executive Summary

Redesign the login journey and consolidate fragmented account pages into a unified dashboard. After login, users redirect to `/radar` (discovery) instead of `/conta/perfil` (profile). All account information is accessible in one place with sidebar or tab navigation.

**Scope:**
- ✅ Improve login UX (split-screen design)
- ✅ Post-login redirect logic (`/radar` + optional welcome)
- ✅ Unified account dashboard consolidating Perfil, Empresa, Plano
- ✅ Keep `/conta/alertas` separate (Telegram preferences)
- ✅ Backward-compatible redirects for old URLs

---

## 1. Login Page Redesign (`/conta/criar`)

### Design Pattern
**Split-screen layout** (inspired by Asaas, SaleSkip, Magnific references):
- **Left (50%):** Brand story with logo, value proposition, illustrations/background
- **Right (50%):** Sign-in form (email, password, forgot password, OAuth, create account)

### Responsive Behavior
- **Desktop (1024px+):** Side-by-side layout
- **Tablet (640px–1024px):** Stack vertically, form takes priority
- **Mobile (<640px):** Full-screen form, brand section collapses/stacks below

### New Components
```
components/login-split-screen.tsx       (Main layout)
components/login-brand-side.tsx         (Left: story)
components/login-form-side.tsx          (Right: form)
components/login-split-screen.test.tsx  (Tests)
```

### Modified Files
```
app/conta/criar/sign-in-view.tsx        (Use new split-screen component)
app/conta/criar/page.tsx                (Minor adjustments)
```

### Effort
**6–8 hours**

### Success Criteria
- ✅ Form remains functional (Google OAuth, email/password, forgot password links)
- ✅ Layouts stack correctly at breakpoints
- ✅ No login logic changes
- ✅ Mobile-friendly below 640px

---

## 2. Unified Account Dashboard (`/conta`)

### Architecture
Consolidate three pages into one dashboard:
- `/conta/perfil` (Personal details) → **Account tab**
- `/conta/empresa` (Company info) → **Company tab**
- `/conta/plano` (Plan & billing) → **Plan & Billing tab**
- `/conta/alertas` → **UNCHANGED** (separate page)

### Navigation
- **Desktop:** Sidebar with 4 options (Account, Company, Plan & Billing, Privacy)
- **Mobile:** Tab navigation or collapsible menu (same sections)
- **Active state:** Highlight current section

### Sections & Fields

| Section | Fields | Source | Notes |
|---------|--------|--------|-------|
| **Account** | Name, Email, Birth Date, Phone | `/conta/perfil` | Editable inline |
| **Company** | CNPJ, Legal Name, Trade Name, CNAE | `/conta/empresa` | Lookup + edit |
| **Plan & Billing** | Current plan, quota, subscribe button, cancel link | `/conta/plano` | Same logic |
| **Privacy & Data** | Email for LGPD requests, legal links, sign-out button | New section | GDPR/LGPD compliance |

### Inline Editing Pattern
Each section has:
- **Display mode:** Read-only fields
- **Edit mode:** Editable inputs + Save/Cancel buttons
- **Save behavior:** Reuse existing `actions.ts` server functions

### New Components
```
components/account-dashboard.tsx         (Main layout)
components/account-sidebar.tsx          (Left navigation)
components/account-tabs.tsx             (Mobile tabs)
components/account-form-account.tsx     (Account section)
components/account-form-company.tsx     (Company section)
components/account-form-plan.tsx        (Plan section)
components/account-form-privacy.tsx     (Privacy section)
components/account-edit-toggle.tsx      (Edit/View mode)
components/welcome-banner.tsx           (First-login welcome)
lib/account/dashboard-state.ts          (State management)
components/*.test.tsx                   (Unit tests, 1 per component)
```

### Modified Files
```
app/conta/page.tsx                      (New dashboard logic + routing)
app/conta/layout.tsx                    (Remove AccountChrome if needed)
app/conta/account-data.ts               (Minor adjustments)
app/conta/actions.ts                    (Refactor for inline forms)
app/conta/perfil/page.tsx               (Redirect → /conta?tab=account)
app/conta/empresa/page.tsx              (Redirect → /conta?tab=company)
app/conta/plano/page.tsx                (Redirect → /conta?tab=plan)
```

### Responsive Design
**Critical: Use container queries (NOT viewport queries above 720px)**

```css
/* app/conta/page.tsx or dashboard.css */
@container (min-width: 1024px) {
  .account-sidebar {
    display: flex;
    width: 264px;
    /* Sidebar visible */
  }
  .account-content {
    flex: 1;
    /* Content takes remaining space */
  }
}

@container (max-width: 1023px) {
  /* Tabs layout instead of sidebar */
}
```

**Why?** The app shell (AppShell) adds a 264px navigation rail at 1024px. Viewport queries fail because the content container is constrained. Container queries measure the actual container width, not the window.

### Effort
**20–24 hours**

### Success Criteria
- ✅ All fields from original 3 pages are editable
- ✅ Save logic unchanged (reuses existing server actions)
- ✅ Mobile tabs work smoothly
- ✅ Desktop sidebar navigation works
- ✅ No data loss when switching sections
- ✅ Edit mode inline without modal dialogs

---

## 3. Post-Login Redirect Logic

### Current Behavior
After successful login:
- User lands on `/conta/perfil` (Profile page)
- No onboarding or welcome message

### New Behavior
**First-time users:**
```
1. Auth succeeds
2. Check if user has `last_login` timestamp (or similar marker)
3. If not set: Redirect to /radar?welcome=1
4. Show 5-second welcome banner: "Welcome! Start searching editais..."
5. Auto-dismiss, user continues with Radar
```

**Returning users:**
```
1. Auth succeeds
2. Redirect directly to /radar
```

### Implementation Options

#### Option A: URL Parameter (Simpler)
```typescript
// lib/auth/callback.ts
if (!user.lastLogin) {
  return redirect('/radar?welcome=1');
}
return redirect('/radar');
```

Then in `/radar` client component:
```tsx
const searchParams = useSearchParams();
const showWelcome = searchParams.get('welcome') === '1';

return showWelcome ? <WelcomeBanner /> : null;
```

#### Option B: Database Flag (More Robust)
```typescript
// Update users.last_login on successful auth
// Redirect to /radar (no URL param needed)
```

### New Components
```
components/welcome-banner.tsx    (Dismissible 5-second banner)
```

### Modified Files
```
lib/auth/config.ts              (Post-login redirect)
app/radar/page.tsx              (Show welcome banner if ?welcome=1)
```

### Effort
**2–4 hours**

### Success Criteria
- ✅ First-time users see welcome + redirect to `/radar`
- ✅ Returning users skip welcome, go straight to `/radar`
- ✅ Welcome banner dismissible, auto-dismisses after 5 seconds
- ✅ No session loss or auth errors

---

## 4. Backward Compatibility: Deprecated Routes

Redirect old URLs to new dashboard tabs:

```typescript
// app/conta/perfil/page.tsx
export default function ProfileRedirect() {
  redirect('/conta?tab=account');
}

// app/conta/empresa/page.tsx
export default function CompanyRedirect() {
  redirect('/conta?tab=company');
}

// app/conta/plano/page.tsx
export default function PlanRedirect() {
  redirect('/conta?tab=plan');
}
```

**Effect:** Bookmarks and direct links continue to work.

---

## 5. File-by-File Change Summary

### New Files (12 components + tests)
```
components/login-split-screen.tsx
components/login-brand-side.tsx
components/login-form-side.tsx
components/account-sidebar.tsx
components/account-tabs.tsx
components/account-form-account.tsx
components/account-form-company.tsx
components/account-form-plan.tsx
components/account-form-privacy.tsx
components/account-edit-toggle.tsx
components/welcome-banner.tsx
lib/account/dashboard-state.ts
components/*.test.tsx               (1 test per component)
```

### Modified Files
```
app/conta/criar/sign-in-view.tsx    (Use new split-screen)
app/conta/criar/page.tsx            (Minor updates)
app/conta/page.tsx                  (New dashboard logic)
app/conta/layout.tsx                (Responsive adjustments)
app/conta/actions.ts                (Refactor for inline forms)
app/conta/account-data.ts           (Minor adjustments)
app/conta/perfil/page.tsx           (Redirect)
app/conta/empresa/page.tsx          (Redirect)
app/conta/plano/page.tsx            (Redirect)
lib/auth/config.ts                  (Post-login redirect)
app/radar/page.tsx                  (Welcome banner logic)
```

### Unchanged
```
app/conta/alertas/*                 (No changes)
components/app-shell.tsx            (No changes)
All other routes                    (No changes)
```

---

## 6. Design System Compliance

✅ **Tokens:** Ivory, Graphite, Blue (from `apps/web/styles/tokens.css`)  
✅ **Typography:** Archivo (display), IBM Plex (body)  
✅ **Components:** All from `@/components` (Button, Card, Field, AppBar, StateCard, Tag, SectionLabel, MenuTrigger)  
✅ **No new design tokens required**  
✅ **Follows spec §11 & `docs/design/` guidelines**  

---

## 7. Effort Breakdown

| Task | Hours | Engineer | Notes |
|------|-------|----------|-------|
| Login redesign | 6–8 | Engineer 1 | Low risk; no logic changes |
| Dashboard refactor | 20–24 | Engineer 2 | Largest task; can start day 3 |
| Redirect logic | 2–4 | Engineer 3 | Can start in parallel with login |
| Unit + E2E tests | 8–10 | Parallel | Pin dashboard behavior |
| Refinement & bug fixes | 2–3 | Lead | Pre-ship QA |
| **Total** | **42–55** | **1–3 engineers** | **1.5–3 weeks** |

### Timeline Options
- **3 engineers (parallel):** 1.5 weeks
- **2 engineers (staggered):** 2 weeks
- **1 engineer (sequential):** 2.5–3 weeks

---

## 8. Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Old links break | Redirect routes in place |
| Container query failures | Test at 1024px breakpoint (sidebar appears) |
| Save logic regression | Reuse existing server actions; minimal changes |
| First-time user confusion | Welcome banner + on-page guidance |
| Mobile performance | Lazy-load tabs; test on 390px minimum |

---

## 9. Testing Checklist

### Unit Tests
- [ ] Split-screen component at all breakpoints
- [ ] Account dashboard sections (mount, edit, save)
- [ ] Sidebar/tab navigation state
- [ ] Welcome banner (show, dismiss, auto-dismiss)
- [ ] Redirect logic (first-time vs. returning)

### Integration Tests
- [ ] End-to-end: login → welcome → radar
- [ ] End-to-end: returning user login → radar (no welcome)
- [ ] Account form save with server action
- [ ] Deprecated route redirects

### E2E Tests (Playwright)
- [ ] Mobile login (390px): brand section hides
- [ ] Desktop login (1024px): split-screen visible
- [ ] Tablet login (768px): stack layout
- [ ] Account dashboard: edit → save → verify
- [ ] Tab switch on mobile
- [ ] Sidebar click on desktop

---

## 10. Success Criteria

### Login Redesign
- ✅ Brand story visible on left (desktop)
- ✅ Form on right with Google OAuth + email/password
- ✅ Mobile: stacks vertically, form takes priority
- ✅ All auth logic unchanged

### Account Dashboard
- ✅ All fields from Perfil, Empresa, Plano visible
- ✅ Inline edit + save for all sections
- ✅ Sidebar or tabs work at all breakpoints
- ✅ Old URLs redirect correctly
- ✅ No data loss when switching tabs

### Post-Login Redirect
- ✅ First-time users see welcome + redirect
- ✅ Returning users skip welcome
- ✅ Welcome dismissible
- ✅ Redirect to `/radar` succeeds

---

## 11. Implementation Order

**Phase 1: Login (Week 1, Days 1–2)**
1. Create split-screen components
2. Update sign-in-view.tsx
3. Test at all breakpoints
4. Deploy

**Phase 2: Redirect Logic (Week 1, Days 2–3)**
1. Add post-login redirect in auth/config.ts
2. Create welcome banner component
3. Add welcome logic to /radar
4. Test first-time vs. returning flow

**Phase 3: Account Dashboard (Week 1–2, Days 3–5)**
1. Create account dashboard layout + state
2. Build sidebar/tabs navigation
3. Refactor form sections (account, company, plan, privacy)
4. Integrate with existing server actions
5. Add redirect routes

**Phase 4: Testing & Refinement (Week 2)**
1. Unit + integration tests
2. E2E tests (Playwright)
3. Mobile QA
4. Bug fixes + refinement
5. Pre-ship validation

---

## 12. Next Steps

1. **Review this plan** — Confirm architecture & scope
2. **Finalize login brand copy** — What's the value proposition on the left?
3. **Start login redesign** — Engineer 1 begins (6–8 hours)
4. **Start redirect logic** — Engineer 3 begins in parallel (2–4 hours)
5. **Dashboard refactor follows** — Engineer 2 starts day 3 (20–24 hours)
6. **Integration & testing** — Week 2 focus (8–10 hours parallel)
7. **Ship** — End of week 2 or early week 3

---

## Appendix: Container Query Reference

**Why container queries?**

The app shell puts a 264px sidebar at 1024px viewport width. If the dashboard form is inside that constrained container, a viewport query of `min-width: 1024px` will fire even though the actual container is only 760px wide.

**Solution:**
```tsx
// app/conta/page.tsx
<div className="account-container"> {/* This is the container to measure */}
  <aside className="hidden @lg:block">Sidebar</aside>
  <main className="@lg:flex-1">Content</main>
</div>
```

```css
@container (min-width: 1024px) {
  aside { display: block; }
}
```

`@lg` = Tailwind container breakpoint (64rem / 1024px)

---

## Document History
- **2026-10-14:** Initial plan created
- **Status:** Ready for implementation review

