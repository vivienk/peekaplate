# AI-01 synthetic owner preview

This slice renders the existing `owner-recommendation.v1` public result inside
the development/PR-preview dashboard from #105. It does not connect a live
report or model, authorize a restaurant, approve advice, or execute changes.
The selected design surface is #105's existing owner AI panel and mobile
drawer, initially based on `583677a` and synchronized with its `dcb6fd4`
modal-drawer fix. The component uses its light design tokens. The existing
`ModalDrawer` retains focus trapping, inert background, Escape/close behavior
and opener-focus restoration while the nested `ChatBox` receives the synthetic
preview through `ctxBar`. Final placement and visual sign-off remain separate.

## Integration boundary

Import `AiRecommendationPreview` and `AiPreviewState` from
[`AiRecommendationPreview.tsx`](../frontend/console/src/owner-dashboard/ai-preview/AiRecommendationPreview.tsx),
and load the adjacent `ai-preview.css` through the console stylesheet/bundle.
Pass one local display state:

```tsx
<AiRecommendationPreview state={{ kind: 'result', result }} />
```

`result` is the existing shared `OwnerRecommendationResult`, with only
`recommendation` or `abstained` wire statuses. The component checks that public
schema at runtime and displays a generic error for an invalid result; it does
not print raw producer errors or internal fields. Abstention reasons use fixed
owner-facing copy rather than raw diagnostic messages. Recommendation text
must come from the trusted, count-free AI output boundary; schema validation
alone does not establish provenance, authorization or the truth of text.
The public `@peekaplate/contracts/owner-ai` subpath exposes the existing AI
schemas without importing the broad observation/analytics barrel. It adds no
wire fields or statuses. Displayed report boundaries are normalized to UTC and
retain their time of day; original offset-bearing values remain in the `time`
elements' `dateTime` attributes.

The `loading`, `error`, `insufficient-evidence` and `withheld` variants belong
to `AiPreviewState`, not to the server response schema. None has a numeric
fallback. All variants remain explicitly synthetic. There is no live-mode
switch, network client, backend import, free-form chat, approve/apply button
or internal cohort input. UUID evidence references remain in the typed result
for integration, rather than being presented as meaningful owner-facing prose.

The separately importable component is mounted by
[`SyntheticAiPreviewDemo.tsx`](../frontend/console/src/owner-dashboard/ai-preview/SyntheticAiPreviewDemo.tsx).
Its collapsible state selector occupies the existing `ChatBox.ctxBar` slot in
the desktop panel and mobile drawer; the earlier illustrative chat is unchanged.
Open `/owner-dashboard.html` and expand **Typed AI result preview**. All six
examples are local and explicitly fictional. The dashboard remains excluded
from normal production builds by the existing preview-demo build rule.

Nifemi retains RES-03 integration ownership and replaces the demo caller when
the agreed integration is ready. Jeffin retains the dashboard shell, including
the modal-drawer behavior inherited from #105. AI-01 owns this result component
and typed output boundary;
other dashboard screens retain their existing owners. No delivery date or
model/provider choice is established by this slice.

## Verification and deferred acceptance

Unit tests cover the shared result examples, all local display states, invalid
wire statuses, internal-field/effect rejection, fixed withheld copy and escaped
text. Browser tests exercise the actual desktop panel/mobile drawer, local
state switching, absence of fetch/XHR, keyboard controls, narrow layout and
scoped accessibility. Run through the repository verification entry points:

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm exec playwright test tests/e2e/owner-ai-preview.spec.ts tests/e2e/owner-dashboard-drawer.spec.ts --workers=1
pnpm verify build
```

Exact executed results are recorded in the PR handoff; the presence of these
tests is not evidence that they ran. Full shell accessibility, manual mobile
and screen-reader checks, design acceptance, current membership, real producer
identity/freshness/cohorts, approved production policy, model evaluation and
hosted report/AI acceptance remain separate. #112 stays Draft and AI-01 stays
In Progress until their own acceptance requirements are satisfied.
