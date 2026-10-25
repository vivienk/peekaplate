# PeekaPlate: team guide

Infrastructure and team analytics access updated October 22, 2026. The team research and board inventory below remains the dated October 14 snapshot.

PeekaPlate is meant to help a restaurant explain its food and learn how people use its menu. The team has been researching that idea and designing the experience. Sai started the code setup. We now have the project structure, checks for new code, and one tested way to save a staff member's draft dish change.

**We do not have a finished menu app yet.** The current design shows where the screens are going. The code so far provides the foundation those screens will use.

This guide starts with the product and progress, then follows the code behind one dish change. The complete file list, task board and test evidence are at the end for reference.

For setup, read **section 2**. For code, follow **section 4**. For Python and PostHog, read **section 5**. For the next sprint, read **What needs to happen next** at the end. The [detailed implementation plan on develop](https://github.com/vivienk/peekaplate/blob/develop/docs/implementation_plan.md) contains screen controls, events, metric formulas and the wider delivery sequence. It is planning material; the dated deployment evidence below establishes what is running.

## 1. What a restaurant should eventually be able to do

Imagine a restaurant wants to add Tomato Soup to its digital menu. This is an example, not a real restaurant record.

1. Someone supplies a real photo and accurate information about the soup.
2. Staff check the information, correct anything uncertain and approve the exact version diners will see.
3. A diner opens the menu through a link or QR code, reads about the soup and optionally explores a richer photo view.
4. PeekaPlate records useful actions, such as opening the soup's details.
5. The restaurant sees a simple explanation of those actions and can decide what to improve.

The last step needs care. Looking at a dish does not prove that someone ordered it. We must say what we observed and what we still do not know. Connecting browsing to actual orders is separate, later work that needs permission and reliable order data.

The visual experience is one part of this loop. Accurate food information, a usable menu and useful evidence matter just as much.

## 2. Where we are today

**Research and design:** the team has worked on diner needs, restaurant interviews, journeys, screen designs, processing requirements and measurement ideas. [Rania's Figma Design file](https://www.figma.com/design/l7A9n8tACJic0FIhY49Zjw/PeekaPlate?node-id=0-1) is the newer diner reference recorded in the implementation plan; the earlier Make V1 is historical context. The [owner dashboard artifact](https://claude.ai/artifact/X8uwfdGP6CGttfrDGBnwpu) describes the other experience. Confirm selected frames and states when starting each screen ticket. Design progress does not establish working code.

**Code foundation:** the repository now has separate places for the diner app, staff app, server rules, database changes, tests and documentation. It also has instructions for coding assistants and checks that run when someone proposes a change.

**First working code flow:** a developer can use a local demo to submit a draft dish change. The backend checks a made-up test identity and its restaurant permission, saves the change and remembers the result. Each saved version of a dish is called a **revision**, like version history in a document. This work was reviewed and merged in [PR #9](https://github.com/vivienk/peekaplate_staging/pull/9).

“Local” means it runs on a developer's machine with made-up test identities and disposable data. We now also have a shared online staging service: [diner starter page](https://peekaplate-diner-staging.pages.dev/), [staff starter page](https://peekaplate-console-staging.pages.dev/) and [API health](https://peekaplate-api-staging.vxkong.workers.dev/health). Supabase stores the data; Cloudflare runs the API, and Hyperdrive manages its database connections. A real Supabase test login successfully saved synthetic dish revisions. Tests prevented duplicate changes and rejected conflicting edits, another restaurant's writes and access after restaurant membership was removed. The staff screen still needs its own sign-in and editing interface. See [the deployment record](operations.md#staging-deployment-record) for the exact tested limits.

| Part | What exists now | What still needs building |
| --- | --- | --- |
| Diner screen | A basic staging page | A real restaurant menu based on the design |
| Staff screen | A starter page | Sign-in, editing, review, approval and publishing screens |
| Saving a dish | Backend draft-save flow tested locally and online with Supabase identity | Connecting it to the staff screen |
| Food visuals | Design direction and written rules | Reviewed assets and the optional interactive viewer |
| Diner tracking | Initial rules for event data | Collecting, storing and reporting actual browsing actions |
| PostHog analytics | Opt-in shell views, private hourly Supabase export and collaborator read API verified in staging; genuine outsider denial also passed | Complete the controlled collaborator-removal check and monitor exports; real menu events remain separate work |
| Python processing | Accepted extension in the architecture | Implement, test and choose a runtime for the first specific job |
| Owner report | Research/design requirements | A report built from real, permitted evidence |

ClickUp's “Complete” status describes a task's recorded progress. It is not proof that a feature works in the code. For example, the approval-path task is marked complete, while approval and publication are still missing from this repository. That mismatch needs to be reconciled with the actual deliverable.

### Where to open staging

The [observation Queue, DLQ and private R2 setup](observation-infrastructure.md) is now provisioned and tested with synthetic messages. Think of the Queue as the waiting room, R2 as the original evidence archive and the DLQ as the recovery tray for work that repeatedly fails. Both Queues are paused while Teeyansh's real consumer is unfinished. They retain messages for 24 hours even while paused, so real collection must remain off. The staging binding configuration needs its reviewed release before the API Worker can use it; actual archive-to-database processing remains separate work.

**Staging is our shared online test environment.** It lets the team test the same version before real restaurant use. We are keeping these existing names; no domain purchase or rename is needed.

| Open this | Who it is for | What to expect today |
| --- | --- | --- |
| [Diner staging](https://peekaplate-diner-staging.pages.dev/) | People browsing a restaurant menu | A starter page, not a restaurant menu yet |
| [Owner/staff staging](https://peekaplate-console-staging.pages.dev/) | Restaurant owners and permitted staff | A starter page; login and dashboard screens still need building |
| [API health](https://peekaplate-api-staging.vxkong.workers.dev/health) | Developers checking whether the server responds | A machine-readable response; this alone does not test database access |

**Console means the owner/staff application.** It is the existing project and folder name, not a third product. The future diner menu will open directly from a QR code or link, with a small owner sign-in link. Neither that menu nor that sign-in flow is connected yet.

### What each service does

| Service | Everyday explanation | Current setup |
| --- | --- | --- |
| GitHub | Stores code, documents and proposed changes | `vivienk/peekaplate` is the application repository. CI checks proposals before review. |
| Cloudflare Pages | Delivers browser pages | Separate diner and console staging projects serve their built files. |
| Cloudflare Worker | Runs server rules when a request arrives | The staging API checks identity and restaurant access before saving a draft dish. |
| Supabase Auth | Confirms who signed in | Genuine test sign-in has been exercised. The console still needs a login interface. |
| Supabase PostgreSQL | Keeps lasting application records | Stores restaurants, staff permissions, dish drafts, history, retry results and pending work. |
| Cloudflare Hyperdrive | Manages Worker connections to PostgreSQL | Uses a restricted staging login. It is not another database. Query caching is disabled for this command path. |
| Cloudflare R2 | Stores files such as photos and prepared visual assets | Existing staging and production buckets are reserved. Staging is private; uploads and approved asset delivery are not connected yet. |
| Cloudflare Queues | Holds accepted observations until processing finishes | Planned with event ingestion; not running in the current flow. A failed-message queue will hold work needing recovery. |
| Docker | Gives developers a disposable test database | Used locally and in CI. The shared database is hosted by Supabase. |

The **current tested save path** is:

```text
Genuine test login with Supabase Auth
    → a signed identity token
    → test client calls the Cloudflare API
    → API verifies identity and current restaurant membership
    → Hyperdrive connects to Supabase PostgreSQL
    → history + current dish + retry result + pending work save together
    → API returns the saved draft
```

The test client will be replaced by the real staff editing screen. Neither frontend connects directly to private database tables. Knowing a restaurant ID does not grant access: the backend checks permission, and database row rules provide another layer of protection. Separate restaurant Docker containers are not required.

Photo files belong in file storage; the database will hold their references, ownership, review state and related dish information. Richer assets are prepared manually for this version. No live image-generation service or automatic processing pipeline has been deployed. Existing Cloudflare D1 resources are unused: Supabase PostgreSQL remains the application database.

### How code reaches staging and later production

`main` supplies **both** environments. They will have separate data and credentials; a merge does not automatically deploy. Feature work follows [CONTRIBUTING.md](../CONTRIBUTING.md), and release candidates reach `main` before deployment.

1. Review and test a proposed change, then merge the approved release candidate.
2. An authorized operator builds a specific `main` commit and deploys it to staging.
3. Test that deployed version and record its commit, deployment IDs and results.
4. Once production exists and release approval is given, deploy that same tested commit with separate production resources.

Today, Pages receives manually uploaded builds. The Worker can now be deployed through the protected **Deploy staging Worker** GitHub workflow: Vivien requested the release, a different permitted reviewer approved it, and the workflow passed its checks and deployed it. It runs on manual request, not every push. Production is not configured. Provider screens may label a default branch or deployment “production”; these projects and the database are being used for staging. A production-named R2 bucket alone does not make a production system.

The Worker now runs main release `afe45db`. The diner and console pages were last released with PostHog setup at `2a135fa`; this Worker deployment did not rebuild those pages. Subsequent documentation commits do not change running applications. [Operations](operations.md#team-analytics-hosted-verification--october-22-2026) records the current Worker version and test evidence; the older deployment record preserves the earlier staff-command checks.

### Verified behavior, access and costs

Hosted synthetic tests passed real sign-in, draft saving, duplicate retries, conflicting edits, concurrent requests and denial of another restaurant's writes. Removing restaurant membership blocked subsequent commands. Temporary test membership was removed; labelled synthetic records remain for audit and must be excluded from analytics. Separate remote probes checked rollback and cleared transaction context.

This is a working backend foundation, not a completed owner screen, published menu, tracking system or dashboard. Signing out prevents refresh, but an issued access token can remain valid until expiry; agree the session policy before real staff use. Realistic load, backup restoration, monitoring and incident ownership remain release work.

Product, research and design contributors can use the guide, designs and staging links without database credentials. Developers can run the local demo without cloud keys. Shared deployments and access grants belong to authorized operators. Passwords and deployment tokens stay in approved secret storage, never Git, chat or browser code.

Keeping the existing addresses adds no custom-domain registration. Setup created no extra paid database branch or plan upgrade. This does **not** mean hosting is free: existing subscriptions and usage still apply. Before a pilot, confirm account bills, limits, budget alerts and cost ownership. Production resources and any custom domain need a separate cost check.

## 3. What “events” mean in PeekaPlate

An **event is a saved record that something happened**. It is not a calendar event, an AI agent or a message sent to the team.

There are two kinds here:

| Kind | Plain example | Why keep it? | Built yet? |
| --- | --- | --- | --- |
| A staff action that changes the product | An authorized person saved a new version of Tomato Soup | Know what changed and preserve its history | Yes, for draft dish revisions |
| An observation of diner behavior | A session opened Tomato Soup's details | Understand how the menu was used | No; the collection flow is planned |

### The events we save today

When the draft changes, the system keeps a record of the change and updates the current dish details. Keeping history this way is called **event sourcing**. We use it for selected changes where history matters; it is not a requirement to turn every setting into an event.

Four records work together when a dish is saved:

- **History:** what change happened. In the code, this is an event.
- **Current dish:** the latest details, ready to read. Developers call this a projection.
- **Saved result:** remembers that this particular request was already handled, so retrying it does not create another change. This is a command receipt.
- **Pending follow-up:** records work that may need delivering later. This is the outbox. The later delivery worker has not been built.

Those records are saved together. If one fails, none of that change should remain saved. This all-or-nothing operation is called a **transaction**.

History also lets us rebuild the current dish from previous changes. That is **replay**. Rebuilding must not send a notification or repeat an outside action. The current code tests rebuilding a dish's data; a complete operational recovery tool is still future work.

### The diner events we will add

Suppose a diner opens the soup details while their connection is unreliable. The future tracking flow needs to remember the observation, retry safely and avoid counting it twice. It must also identify the exact menu and dish version that person saw.

The plan is for the browser to send observations to a receiving service. Accepted observations wait in a **queue**, which holds work until it can be processed. A background consumer will save an archive in Cloudflare R2, then add searchable information to PostgreSQL, our database. Only then should it mark that queued work finished. Failed work needs a recovery path.

This flow is not running yet. A queue is not needed to save today's dish revision: that change is saved directly in the database transaction. Keeping the two paths separate prevents a browsing action from being mistaken for permission to change a restaurant's menu.

## 4. Follow a dish change through the code

The **frontend** is the page someone sees. The **backend** is the code that checks requests and controls data changes. An **API** is the agreed way one program asks another to do something. A **database** keeps information after the request finishes.

The future staff page will ask the backend to save a dish. Today a developer's demo sends that request instead. There is no working staff form or real login screen yet.

The links below point to the merged code at `413be96`, so the line references stay stable as new code is added. A **function** is a named piece of code that performs a job; a **schema** states what information is allowed.

### A. Start a safe test environment

In [backend/local.mjs, `develop()` at line 43](https://github.com/vivienk/peekaplate_staging/blob/413be96/backend/local.mjs#L43), the developer tool starts a temporary database, a test identity service and the backend. [`demo()` at line 10](https://github.com/vivienk/peekaplate_staging/blob/413be96/backend/local.mjs#L10) sends the example dish request. These are development tools. They do not create real staff accounts or put a restaurant online.

### B. Check what was sent

[packages/contracts/src/index.ts, `CreateDishRevisionSchema` at line 68](https://github.com/vivienk/peekaplate_staging/blob/413be96/packages/contracts/src/index.ts#L68) defines the allowed request: a request ID, the version being edited, a name and a description. `DishRevisionScopeSchema` at line 66 checks restaurant/dish IDs; `DishRevisionSchema` at line 75 defines the result.

For example, a blank dish name should fail. Sending an extra field saying “give me editor permission” must not grant permission. This shared file keeps the browser and backend working from the same data rules.

### C. Receive the request and establish identity

[backend/src/index.ts, `createApp()` at line 57](https://github.com/vivienk/peekaplate_staging/blob/413be96/backend/src/index.ts#L57) sets up the backend. Its [dish route at line 75](https://github.com/vivienk/peekaplate_staging/blob/413be96/backend/src/index.ts#L75) receives requests to `POST /venues/:venueId/dishes/:dishId/revisions`. This address means “save a revision of this dish at this restaurant.” It checks the request and passes the verified person to the saving function.

[backend/src/auth.ts, `createStaffVerifier()` at line 35](https://github.com/vivienk/peekaplate_staging/blob/413be96/backend/src/auth.ts#L35) checks the signed identity token supplied with the request. A token is evidence from the configured identity provider about who is calling. Expired, incorrectly signed or unsuitable identities are rejected. The function returns the verified person's ID; it does not by itself grant restaurant access. `bearerToken()` at line 81 reads the token, and `trustedIssuer()` at line 89 checks the configured provider address.

### D. Check restaurant access, retries and competing edits

[backend/src/dish-command.ts, `createDishRevision()` at line 101](https://github.com/vivienk/peekaplate_staging/blob/413be96/backend/src/dish-command.ts#L101) does the main saving work. It first checks whether that person currently has permission to edit this restaurant. Knowing Restaurant A's ID does not let someone from Restaurant B edit it.

The [checks at lines 127–159](https://github.com/vivienk/peekaplate_staging/blob/413be96/backend/src/dish-command.ts#L127-L159) protect retries and simultaneous edits. Imagine two editors start with soup version 1. One saves version 2; the other's old version-1 request is rejected as a conflict instead of overwriting it. If the first editor repeats the identical request after a connection problem, the saved result comes back without creating version 3. Reusing the same request ID for different content also fails.

### E. Save the four records together

The [write section at lines 179–225](https://github.com/vivienk/peekaplate_staging/blob/413be96/backend/src/dish-command.ts#L179-L225) saves the history event, current dish, request result and pending follow-up described above. It commits them together, or rolls the change back if something fails. This prevents a dish from appearing saved while its history is missing.

The database has its own protection too. [migrations/20261014210000_staff_commands.sql](https://github.com/vivienk/peekaplate_staging/blob/413be96/migrations/20261014210000_staff_commands.sql#L2) creates `staff_membership` at line 2 and `dish_current` at line 10. The rules at [lines 22–35](https://github.com/vivienk/peekaplate_staging/blob/413be96/migrations/20261014210000_staff_commands.sql#L22-L35) restrict which rows an ordinary application connection can use. Developers call this row-level security, or RLS. The restricted database role starts at line 37. Staging's effective permissions and rules were checked, followed by synthetic requests through the real hosted connection. Future production accounts need their own checks.

### F. Return a result; rebuild history when needed

The successful request returns the saved draft revision. The [error handler in index.ts at line 105](https://github.com/vivienk/peekaplate_staging/blob/413be96/backend/src/index.ts#L105) returns controlled errors for identity, permission or version conflicts. Unexpected failures return a generic service error without exposing the database contents or token.

[dish-command.ts, `replayDish()` at line 82](https://github.com/vivienk/peekaplate_staging/blob/413be96/backend/src/dish-command.ts#L82) can rebuild current dish data from a valid sequence of past events. It rejects broken or mixed histories. It does not publish the dish or deliver the outbox work.

### G. Where the screens will connect

[frontend/console/src/main.tsx, lines 8–20](https://github.com/vivienk/peekaplate_staging/blob/413be96/frontend/console/src/main.tsx#L8-L20) currently shows the staff starter screen. This is where a future staff experience begins; it does not call the dish-saving route yet. [frontend/diner/index.html, lines 11–17](https://github.com/vivienk/peekaplate_staging/blob/413be96/frontend/diner/index.html#L11-L17) contains the diner staging message, which works without JavaScript. The real diner menu must read approved, published content once that flow is built.

To see what checks this behavior, start with [backend/src/dish.integration.ts](../backend/src/dish.integration.ts): it exercises the actual backend runtime and database together. The nearby `auth.test.ts` checks identities, `dish-command.test.ts` checks rebuilding history, and `tests/db/staff.sql` checks database permissions. These tests support the claims above; a filename alone is not proof that every possible case is covered.

The two frontend apps and backend share one repository, but they are separate programs. Sharing a folder does not force them onto one production server. The browser must never hold a database administrator password or decide who is allowed to edit a restaurant.

## 5. Why these tools, and where Python fits

The current browser and backend code use **TypeScript**, so they can share rules for requests and responses. **Hono** is the small routing library used by the backend. A **Cloudflare Worker** runs the staging backend online; tests also exercise its runtime locally.

**PostgreSQL** stores the restaurant data and enforces database rules. **Supabase** is the accepted and now configured provider, combining PostgreSQL with staff identity services. The earlier Supabase-versus-Neon discussion did not change that decision. A future provider change needs a recorded decision and equivalent identity/isolation checks; there is no second D1 application database.

**Docker** runs a temporary PostgreSQL database for tests. It does not provide restaurant isolation by itself. The backend's permission checks and database rules do that. The Windows startup issue was recovered with Desktop 4.95 on October 14 after backing up the existing data. The local database tests and dish-save demo now pass; each contributor still needs a working Docker engine on their own machine.

### How Python can work with the existing backend

**Python is part of the accepted plan for processing or analysis work.** Contributors can use it for a suitable task without rewriting the existing backend. TypeScript continues to handle the main API and restaurant permissions. Python can handle a defined task such as checking photo dimensions, cleaning imported data or calculating an analysis result. Supabase remains the application database.

Here is a proposed example; this upload/processing flow is not built yet:

```text
Staff supplies a dish photo
  → TypeScript API checks permission and records the processing request
  → Python checks the photo and prepares a result
  → API checks that the result belongs to the expected job and restaurant
  → Result is saved as a draft through the application's normal rules
  → A person reviews it before publication
```

The two languages exchange structured messages, like a form with agreed field names. Developers call this a **data contract**. It includes a job reference, the approved input and the expected result. TypeScript types do not automatically work in Python, so developers test that both sides understand the same messages. A job must not gain permission simply by supplying a restaurant ID, and a repeated result must not create duplicate changes.

Python needs its own environment and tests: **uv** manages its dependencies and **pytest** runs its tests. Those tools will be added with the first real task. There is no Python service deployed today, and the current `pnpm` commands only run the existing JavaScript/TypeScript toolchain.

For a small compatible job, a separate **Cloudflare Python Worker** may be enough. Cloudflare supports Python, but some libraries and workloads do not fit its runtime. Heavier work may need a container or specialist compute service with a separately agreed cost. Calling an AI provider is different from hosting an image model ourselves. The first Python ticket must check those requirements before choosing where it runs. See the [supported Python packages](https://developers.cloudflare.com/workers/languages/python/packages/).

Before connecting a job to staging, test a successful result, bad input, a timeout, a repeated result and an attempt to use another restaurant's data. Keep long processing away from the diner's page request so people can continue browsing. Manual preparation and review of T1/T2 assets remain the current plan; adding Python does not introduce automatic generation or publishing.

### What PostHog adds, and what it does not

For team inspection, the deployed read API lets any current repository collaborator use their own GitHub token to ask the Worker for safe staging events or technical counts. Nobody needs our export password or database administrator key. The Worker verifies their GitHub identity and current collaborator status before asking Supabase; data still arrives through PostHog's hourly export. Both endpoints returned 200 using Sai's GitHub account, and missing or invalid tokens returned 401. On October 23, Harshita helped verify that a valid non-collaborator received 403 from both endpoints, twice. The separate controlled collaborator-removal check remains pending. This is a development tool, not the restaurant-owner dashboard. See [team data access](team-data-access.md) for the URL, authentication, examples and dated evidence.

**Both hosted staging pages now send consented test events to PostHog, and those records were checked in PostHog.** For now, the two screens are starter pages. Clicking **Allow optional analytics** sends one `app_shell_viewed` event: a small record saying which screen was viewed and that this is staging. PostHog turns those records into an internal chart. It does not mean a diner opened a published menu or ordered food.

The flow is **page → consent check → PostHog → internal chart**. An hourly connection now copies those observations into a separate private area of the same Supabase database. We verified four test events arrived. Sending the same batch again produced eight stored copies, but the clean view still counted four events. The diner and console test records each appeared once, and access checks passed. The hourly schedule is enabled. A raw table keeps received copies; a view counts identical repeats once and excludes conflicting copies. It does not change trusted restaurant records. See [export setup and status](posthog-export.md). Tracking starts off, stops when withdrawn, and resets when the page reloads. Browser privacy signals can block it. The menu must work even if PostHog is unavailable.

When the real menu is built, its actions must follow [Adam's taxonomy and measurement plan](https://app.clickup.com/90141746115/docs/2kydvry3-1494?view=open) and the [implementation plan](implementation_plan.md), including ingredient interactions and comparisons. Agree the names, exact triggers and content versions before wiring each control. The current v1 adapter is tested for `dish_open` and `portion_compare`; it has no real dish-control caller yet. A general dish comparison must not be labelled as physical portion measurement.

These responsibilities remain separate:

| Part | What it is responsible for |
| --- | --- |
| Main backend and Supabase | Permissions and trusted application records, including dish revision history |
| Planned diner-evidence pipeline | Recoverable observations of the exact content shown, under [ADR 0003](adr/0003-intent-evidence.md) |
| PostHog | Optional internal charts; current test events describe starter-page views |
| Owner dashboard | A future product screen with agreed calculations and access restricted to the owner's restaurant |

**The owner dashboard should not wait for the hourly PostHog export.** The planned route is: **diner action → backend validation → queue → archive and Supabase → updated totals → owner's dashboard**. A projection is simply a prepared total or summary, such as how many eligible views a dish received. The backend checks which restaurant the owner can access before returning those totals. A chart filter alone cannot protect another restaurant's data.

For example, when someone opens a dish, the event pipeline will record that action once and update its eligible view count. The dashboard can then refresh from Supabase. Retries must not count the same action twice. The target is prompt updates, but the pipeline and dashboard are not built yet, so we have no measured freshness guarantee. Their tickets must agree and test the target, show when data was last updated, and show a delay if processing falls behind. The [export runbook](posthog-export.md#why-the-owner-dashboard-must-not-wait-for-this-export) diagrams this planned path beside the separate hourly analytics copy.

PostHog remains useful for the team's optional usage charts and later checks against those records. Using PostHog as the owner-report source would change the accepted design and needs a reviewed architecture decision. Agree one PostHog sending route per action so it is not accidentally mirrored twice.

**Capacity example:** 300 menu visits per day, with 40 events per visit over 30 days, would produce 360,000 events. PostHog lists a one-million-event monthly free allowance as checked on October 19, 2026. That should leave room for a small pilot under these assumptions; it is not a forecast or an unlimited service. Include test and automatically collected events in usage, and monitor the allowance because extra events can be dropped when a free or configured billing limit is reached. See [current pricing](https://posthog.com/pricing).

**Where to see it:** the [internal staging dashboard](https://us.posthog.com/project/675372/dashboard/2233365) uses Vivien's existing US project, currently named **Default project**. Only synthetic staging activity belongs there. Members can inspect events and create charts; administrators control project settings and billing. The public ingestion token lets the app send events but does not give anyone permission to read analytics. Contributors can run the normal local app with tracking disabled; they do not all need cloud credentials.

**Files behind this:** [analytics/index.ts](../packages/analytics/src/index.ts) checks configuration and consent, builds the allowed event fields and limits network requests. [analytics/consent.ts](../packages/analytics/src/consent.ts) provides the opt-in button. [diner/main.ts](../frontend/diner/src/main.ts) and [console/main.tsx](../frontend/console/src/main.tsx) connect it to each screen. [Unit tests](../packages/analytics/src/index.test.ts) and [browser tests](../tests/e2e/posthog.spec.ts) check allowed, blocked and failed capture. [posthog.md](posthog.md) is the operator's setup and verification record.

**What comes next:** finalize the diner design states, build approved menu controls and connect their agreed events. The private Supabase export and separate team inspection API are deployed; use [the access guide](team-data-access.md) with your own GitHub token. Collaborator access and genuine outsider denial have passed; the controlled collaborator-removal check remains before full access acceptance. Local work with synthetic fixtures can continue. The durable evidence pipeline and owner calculations remain separate implementation work. Vivien can rename the project **PeekaPlate Staging** later and confirm billing and retention ownership; Member access was enough to test the connection and prepare the internal chart. Before real diner use, approve the privacy notice and deletion policy. Python work can proceed separately once its first job is defined.

### What T0, T1 and T2 mean

- **T0:** a normal, complete menu with real photos and text. This must work even when optional visuals or tracking fail.
- **T1:** limited movement of reviewed photo cutouts, giving a shallow sense of depth.
- **T2:** separate layers based on real captured plating stages, for selected dishes.

Three.js is the planned tool for drawing the optional interactive view in the browser. It is not a working feature yet. The first direction is photos/2.5D. Older tickets about generated 3D are research to reconcile with that direction; they do not permit inventing ingredients or unseen edible surfaces. The normal menu must remain available if the viewer fails.

## 6. How the current team work fits together

The [October 13 sprint recap](https://discord.com/channels/1556028660832673885/1556115536243589212/1559805887839731717) records these immediate handoffs:

| Person | Current handoff | What the next person needs from it |
| --- | --- | --- |
| Sai | Repository, coding-agent instructions and CI setup | A working starting point, clear checks and an explanation of what is ready |
| Shirley | Readiness plan and task classification | Prioritized risks, remaining questions and evidence needed before building |
| Amr and Rania | Design tokens, colors, typography and layouts | Shared screen designs, reusable style choices and loading/error/fallback states |
| Adam | Diner event taxonomy and measurement plan | Clear names for observations, when they occur and what each one means |
| Vivien | Third-party API list and setup coordination | Confirmed services, access requirements and selected sprint work |

Eirene, Shirley and Vivien also have ClickUp assignments around the dish-processing workflow. Their specifications should explain what comes from a trusted source, what may be uncertain and where a person must review it. Those are inputs to the implementation; they are not already-running AI services.

Keep using the latest prototype while the design system develops. The [design discussion](https://discord.com/channels/1556028660832673885/1556115291577126912) supports refining the existing structure and splitting work to avoid duplication. Accessible light/dark treatments and restaurant branding remain design and implementation work.

The full task snapshot below includes actual assignments and unassigned items. It does not give people new titles or silently assign new work. Sprint numbering, dates and selected scope still need to match the team's current agreement. One restaurant with three dishes appears as a candidate test slice, not a confirmed finished pilot.

## 7. What the checks and coding agents do

A **pull request**, or PR, is a proposed change to the shared code. Before it is merged, GitHub runs **CI**: automatic checks for problems such as invalid code, broken tests, stale documentation references or database rules that allow the wrong access.

The checks are split by purpose. Fast code checks run in the quality job. Relevant database changes also run real PostgreSQL tests; relevant browser changes run browser tests. One final result reports whether the required jobs passed. A documentation change should not needlessly run every browser and database test.

The draft-save tests cover wrong identities, access to another restaurant, revoked access, repeated requests, conflicting edits and partial failures. Passing these tests supports this particular local feature. It does not establish that the whole product, cloud setup or real-phone experience is ready.

Human review still matters, and the normal process requires a human review comment. Automated review must identify itself honestly. A specific authorization to merge the setup does not remove that rule from future work.

The coding-agent files give assistants five jobs: explain the repo, build one assigned change, review architecture, review correctness, or coordinate reviews. These are instruction files, not five services running by themselves. Selected prompt exercises were tested, including a corrected builder prompt; their behavior and client permissions still need checking in normal use.

Two files help continuity: `docs/CONTEXT.md` points an assistant to relevant code and decisions; `errors.md` records sanitized failures, fixes and prevention. Neither is an all-knowing memory. The error file automatically records failures only when checks run through the verification runner; other unexpected failures need a manual entry.

## 8. How to pick up a piece of work

First, connect the research and design deliverables to specific implementation tasks. For each task, record the intended result, the person taking it, the source design or requirement, and how the team will demonstrate completion. A research task may finish with findings. A coding task needs working behavior and relevant tests.

Link completed deliverables and PRs back to their ClickUp tickets during normal team updates, as discussed in the [general channel](https://discord.com/channels/1556028660832673885/1556028661570867252). Developers use `pnpm check` or `pnpm verify <check>` to record verification, then update the affected documentation and context entry. A check that was not run must remain marked NOT RUN.

The dependency plan is the final section of this guide. The commands and setup procedure are in [operations.md](operations.md). Do not start a later step just because a design task with a similar name is marked complete.

For the next demo, be precise about what can be shown: a tested draft-save backend, the current prototype, and the remaining steps connecting them. An online menu, staff sign-in and restaurant analytics should only be described as working after those flows exist and have been exercised.

## Reference: the project files

Start with the code walkthrough above. Open this list when you need to find a particular file; it covers all 99 tracked files at this handoff.

<details>
<summary>Open the complete file-by-file guide</summary>

The filename tells you where to look. The description explains what that file is responsible for. Files with `.test` contain checks; they are not features a restaurant uses. Configuration files tell tools how to run or check the project.

### Start here: project-wide files

| File | Purpose |
| --- | --- |
| [README.md](../README.md) | Public starting page: current capabilities, stack, commands, repository layout and limits |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | How a developer prepares, tests, documents and submits a complete change |
| [AGENTS.md](../AGENTS.md) | Shared rules for contributors and coding agents: authority, scope, evidence and handoffs |
| [CLAUDE.md](../CLAUDE.md) | Points Claude to the same project rules instead of maintaining a competing policy |
| [SECURITY.md](../SECURITY.md) | Security boundaries, private reporting guidance and safe handling of credentials/data |
| [errors.md](../errors.md) | Sanitized failure observations, confirmed causes, fixes and still-open limitations |
| [.learnings/LEARNINGS.md](../.learnings/LEARNINGS.md) | Reusable lessons about tooling and workflow; not a dump of chats or private data |
| [package.json](../package.json) | Root command list, runtime requirements and shared development tools |
| [pnpm-workspace.yaml](../pnpm-workspace.yaml) | Lists the applications/packages and controls dependency installation policy |
| [pnpm-lock.yaml](../pnpm-lock.yaml) | Records the exact dependency tree so installs are repeatable; generated by pnpm |
| [.node-version](../.node-version) | Tells local tools which Node version to use |
| [tsconfig.base.json](../tsconfig.base.json) | Shared strict TypeScript settings |
| [biome.json](../biome.json) | Formatting and import-organization configuration |
| [.editorconfig](../.editorconfig) | Consistent spacing, encoding and line endings across editors |
| [.gitattributes](../.gitattributes) | How Git handles text line endings and binary image files |
| [.gitignore](../.gitignore) | Keeps dependencies, generated output, local credentials and temporary work out of ordinary Git additions |
| [vitest.config.ts](../vitest.config.ts) | Selects fast application/contract/local-tool tests |
| [vitest.db.config.ts](../vitest.db.config.ts) | Selects the separate real database integration tests and their time limits |
| [playwright.config.ts](../playwright.config.ts) | Starts the local apps for browser tests and controls browser output/failure traces |

### Diner frontend: what the customer will open

| File | Purpose |
| --- | --- |
| [frontend/diner/index.html](../frontend/diner/index.html) | Current static staging message; the page content exists even without JavaScript |
| [frontend/diner/src/main.ts](../frontend/diner/src/main.ts) | Current JavaScript entry, which imports styling; future diner behavior belongs here or in modules it uses |
| [frontend/diner/src/style.css](../frontend/diner/src/style.css) | Diner shell appearance and layout |
| [frontend/diner/package.json](../frontend/diner/package.json) | Diner dependencies and its own development/build commands |
| [frontend/diner/tsconfig.json](../frontend/diner/tsconfig.json) | TypeScript settings for this app |
| [frontend/diner/vite.config.ts](../frontend/diner/vite.config.ts) | Diner build configuration, including the initial JavaScript size check |

### Staff console: what restaurant staff will use

| File | Purpose |
| --- | --- |
| [frontend/console/index.html](../frontend/console/index.html) | Browser page that hosts the React console |
| [frontend/console/src/main.tsx](../frontend/console/src/main.tsx) | Current React shell; no working login/edit/review screen yet |
| [frontend/console/src/style.css](../frontend/console/src/style.css) | Console shell appearance and layout |
| [frontend/console/package.json](../frontend/console/package.json) | Console dependencies and commands |
| [frontend/console/tsconfig.json](../frontend/console/tsconfig.json) | TypeScript settings for the console |
| [frontend/console/vite.config.ts](../frontend/console/vite.config.ts) | React/Vite build configuration |

### Backend: identity, permission and changes

| File | Purpose |
| --- | --- |
| [backend/src/index.ts](../backend/src/index.ts) | API entry: health route, dish-revision route, body checks, safe responses and database connection setup |
| [backend/src/index.test.ts](../backend/src/index.test.ts) | Fast HTTP tests for missing identity, invalid requests, size/media limits and configured behavior |
| [backend/src/auth.ts](../backend/src/auth.ts) | Verifies staff tokens using the configured issuer's public keys and returns a verified staff ID |
| [backend/src/auth.test.ts](../backend/src/auth.test.ts) | Tests signed tokens and rejects bad signatures, claims, expiry and unsupported identity cases |
| [backend/src/dish-command.ts](../backend/src/dish-command.ts) | Membership checks, conflict/retry handling, all-or-nothing writes and pure dish replay |
| [backend/src/dish-command.test.ts](../backend/src/dish-command.test.ts) | Fast replay tests, including malformed, mixed or broken event histories |
| [backend/src/dish.integration.ts](../backend/src/dish.integration.ts) | Actual Worker plus PostgreSQL tests, including concurrent edits, rollback and restaurant separation |
| [backend/local.mjs](../backend/local.mjs) | Starts the disposable local database, synthetic identity issuer and Worker; also runs the demo/check mode |
| [backend/local.test.mjs](../backend/local.test.mjs) | Reproduces failed Worker shutdown and checks that remaining cleanup is attempted |
| [backend/wrangler.jsonc](../backend/wrangler.jsonc) | Worker entry, runtime compatibility, staging account, Supabase issuer and Hyperdrive binding; no secrets or production binding |
| [backend/package.json](../backend/package.json) | Backend dependencies and commands |
| [backend/tsconfig.json](../backend/tsconfig.json) | TypeScript settings for backend source |

### Shared contracts and database changes

| File | Purpose |
| --- | --- |
| [packages/contracts/src/index.ts](../packages/contracts/src/index.ts) | Allowed health, dish-command/result and initial diner-observation data shapes; rejects unexpected authority fields |
| [packages/contracts/src/index.test.ts](../packages/contracts/src/index.test.ts) | Checks valid and invalid contract examples |
| [packages/contracts/package.json](../packages/contracts/package.json) | Makes those definitions a shared workspace package |
| [packages/contracts/tsconfig.json](../packages/contracts/tsconfig.json) | TypeScript settings for shared definitions |
| [migrations/202610130001_foundation.sql](../migrations/202610130001_foundation.sql) | Creates the private schema, venues, event history, command receipts, outbox and initial row policies |
| [migrations/20261014210000_staff_commands.sql](../migrations/20261014210000_staff_commands.sql) | Adds staff memberships, current dish views, their policies and restricted runtime grants |

Applied migrations are history. Developers add a new forward migration to change an existing deployed database; they do not edit an old applied file or casually undo event history.

The six current tables have simple jobs: `venues` identifies restaurants; `staff_membership` connects people to permitted restaurant roles; `dish_current` holds the latest dish view; `es_event` holds business history; `es_command` remembers request results; `outbox` holds future delivery work.

### Repository checks and their regression tests

| File | Purpose |
| --- | --- |
| [scripts/check-bundle.mjs](../scripts/check-bundle.mjs) | Counts initially loaded diner JavaScript and rejects an oversized or unaccounted build; guards against loading the optional renderer immediately |
| [scripts/check-bundle.test.mjs](../scripts/check-bundle.test.mjs) | Checks shared chunks, lazy imports, missing imports and size failures |
| [scripts/check-docs.mjs](../scripts/check-docs.mjs) | Checks local Markdown links; does not fetch external pages or judge prose |
| [scripts/check-docs.test.mjs](../scripts/check-docs.test.mjs) | Checks good, broken and unsafe local links |
| [scripts/check-pr.mjs](../scripts/check-pr.mjs) | Requires a meaningful PR structure and stated verification results |
| [scripts/check-pr.test.mjs](../scripts/check-pr.test.mjs) | Rejects missing PR sections and unfinished template text |
| [scripts/context.mjs](../scripts/context.mjs) | Shows a module's context, validates references and refreshes source fingerprints |
| [scripts/context.test.mjs](../scripts/context.test.mjs) | Tests malformed graphs, stale sources and invalid paths |
| [scripts/test-db.mjs](../scripts/test-db.mjs) | Creates isolated Docker databases, applies migrations, runs SQL/Worker/local-flow checks and cleans up |
| [scripts/test-db.test.mjs](../scripts/test-db.test.mjs) | Checks failure reporting and whether SQL test counts/results are valid |
| [scripts/verify.mjs](../scripts/verify.mjs) | Runs the approved named checks and records sanitized failure observations |
| [scripts/verify.test.mjs](../scripts/verify.test.mjs) | Checks failure status, safe recording, directory creation and platform invocation |
| [tests/db/Dockerfile](../tests/db/Dockerfile) | Builds the PostgreSQL test image with pgTAP SQL-test support |
| [tests/db/foundation.sql](../tests/db/foundation.sql) | The 27 foundation database assertions |
| [tests/db/staff.sql](../tests/db/staff.sql) | The 16 staff-role and dish-policy assertions |
| [tests/e2e/foundation.spec.ts](../tests/e2e/foundation.spec.ts) | The four browser shell, accessibility/layout and API-health tests |

### GitHub collaboration and automation

| File | Purpose |
| --- | --- |
| [.github/CODEOWNERS](../.github/CODEOWNERS) | Names review owners; enforcement still depends on GitHub settings |
| [.github/PULL_REQUEST_TEMPLATE.md](../.github/PULL_REQUEST_TEMPLATE.md) | Prompts authors to explain outcome, contract changes, verification and deferred work |
| [.github/dependabot.yml](../.github/dependabot.yml) | Monthly grouped routine updates and separate security-update grouping |
| [.github/workflows/ci.yml](../.github/workflows/ci.yml) | The five purposeful CI jobs described above |
| [.github/workflows/deploy-staging.yml](../.github/workflows/deploy-staging.yml) | Manual main-branch Worker deployment using a staging environment and protected credentials |

### Agent files: who does which job

The `.claude` file is the Claude profile; the matching `.codex` file is the Codex profile. They describe the same responsibility in each client's format. These are instructions, not separately running employees or an automatic review service.

| Files | Responsibility |
| --- | --- |
| [.claude/agents/repo-guide.md](../.claude/agents/repo-guide.md), [.codex/agents/repo-guide.toml](../.codex/agents/repo-guide.toml) | Explain a code path, find relevant decisions and prepare a bounded task brief |
| [.claude/agents/task-builder.md](../.claude/agents/task-builder.md), [.codex/agents/task-builder.toml](../.codex/agents/task-builder.toml) | Implement an explicitly assigned slice, include its tests and hand off changes outside its ownership |
| [.claude/agents/architecture-reviewer.md](../.claude/agents/architecture-reviewer.md), [.codex/agents/architecture-reviewer.toml](../.codex/agents/architecture-reviewer.toml) | Check boundaries, restaurant authority and accepted architecture decisions |
| [.claude/agents/correctness-reviewer.md](../.claude/agents/correctness-reviewer.md), [.codex/agents/correctness-reviewer.toml](../.codex/agents/correctness-reviewer.toml) | Check reachable failures, retries and whether tests support the claims |
| [.claude/agents/review-coordinator.md](../.claude/agents/review-coordinator.md), [.codex/agents/review-coordinator.toml](../.codex/agents/review-coordinator.toml) | Keep reviewers on the same code version and reconcile their evidence |
| [.agents/skills/peekaplate-review/SKILL.md](../.agents/skills/peekaplate-review/SKILL.md) | Shared review method and structured result format used by those roles |

The profiles and selected prompt behaviors were evaluated. The builder initially exceeded its assigned scope in a plan, was corrected and passed a fresh retest. Native profile discovery and tool-permission enforcement in the separate Codex/Claude clients remain unverified. Agent instructions alone cannot enforce permissions or guarantee accuracy.

### Documentation and decisions

| File | Purpose |
| --- | --- |
| [docs/team_guide.md](team_guide.md) | This plain-language walkthrough and next-step guide |
| [docs/architecture.md](architecture.md) | System boundaries, data flows and what remains unimplemented |
| [docs/delivery.md](delivery.md) | Ordered feature slices, dependencies, responsibilities and acceptance gates |
| [docs/operations.md](operations.md) | Local commands, API use, cloud setup, release controls and recovery work |
| [docs/verification.md](verification.md) | Connects product/architecture requirements to existing and future test evidence |
| [docs/frontend-design.md](frontend-design.md) | Records the evolving design reference and what the real UI must eventually demonstrate |
| [docs/CONTEXT.md](CONTEXT.md) | Small JSON knowledge map: modules, source paths, dependencies, status, fingerprints and recent handoffs |
| [docs/research/README.md](research/README.md) | The 65-repository pattern survey, sources, adopted ideas and research limits |
| [docs/research/reviewer-evaluation.md](research/reviewer-evaluation.md) | What was actually tested about agent profiles, observed failures and remaining client limits |
| [docs/adr/README.md](adr/README.md) | Index of accepted architecture decisions |
| [docs/adr/0001-scope-and-repository.md](adr/0001-scope-and-repository.md) | Repository boundaries, current tools and when Python belongs |
| [docs/adr/0002-selective-event-sourcing.md](adr/0002-selective-event-sourcing.md) | Which business changes need history, atomic commands, safe retries and replay |
| [docs/adr/0003-intent-evidence.md](adr/0003-intent-evidence.md) | Future diner observations, acceptance receipts, archive ordering and recovery |
| [docs/adr/0004-visual-tiers.md](adr/0004-visual-tiers.md) | T0/T1/T2, truthful food capture, optional rendering and performance/accessibility budgets |
| [docs/adr/0005-tenancy-and-privacy.md](adr/0005-tenancy-and-privacy.md) | Identity, restaurant separation, restricted roles and data retention/deletion responsibilities |
| [docs/adr/0006-orders-and-measurement.md](adr/0006-orders-and-measurement.md) | POS linkage and what the evidence can reasonably tell the owner |
| [docs/adr/0007-delivery-and-recovery.md](adr/0007-delivery-and-recovery.md) | Environments, delivery safeguards, backups and recovery expectations |
| [docs/adr/0008-agent-context-and-review.md](adr/0008-agent-context-and-review.md) | Small source-linked memory, independent review roles and evidence requirements |

### Generated local files are different

`node_modules/` contains installed dependencies. `dist/` contains built output. `.wrangler/` contains local Worker tooling state. `work/local-session.json` holds a short-lived synthetic local session, and other `work/` files are temporary. Browser output goes into ignored report/test-result directories. These are not source files to hand-edit or commit.

Local `.env` and `.dev.vars` files may hold credentials and are ignored. A `.gitignore` rule is useful hygiene, not a guarantee that someone cannot accidentally publish a secret.
</details>

## Reference: the ClickUp task snapshot

Read on October 14, 2026: all 24 top-level tasks and seven sprint-scope subtasks. At the end of the review the [board](https://app.clickup.com/90141746115/v/b/t/90141746115) showed 12 To do, 4 In progress and 8 Complete top-level tasks. Statuses changed during the review, so use ClickUp for the current position. “Unassigned” means the assignee field was empty.

<details>
<summary>Open tasks, recorded assignments and what each contributes</summary>

| ClickUp task |Status | Assigned people | What it contributes |
| --- | --- | --- | --- |
| [Define Sprint Goals + candidate Sprint Backlog](https://app.clickup.com/t/90141746115/86bcex5hb) | In progress | Vivien Kong | Candidate small restaurant/dish workflow and boundaries; planning must select the actual sprint commitment |
| [Sprint 2 Planning](https://app.clickup.com/t/90141746115/86bchxfk2) | To do | Unassigned | Review evidence, carryover, dates, capacity and acceptance criteria |
| [Refine candidate Sprint 1 PBIs + engineering acceptance criteria](https://app.clickup.com/t/90141746115/86bcex5x3) | To do | Vivien Kong | Turn the product idea into one specified flow with inputs, outputs, failures and tests |
| [Run restaurant validation outreach + survey tracking](https://app.clickup.com/t/90141746115/86bcex5wq) | To do | Unassigned | Operator outreach and response tracking; the description asks for team participation |
| [Run lightweight diner + restaurant discovery](https://app.clickup.com/t/90141746115/86bcex99b) | To do | Vivien Kong, Shirley Rosario | Interview findings and assumptions that should change the backlog |
| [Define diner JTBD + behavior hypotheses](https://app.clickup.com/t/90141746115/86bcex5rr) | Complete | Adam H | Explain diners' needs and testable behavior hypotheses; observations are not proof of intent |
| [Map the end-to-end PeekaPlate product system](https://app.clickup.com/t/90141746115/86bcex5qb) | Complete | Vivien Kong | Map content, processing, review, diner experience and measurement; this is a system specification |
| [Create current-state + future-state diner journey map](https://app.clickup.com/t/90141746115/86bcex99f) | Complete | Rania, Amr Hussien | Separate researched behavior from proposed improvements |
| [Create end-to-end diner UX flow](https://app.clickup.com/t/90141746115/86bcex5t5) | Complete | Amr Hussien | Define browsing, dish details, exploration and fallback states |
| [Design clickable interactive menu MVP](https://app.clickup.com/t/90141746115/86bcex5te) | Complete | Amr Hussien | Prototype the core diner path for testing and engineering handoff |
| [Interactive Diner Experience](https://app.clickup.com/t/90141746115/86bcexf9r) | Complete | Rania, Adam H, Amr Hussien | Describe dish interactions; the repository's diner is still a shell |
| [Restaurant owner receives a lightweight summary / report](https://app.clickup.com/t/90141746115/86bcexfw4) | Complete | Amr Hussien, Rania | Specify report content and useful actions; no live report is implemented here |
| [Refine prototype layout + finalize brand palette](https://app.clickup.com/t/90141746115/86bchyk6t) | To do | Amr Hussien, Rania | Refine the existing structure and accessible palette with Vivien's review |
| [Recreate prototype in shared Figma + establish design system](https://app.clickup.com/t/90141746115/86bchyk6w) | To do | Rania, Amr Hussien | Prepare editable shared screens, reusable styles/components and a complete diner screen |
| [Map the complete diner and owner flows](https://app.clickup.com/t/90141746115/86bchyk71) | To do | Amr Hussien, Rania | Connect screens, review/approval, owner actions, failures and tracking points |
| [Design Agent MVP + human-review workflow](https://app.clickup.com/t/90141746115/86bcex9a1) | In progress | Eirene Woo, Shirley Rosario, Vivien Kong | Specify source-to-draft processing, confidence, correction and human review |
| [Specify multimodal dish-processing pipeline](https://app.clickup.com/t/90141746115/86bcex5tt) | In progress | Eirene Woo, Shirley Rosario, Vivien Kong | Define source fields, structured outputs, validation and fallback; not a running pipeline |
| [Define AI evaluation rubric + guardrails](https://app.clickup.com/t/90141746115/86bcex5vm) | To do | Unassigned | Define accuracy, severity, confidence and mandatory human-review rules |
| [Implement minimum human-review / approval path](https://app.clickup.com/t/90141746115/86bcexenj) | Complete | Sai Hemanth Kilaru | Board status requires reconciliation: the repo creates draft revisions, but does not implement approval or publication |
| [Implement 2D → 3D / spatial dish generation slice](https://app.clickup.com/t/90141746115/86bcexezr) | To do | Vivien Kong, Adam H | Investigate asset feasibility, quality and fallback; older generation wording needs alignment with the visual ADR |
| [Define diner behavior event taxonomy + measurement plan](https://app.clickup.com/t/90141746115/86bcex5w6) | In progress | Adam H | Define event names, fields and what can be measured versus inferred |
| [Behavioral events capture](https://app.clickup.com/t/90141746115/86bcexfnc) | To do | Eirene Woo, Vivien Kong | Specify event properties and funnels; the ingest/queue/archive path still needs implementation |
| [Agent analyzes event data and identifies basic patterns](https://app.clickup.com/t/90141746115/86bcexfrx) | To do | Eirene Woo, Vivien Kong, Shirley Rosario | Specify allowed signals, patterns and uncertainty; no analysis agent runs in this repo |
| [Create technical risk + QA readiness plan](https://app.clickup.com/t/90141746115/86bcex5wx) | To do | Vivien Kong, Shirley Rosario | Prioritize latency, cost, truthful output, device performance and event-reliability risks |

JTBD means “jobs to be done”: what a diner is trying to accomplish. PBI means “product backlog item”: a proposed piece of product work. Adam H and Amr Hussien are separate people; matching initials on board cards are not reliable identification.

The seven subtasks below refine the sprint goal. They are additional scope work, not seven extra implemented features.

| Scope subtask | Status | Assigned people | Decision needed |
| --- | --- | --- | --- |
| [Agent Workflow + Orchestration](https://app.clickup.com/t/90141746115/86bcexdce) | In progress | Eirene Woo, Shirley Rosario, Vivien Kong | Inputs, outputs, step sequence, states, handoffs and failures |
| [Users Review + Approval](https://app.clickup.com/t/90141746115/86bcexkyh) | To do | Unassigned | What needs review and the exact approval boundary before publication |
| [Spatial Generation](https://app.clickup.com/t/90141746115/86bcexkyy) | To do | Unassigned | Eligible representations, asset format, quality bar and fallback |
| [Diner Experience](https://app.clickup.com/t/90141746115/86bcexkzb) | To do | Unassigned | Minimum journey and loading/error/fallback states |
| [Behavioral Instrumentation](https://app.clickup.com/t/90141746115/86bcexkzx) | To do | Shirley Rosario, Eirene Woo, Vivien Kong | Minimum observations and fields, distinct from inferred intent |
| [Restaurant Intelligence](https://app.clickup.com/t/90141746115/86bcexm04) | To do | Eirene Woo, Vivien Kong | Allowed aggregated signals and interpretations without causal overclaims |
| [Owner Insight / Report](https://app.clickup.com/t/90141746115/86bcexm0h) | To do | Unassigned | Example report, supporting evidence, limitations and useful next actions |
</details>

## Reference: verification and remaining limits

<details>
<summary>Open the exact test evidence and CI explanation</summary>

PR #9 merged into `main` at `413be96`. Its final reviewed commit `fc08808` passed [PR CI run 38642140834](https://github.com/vivienk/peekaplate_staging/actions/runs/38642140834), and the merged commit passed [main CI run 38642528971](https://github.com/vivienk/peekaplate_staging/actions/runs/38642528971). The ClickUp/Discord additions to this guide are a subsequent documentation update, not additional runtime functionality.

| Evidence | What it establishes | What it does not establish |
| --- | --- | --- |
| 35 application, contract and local-tool tests | Tested parsing, token checks, HTTP behavior, replay rules and shutdown-error cleanup | Every possible input or hosted provider behavior |
| 21 repository-script tests | Tested bundle, documentation, PR, context, database-output and verification-runner safeguards, including pnpm launcher compatibility | That every written explanation is factually correct |
| 43 SQL assertions | Tested schema constraints, restricted-role behavior and row policies | Correct permissions for accounts not yet created at the provider |
| 13 real Worker/PostgreSQL cases | Signed local tokens, atomic writes, concurrency, retry conflicts, rollback, revocation and replay | Real Supabase login or Hyperdrive pooling |
| Local CLI smoke flow on Windows and Linux | Actual local setup, demo command and normal cleanup path | Hosted identity, database pooling or other contributors' machine setup |
| Four browser tests | Shell visibility, no-JavaScript diner content, accessibility scans, narrow layout and health behavior | A completed menu, login, order flow or real-phone viewer |
| Builds and bundle check | Apps build, Worker bundles, initial diner JavaScript stays within its configured budget | Real diner loading speed on a phone/network |
| Independent review | Architecture and correctness reviewers examined a fixed code version and rechecked fixes | Infallibility or automatic permission to deploy |

Review caught a mismatched SQL test count and a shutdown failure that skipped cleanup. Both were corrected. The cleanup test failed before its fix and passed afterward.

### Why there are five CI jobs

| Job | Specific purpose |
| --- | --- |
| `changes` | Decide whether changed paths need database and browser tests |
| `quality` | Check formatting/imports, types, unit/script tests, builds, context, document links and the PR explanation |
| `database` | Test migrations, SQL policies, real Worker/database behavior and the local demo |
| `browser` | Exercise the existing browser shells and their accessibility/layout checks |
| `ci` | Give one final result that fails if a required job failed |

The database and browser jobs run when relevant files change. The current Biome setup enforces formatting/import organization; it is not a broad security or correctness ruleset. Types, tests and review serve different purposes.

Routine dependency updates are monthly and grouped, with at most one open version-update PR per ecosystem. Security updates can arrive sooner. No automatic dependency merge is configured. A past full passing run took about 72 seconds of runner time, excluding the GitHub queue; that is a measurement, not a timing guarantee.
</details>

The repository survey covered 65 public projects' metadata and folder patterns. It was not 65 complete code or security audits. The [research notes](research/README.md) explain what was adopted and why.

The October 18 hosted checks verified real Supabase sign-in, effective database permissions, staff writes, retries/concurrency, cross-restaurant denial, membership removal and rollback. A remote probe checked that connection context clears after a transaction, but it did not prove reuse of the same physical pooled connection. The observed request timings are small smoke samples, not a load or p95 result. The completed PR #10 security diff review found no supported issues within that change; it is not a whole-product guarantee. GitHub review controls remain manual under the selected private Free plan.

Signing out and removing restaurant access are different. Signing out prevents refreshing that session, but its existing access token can remain valid until it expires. Removing restaurant membership immediately blocked the next tested command. We need an explicit session-lifetime decision before real staff use; the current tests must not be described as instant logout revocation.

The board review covered descriptions, assignments and scope subtasks. The Discord review covered recent visible messages in general, design, daily-updates, product and dev; the last two contained no messages at the time. It did not audit every attachment, linked PRD, interview record or full chat history. Private conversation text and personal details are not reproduced. Workspace links may require access.

## What needs to happen next: order and parallel work

This sequence follows the [PeekaPlate Orchestration + V1 Team Plan](https://claude.ai/artifact/HxpC9aET7geEwkEpyG6wrt), rechecked October 14, and its engineering breakdown in [delivery.md](delivery.md). The artifact allows overlapping work; the delivery steps describe when complete flows can be integrated and accepted. The step numbers below are delivery-plan numbers, not GitHub PR numbers. GitHub PR #9 delivered the local part of step 1.

### Start these in parallel now

The [Team Interests & Responsibilities document](https://app.clickup.com/90141746115/v/dc/2kydvry3-94/2kydvry3-434), read October 14, helps choose who might take each piece. It records preferences and experience; every agreed-responsibility field is still empty. The suggestions below need each person's agreement and a selected ClickUp task. Existing board assignments and the recorded sprint handoffs remain separate evidence of assigned work.

| Work | Suggested contribution, based on interests | Start with this small piece | Hand it over when |
| --- | --- | --- | --- |
| Staff sign-in and editing | Developers take a bounded implementation task; Sai and Vivien review the PR | Reuse the verified staging API and Supabase identity setup; connect the console to authorized draft saving | A permitted user signs in and saves; denied access, expired login, retries and edit conflicts have working screen states and tests. |
| Diner journey and event meaning | Adam, whose interest is the diner experience, continues the assigned event-taxonomy work | Walk through menu entry, dish details and return/exit. State which action produces each event and what it does—and does not—tell us. | Event examples are agreed with the person implementing collection, and tracking points are ready for the screen annotations. This does not assign frontend coding to Adam. |
| Design handoff | Amr could develop the visual-menu screens and research questions; Rania could take a bounded flow/component task using her UX and design-system experience | Proposed split: Amr works from the current prototype on the next agreed diner screen; Rania specifies its reusable styles, transitions and loading/error/fallback states. Confirm the split first so both are not redrawing the same screen. | The shared designs explain behavior as well as appearance, and the person implementing the UI can identify each required state. |
| Event collection in code | Eirene can contribute to backend/event capture and could pair with Sai on the existing code and restaurant-security rules if both agree | After agreeing Adam's definitions and the request format, select one local component and its tests—for example validating an incoming event batch. Then tackle retry storage, queue delivery and archive processing as separate complete tasks. | The selected component passes its tests and has a clear connection to the next component. Real exposure still waits for approved publication and the diner flow. |
| Dish preparation and AI review | Eirene can contribute evaluation criteria; Amr can contribute visual-quality examples; Shirley can turn the agreed criteria into acceptance checks | Prepare an authorized sample dish, accurate source text/photo and examples of acceptable, uncertain and rejected output. Start with manual structured entry. | The capture/review implementation has concrete examples and failure rules. A processing model or public asset is not approved merely because the rubric exists. |
| Restaurant and order-data feasibility | Vivien continues the recorded venue coordination; a developer still needs to take the export/code feasibility check | Confirm participation, photo rights and whether a code survives a permitted test ticket/export; prepare explicit sample-data mapping | Steps 2 and 4 have usable source material and verified export requirements. This is not yet a working POS integration. |
| Requirements, testing and feedback | Shirley, matching her QA experience and interests in technical review, requirements and product feedback | Review the selected task's requirements before coding, write concrete failure examples, then test the delivered behavior and record gaps | The next PR has observable acceptance checks and independent feedback. Recovery can be planned now, but the integrated drill must run later. |

Choose **one primary task per person first**; the table offers contributions, not seven simultaneous commitments for everyone. The document lists Eirene at 20–25 hours/week, Adam at 15–20, Rania at 1–2 hours/day, Amr at 30 hours/week with flexibility, and Shirley as “Flexible/ work full time.” Reconfirm available time for this sprint: clarify Shirley's weekly hours and Rania's available days rather than assuming a full-time commitment or a seven-day week. Keep Rania's first handoff small enough to complete and review.

Vivien's interests row is blank, and Sai has no row in this document. Their setup/coordination work above comes from the existing handoffs, not invented preferences or availability. Agree overlap times directly rather than assuming fixed time-zone offsets from the document.

For later steps, **Eirene and Amr's interest in owner insights and AI evaluation fits step 6**: they can help shape example reports and evaluation questions while the data path is built. Adam can check whether the interpretations answer the diner questions; Shirley can check the acceptance cases. Real conclusions still wait for validated observations and order linkage. Rania and Amr can help specify and review the T1/T2 experience in step 5, but their design interests do not establish an assigned Three.js implementation or capture-engineering owner.

Before committing dates, name who will implement the diner/staff screens, capture pipeline, optional viewer, POS adapter and operational recovery. Interest in technical work is a starting point for a small paired task, not evidence that all those engineering gaps are staffed. Rania's recorded AR learning goal and other future experiments do not add them to the first launch.

Keep each implementation assignment bounded and avoid two people changing the same files without coordination. Local work can continue without cloud keys. The shared staging setup now exists; reuse its resources and use approved synthetic fixtures for tests. Shared credentials stay with authorized operators. Keep production separate and require release approval. Never place credentials in the guide, Git or chat.

### Build and accept the connected flows in this order

| Step | Outcome to deliver | Must exist first | Work that can overlap / proof needed |
| --- | --- | --- | --- |
| **0 — Repository foundation** | Shared code structure, checks, docs and agent instructions | None | Local foundation and shared staging are available. Production is not configured. |
| **1 — Safe staff changes** | A permitted staff member can save a dish revision without cross-restaurant access, duplicate changes or silent overwrites | Step 0 | Backend slice passed bounded hosted checks. Build the staff sign-in/editing UI and continue step 2; session-lifetime, load and recovery decisions remain before a real pilot. |
| **2 — Capture, review and publication** | Staff review the exact source/asset revision; only approved content becomes a published photo/text menu; withdrawn content becomes unavailable | Step 1's command/permission rules | Content preparation and staff UI can progress together against agreed data rules. Prove unauthorized approval fails, competing publications cannot both win, and rebuilding history sends no uploads or notifications. |
| **3 — Real T0 menu and durable observations** | Diners browse approved content; the system records what they actually saw and safely accepts observations | Step 2 for real published content and version references | Diner layout and event plumbing can be developed earlier with fixtures. Accept the combined flow only after testing offline/reload/reconnect, partial receipts, duplicates, queue failure, archive-before-index ordering, failed-message recovery and deletion/retention. The menu must work without tracking or WebGL. |
| **4 — Link sessions to order tickets** | A short-lived restaurant-specific code connects a browsing session to a permitted order record; repeated imports do not duplicate it | Step 3 for a real session and exposure trail; a verified usable export | Can run alongside step 5. Test wrong-restaurant codes, expiry, duplicate tickets, refunds/voids and time zones. Unlinked sessions remain unknown. |
| **5 — T1, then selected T2** | Optional, truthful richer views of approved dishes | Step 2's approved content/assets; step 3 to record actual visual exposure | Build alongside step 4. T1 comes first; add T2 only for dishes with the required real plating captures. Prove phone performance, size limits, keyboard/reduced-motion support and photo fallback. Failed optional visuals are switched off, not allowed to block the ordinary menu. |
| **6 — Owner readout and one experiment** | An owner can understand the evidence and choose one action; any experiment has its comparison plan fixed before results | Step 4's validated linkage and underlying step-3 observations | Report layout and synthetic calculations can start earlier. Real readout acceptance needs reconciled data, linkage coverage, visible unknowns and small-group privacy protection. Do not claim browsing caused a sale. |
| **7 — Pilot release and recovery** | A named venue can use the full loop and recover from failures | Required outcomes from steps 3–6, with failed optional visuals disabled | Plan recovery throughout; complete the integrated outage/restore/replay and device/accessibility drills before release. Confirm permission, retention, backups, monitoring and who responds to failures. |

The practical dependency is:

```text
Safe staff changes → approved, published content → real menu + reliable observations
                               │                              │
                               └→ T1 → selected T2            └→ order linkage → owner readout
                                   (record exposure through the real menu)

Required flows + recovery/device/venue checks → pilot release
```

**Do not wait for 3D to build the ordinary menu or evidence path.** Equally, do not treat a mocked screen or isolated event collector as the finished integrated flow. Capture preparation, design, venue work and test planning are parallel activities; publishing, actual exposure and order-linked conclusions have real dependencies.

### The checkpoints before a pilot

The artifact's original targets were G1 October 19, G2 October 24, G3 October 28, G4 October 29 and readout November 1, 2026. It planned capture for October 20–22 with October 23 as a recapture buffer. These are source-plan targets, not a refreshed team commitment. Reconcile them with available people, venue readiness and the remaining cloud work before relying on them.

- **G1 — Content can be trusted:** capture/truthfulness rules agreed and approved ordinary menu content available. No invented edible surfaces.
- **G2 — The useful flow works:** demonstrate menu-to-ticket linkage and measure the selected visuals on actual phones. Remove optional visuals that fail.
- **G3 — Failures can be recovered:** demonstrate interruption handling, duplicate handling, restoration and safe history replay. Broken restaurant isolation, approval, withdrawal or linkage blocks the pilot.
- **G4 — The venue can operate it:** confirm the operator, permissions, privacy wording, retention and a usable runbook, including who can stop the pilot.
- **Readout — Explain what happened honestly:** show the sample, linkage coverage, limitations and a useful owner action. Do not promise causal sales growth or no company loss.

The artifact's $375 figure is a staged pilot cash target, not a current vendor quote or total company cost; labor and other costs are separate. Confirm costs before spending. Python processing and GPU services are added for a demonstrated job, not as a prerequisite for manual content preparation. Full 3D/AR, glasses, SMS/CRM and additional POS integrations remain outside the first launch path.

### Next step: select implementation tickets

Yes: turn the remaining work into small, reviewable tickets now. Use the [next-ticket sequence](delivery.md#next-tickets-from-the-deployed-foundation) for scope, dependencies and merge order. Keep tickets unassigned until availability is confirmed; Mohammad and Marwan are additional developers, not assumed task owners. Product/design contributors supply decisions and acceptance examples rather than being assigned code by default. Sai and Vivien are the requested code reviewers.

Begin with **three representative dishes**, then expand the approved photo/text menu toward roughly 20 after the end-to-end flow works. Richer assets stay manual and optional. Synthetic design fixtures must be labelled; they are not approved restaurant records.

Use weekly Tuesday-to-Tuesday sprint headings within the requested 15–20-day delivery window. Reconfirm capacity and dates before committing. Each ticket needs a plain title, research/design/implementation label, estimated effort, required roles, source links, acceptance examples and its prerequisite PR. Include review and integration time in the estimate.

The first integrated demo should show permitted staff saving, reviewing and publishing a dish, and a diner seeing that approved version. Layout, manual content preparation and event-definition review can proceed alongside backend work. Accept tracking and reports only after their real data paths and calculations are tested; a collector alone is not a finished dashboard.
