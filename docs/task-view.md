# Task overlay view

`POST /api/v1/tasks/:id/view-ticket` with the person's own `Authorization: Bearer …` returns `{ url, expires_at }`. Only the task's requester can mint it; another person's task is 404. Sessions and delegated/service credentials cannot mint tickets. The URL opens `/embed/task/:id?t=tvt_…` without cookies.

A ticket is 32 random bytes encoded as base64url, stored only as SHA-256, bound to the task and requester, and reusable for 15 minutes. It authorizes only the embed, its `/events` stream and `/still` image. Wrong-task, missing and expired tickets return 403; the page shows “This view has expired”. An open stream closes at expiry. No normal API route accepts these tickets. Account/task deletion cascades to the ticket rows; minting removes expired rows.

The embed renders the title, state, task events and a polled computer image (Run sessions or older Bot desks). “Open in Actor” navigates the top frame to the task's page. It has no controls, approval forms, session probes or site chrome. Event text uses textContent, never HTML. Credentials are read from the URL by the external script, never embedded in returned HTML or navigation links. All embed responses are no-store and no-referrer.

Only `/embed/task/*` relaxes frame ancestors. Network's `/api/frame?host=openvibe.actor` supplies the first-party hosts, cached for ten minutes; `server/task-view/frame-origins.json` is the checked-in fallback derived from Contracts' site manifests. Other pages keep `frame-ancestors 'none'` and X-Frame-Options DENY.

Deployment must install `deploy/nginx/openvibe.actor.conf` along with the app: access logs omit query strings and referrers, embed error logging is suppressed, and streaming responses are unbuffered. Do not log the returned URL in a caller or edge proxy. Application warnings identify only the task id.

The companion Contracts PR adds `actor.task-view-ticket@1` and the person-only `actor.task.view_ticket` operation. Until its release is pinned, `server/task-view/openapi.json` adds the same operation/schema to Actor's served OpenAPI document. No Contracts release or deployment is part of this PR.
